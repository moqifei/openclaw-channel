import { CbEvents, getSDK, LogLevel, type CallbackEvent, type MessageItem } from "@openim/client-sdk";
import { processInboundMessage, type InboundMessageSource } from "./inbound";
import { resolveAccountToken } from "./token";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";
import { formatSdkError } from "./utils";
import {
  LIVENESS_CHECK_INTERVAL_MS,
  clearStdoutBroken,
  resolveLivenessTimeoutMs,
  resolveSendLivenessTimeoutMs,
  scheduleStdoutBrokenExit,
  shouldForceReconnect,
} from "./liveness";
import { registerSendFailureHandler } from "./media";

const clients = new Map<string, OpenIMClientState>();
const MESSAGE_ACCEPT_GRACE_MS = 5 * 60_000;
const MESSAGE_REPLAY_FILTER_WINDOW_MS = 2 * 60_000;
/**
 * 冷启动历史同步丢弃窗口：每次 login 成功（首次或重连重登）后立即进入该窗口。
 * 窗口内所有 offline 来源的历史消息一律静默丢弃、不 markAsRead、不 dispatch，
 * 避免 SDK 冷启动自动拉取的历史会话同步（seq 从 2 涨到 N 的那一段）触发补齐循环
 * 或占用磁盘。orange 重启场景不需要这些历史，丢了就丢了。
 */
const COLD_START_HISTORY_WINDOW_MS = 30_000;

/**
 * 发送失败自愈钩子（借鉴 orange wechat channel 的传输层重试 + 主动重建思路）：
 * media.ts 在 sendMessage 重试耗尽后回调此钩子。
 *
 * 注意：发送失败不代表与 orange 的 stdio 管道断裂，因此这里【只触发 IM 重连】，
 * 绝不能 markStdoutBroken 导致进程自杀。否则在 open-im-server 重启、SDK 处于半死
 * 状态时，任何一条消息（含数字分身兜底回复）的发送失败都会反复触发子进程退出，
 * 进而引发 supervisor 无限 respawn，波及其他正常用户。
 *
 * 真正的 stdio 断裂由 channel.ts 的 isPipeBrokenError 判定并触发退出重建。
 */
registerSendFailureHandler((accountId: string) => {
  const state = clients.get(accountId);
  if (!state) return;
  // 仅重建 IM SDK 连接，不触碰 stdoutBroken（避免误杀进程）。
  scheduleReconnect(undefined as any, state, "send failure after retries");
});

function markMessageAcceptWindow(state: OpenIMClientState): void {
  const now = Date.now();
  state.messageAcceptAfterMs = now - MESSAGE_ACCEPT_GRACE_MS;
  state.replayFilterUntilMs = now + MESSAGE_REPLAY_FILTER_WINDOW_MS;
}

/** login 成功后进入冷启动历史丢弃窗口：窗口内 offline 历史消息静默丢弃。 */
function markColdStartHistoryWindow(state: OpenIMClientState): void {
  state.coldStartHistoryUntilMs = Date.now() + COLD_START_HISTORY_WINDOW_MS;
}

function detachHandlers(state: OpenIMClientState): void {
  if (!state.handlersAttached) return;
  state.sdk.off(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  state.sdk.off(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  if (state.handlers.onRecvOfflineNewMessage) state.sdk.off(CbEvents.OnRecvOfflineNewMessage, state.handlers.onRecvOfflineNewMessage);
  state.sdk.off(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
  if (state.handlers.onConversationChanged) state.sdk.off(CbEvents.OnConversationChanged, state.handlers.onConversationChanged);
  if (state.handlers.onTotalUnreadMessageCountChanged) state.sdk.off(CbEvents.OnTotalUnreadMessageCountChanged, state.handlers.onTotalUnreadMessageCountChanged);
  if (state.handlers.onUserTokenExpired) state.sdk.off(CbEvents.OnUserTokenExpired, state.handlers.onUserTokenExpired);
  if (state.handlers.onUserTokenInvalid) state.sdk.off(CbEvents.OnUserTokenInvalid, state.handlers.onUserTokenInvalid);
  if (state.handlers.onKickedOffline) state.sdk.off(CbEvents.OnKickedOffline, state.handlers.onKickedOffline);
  if (state.handlers.onConnectFailed) state.sdk.off(CbEvents.OnConnectFailed, state.handlers.onConnectFailed);
  if (state.handlers.onConnectSuccess) state.sdk.off(CbEvents.OnConnectSuccess, state.handlers.onConnectSuccess);
  state.handlersAttached = false;
}

function scheduleReconnect(api: any, state: OpenIMClientState, reason: string): void {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped) return;
  if (reconnect.timer || reconnect.running) return;

  // 兼容 sender-failure 自愈钩子调用（无 api 句柄时降级用 state.logger）。
  const log = api?.logger ?? (state as any).logger;
  const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(reconnect.attempts, 5));
  reconnect.attempts += 1;
  log?.warn?.(`[openim] account ${state.config.accountId} reconnect scheduled in ${delayMs}ms: ${reason}`);

  reconnect.timer = setTimeout(() => {
    reconnect.timer = undefined;
    reconnectAccount(api, state, reason).catch((e: any) => {
      log?.error?.(`[openim] account ${state.config.accountId} reconnect failed: ${formatSdkError(e)}`);
      scheduleReconnect(api, state, "reconnect failed");
    });
  }, delayMs);
}

/**
 * 启动连接健康检测。
 * 正常的消息空闲只记录健康快照；只有明确断连、发送侧失败或 stdio 断裂才触发重连。
 */
function startLivenessMonitor(api: any, state: OpenIMClientState): void {
  stopLivenessMonitor(state);
  const recvTimeoutMs = resolveLivenessTimeoutMs(state.config);
  const sendTimeoutMs = resolveSendLivenessTimeoutMs(state.config);
  state.livenessTimer = setInterval(() => {
    const now = Date.now();
    const recvIdleMs = now - state.lastMessageSeenMs;
    const sendIdleMs = typeof state.lastFlushMs === "number" ? now - state.lastFlushMs : -1;
    // 周期性健康快照：仅用于观测，不再因"无消息空闲"触发重连。
    api.logger?.debug?.(
      `[openim][health] account ${state.config.accountId} ` +
        `recvIdleMs=${recvIdleMs} sendIdleMs=${sendIdleMs} stdoutBroken=${!!state.stdoutBroken} ` +
        `connectionLost=${typeof state.connectionLostAtMs === "number" ? `${Math.round((now - state.connectionLostAtMs) / 1000)}s ago` : "false"} ` +
        `reconnectRunning=${state.reconnect?.running ?? false} ` +
        `thresholds{recv=${recvTimeoutMs} send=${sendTimeoutMs}}`
    );

    if (shouldForceReconnect(state, now, recvTimeoutMs, sendTimeoutMs)) {
      const reason = describeLivenessReason(state, now, recvTimeoutMs, sendTimeoutMs);
      api.logger?.warn?.(`[openim] account ${state.config.accountId} ${reason}, forcing reconnect`);

      if (state.stdoutBroken) {
        // 管道已断裂：仅靠 IM SDK 重连无法恢复与 orange 的 stdio 通道，
        // 主动退出由 orange 重新拉起本插件，重建 stdin/stdout 控制通道。
        api.logger?.error?.(
          `[openim] account ${state.config.accountId} stdio pipe to orange broken, exiting to force respawn`
        );
        scheduleStdoutBrokenExit(state);
      } else {
        scheduleReconnect(api, state, "stale connection");
      }
    }
  }, LIVENESS_CHECK_INTERVAL_MS);
  // 不阻止进程退出：存活检测定时器不应保持事件循环常驻。
  if (typeof state.livenessTimer.unref === "function") state.livenessTimer.unref();
}

/** 生成存活检测的触发原因描述，便于日志区分收侧/发侧/管道断裂。 */
function describeLivenessReason(
  state: OpenIMClientState,
  now: number,
  recvTimeoutMs: number,
  sendTimeoutMs?: number
): string {
  if (state.stdoutBroken) {
    return `stdio pipe to orange broken (detected at ${state.lastStdoutErrorMs})`;
  }
  if (typeof state.connectionLostAtMs === "number") {
    return `connection lost ${Math.round((now - state.connectionLostAtMs) / 1000)}s ago (>= ${Math.round((recvTimeoutMs * 2) / 1000)}s grace), SDK did not self-recover`;
  }
  if (typeof sendTimeoutMs === "number" && typeof state.lastFlushMs === "number") {
    const sendIdleMs = now - state.lastFlushMs;
    if (sendIdleMs >= sendTimeoutMs) {
      return `no successful flush to orange for ${Math.round(sendIdleMs / 1000)}s >= ${Math.round(sendTimeoutMs / 1000)}s`;
    }
  }
  return "stale connection";
}

function stopLivenessMonitor(state: OpenIMClientState): void {
  if (state.livenessTimer) {
    clearInterval(state.livenessTimer);
    state.livenessTimer = undefined;
  }
}

/**
 * 重新挂载 SDK 消息/状态监听器。open-im-server 重启后，即使连接恢复，
 * 旧的会话订阅可能失效；重新调用 sdk.on 可确保监听器绑定到新的会话上下文上。
 * SDK 的 on() 实际会追加监听器，因此必须用 handlersAttached 保证幂等。
 */
function attachHandlers(sdk: any, state: OpenIMClientState): void {
  if (state.handlersAttached) return;
  sdk.on(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  sdk.on(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  if (state.handlers.onRecvOfflineNewMessage) sdk.on(CbEvents.OnRecvOfflineNewMessage, state.handlers.onRecvOfflineNewMessage);
  sdk.on(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
  if (state.handlers.onConversationChanged) sdk.on(CbEvents.OnConversationChanged, state.handlers.onConversationChanged);
  if (state.handlers.onTotalUnreadMessageCountChanged) sdk.on(CbEvents.OnTotalUnreadMessageCountChanged, state.handlers.onTotalUnreadMessageCountChanged);
  sdk.on(CbEvents.OnUserTokenExpired, state.handlers.onUserTokenExpired);
  sdk.on(CbEvents.OnUserTokenInvalid, state.handlers.onUserTokenInvalid);
  sdk.on(CbEvents.OnKickedOffline, state.handlers.onKickedOffline);
  sdk.on(CbEvents.OnConnectFailed, state.handlers.onConnectFailed);
  sdk.on(CbEvents.OnConnectSuccess, state.handlers.onConnectSuccess);
  state.handlersAttached = true;
}

/**
 * 仅重建 WS 长连接，不重新 login。
 * 方案 3：当 SDK 仍处于 Logged 状态时，连接断开只需重建 WS 即可复用既有会话
 * （token / 在线状态 / 消息订阅都还在），无需再次 login —— 再次 login 会触发
 * server 端 login repeat(10102) 风暴，并反复触发 server 内部 MultiTerminalLoginCheck
 * 的 PlatformID 软失败。forceReconnect() 只重建底层 WS，避开整条 login 链路。
 */
async function reconnectWsOnly(api: any, state: OpenIMClientState): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped) return;
  const log = api?.logger ?? (state as any).logger;
  log?.warn?.(`[openim] account ${state.config.accountId} WS-only reconnect (no login, reuse existing session)`);
  await state.sdk.forceReconnect();
  reconnect.attempts = 0;
  state.connectionLostAtMs = undefined;
  clearStdoutBroken(state);
  log?.info?.(`[openim] account ${state.config.accountId} WS-only reconnect issued`);
}

/**
 * Replace the SDK instance when its internal message task/request map is
 * poisoned. @openim/client-sdk's cancelMessageTasks() only cancels queued
 * tasks; an in-flight sendReqWaitResp can remain pending forever. Reusing that
 * SDK would therefore keep every later send behind the same zombie task.
 */
async function replaceSdkAndLogin(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped) return;
  const log = api?.logger ?? (state as any).logger;
  const previousSdk = state.sdk;
  log?.warn?.(`[openim] account ${state.config.accountId} replacing SDK instance: ${reason}`);

  detachHandlers(state);
  try {
    // logout() performs a local SDK reset/WS close. Do not let a broken
    // transport prevent creation of the replacement instance.
    await Promise.race([
      Promise.resolve(previousSdk.logout()),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  } catch {
    // Ignore failures from the poisoned SDK instance.
  }

  const sdk = getSDK();
  state.sdk = sdk;
  const token = await resolveAccountToken(state.config, { forceRefresh: true });
  state.config = { ...state.config, token };
  markMessageAcceptWindow(state);
  markColdStartHistoryWindow(state);
  attachHandlers(sdk, state);
  try {
    await sdk.login({
      userID: state.config.userID,
      token,
      wsAddr: state.config.wsAddr,
      apiAddr: state.config.apiAddr,
      platformID: state.config.platformID,
      logLevel: state.config.sdkLogLevel ?? LogLevel.Warn,
    });
  } catch (e) {
    detachHandlers(state);
    throw e;
  }
  reconnect.attempts = 0;
  state.connectionLostAtMs = undefined;
  clearStdoutBroken(state);
  log?.info?.(`[openim] account ${state.config.accountId} reconnected with a fresh SDK instance`);
}

/**
 * 完整 login 重连：logout（容忍失败）+ 重新 login + 重挂监听器。
 * 仅当 SDK 已不在 Logged 状态（token 失效 / 被踢 / 会话完全丢失）时使用。
 */
async function fullLoginReconnect(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped) return;

  const log = api?.logger ?? (state as any).logger;
  log?.warn?.(`[openim] account ${state.config.accountId} full login reconnect: ${reason}`);
  await replaceSdkAndLogin(api, state, reason);
}

/**
 * 智能重连入口：先判断 SDK 登录状态，已登录则只重建 WS，否则完整 login。
 * 这是方案 3 的核心 —— 绝大多数"连接闪断"场景下 SDK 仍是 Logged 状态，
 * 只重建 WS 即可，彻底规避 10102 风暴。
 */
async function smartReconnect(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const log = api?.logger ?? (state as any).logger;
  // A send timeout means the SDK's in-flight task queue may be poisoned. A
  // forceReconnect on the same instance cannot release that active task, so
  // replace the SDK object instead of attempting WS-only recovery.
  if (/send failure|stream final|send timeout|mark read/i.test(reason)) {
    await fullLoginReconnect(api, state, reason);
    return;
  }
  let logged = false;
  try {
    const status = await state.sdk.getLoginStatus();
    // LoginStatus enum: Logout=1, Logging=2, Logged=3
    logged = ((status as any)?.data ?? status) === 3;
  } catch {
    // getLoginStatus 不可用时保守走完整 login。
  }
  log?.info?.(`[openim] account ${state.config.accountId} smartReconnect status=${logged ? "Logged" : "not-Logged"}: ${reason}`);
  if (logged) {
    try {
      await reconnectWsOnly(api, state);
    } catch (e: any) {
      log?.warn?.(`[openim] account ${state.config.accountId} WS-only reconnect failed; falling back to full login: ${formatSdkError(e)}`);
      await fullLoginReconnect(api, state, "ws-only reconnect failed");
    }
  } else {
    await fullLoginReconnect(api, state, reason);
  }
}

/**
 * 应用层重连入口（被 scheduleReconnect / liveness 调用）。
 * 方案 3：先检查 SDK 登录状态 —— 已 Logged 则只重建 WS（forceReconnect），
 * 否则完整 login 重连。彻底规避反复 login 引发的 10102 风暴。
 */
async function reconnectAccount(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped || reconnect.running) return;
  reconnect.running = true;
  try {
    await smartReconnect(api, state, reason);
  } finally {
    reconnect.running = false;
  }
}

function handleConnectSuccess(api: any, state: OpenIMClientState): void {
  const reconnect = state.reconnect;
  const recoveredFromLoss = typeof state.connectionLostAtMs === "number";
  if (reconnect?.timer) {
    clearTimeout(reconnect.timer);
    reconnect.timer = undefined;
  }
  if (reconnect) reconnect.attempts = 0;
  state.lastMessageSeenMs = Date.now();
  state.connectionLostAtMs = undefined;
  clearStdoutBroken(state);
  api.logger?.info?.(
    `[openim] account ${state.config.accountId} connection healthy${recoveredFromLoss ? " (SDK self-recovered; pending reconnect cancelled)" : ""}`
  );
}

export function getConnectedClient(accountId?: string): OpenIMClientState | null {
  let selected: OpenIMClientState | null = null;
  let selectedKey: string | null = null;
  if (accountId && clients.has(accountId)) {
    selected = clients.get(accountId) ?? null;
    selectedKey = accountId;
  } else if (clients.has("default")) {
    selected = clients.get("default") ?? null;
    selectedKey = "default";
  } else {
    const first = clients.values().next();
    if (!first.done) { selected = first.value; selectedKey = "first"; }
  }

  const logger = (selected as any)?.logger;
  const known = Array.from(clients.keys()).join(",") || "<none>";
  if (!selected) {
    logger?.warn?.(`[openim][state] getConnectedClient MISSING: requestedAccount=${accountId ?? "<none>"} knownAccounts=${known}`);
    return null;
  }
  const now = Date.now();
  const recvIdleMs = selected.lastMessageSeenMs ? now - selected.lastMessageSeenMs : -1;
  // OpenIMClientState 无显式 connected 字段：用 lastMessageSeenMs 新鲜度 + stdoutBroken 推断状态。
  const seeminglyHealthy = !selected.stdoutBroken && recvIdleMs >= 0 && recvIdleMs < 600_000;
  logger?.debug?.(
    `[openim][state] getConnectedClient: requestedAccount=${accountId ?? "<none>"} selectedKey=${selectedKey} ` +
      `userID=${selected.config.userID} recvIdleMs=${recvIdleMs} stdoutBroken=${!!selected.stdoutBroken} ` +
      `reconnectRunning=${selected.reconnect?.running ?? false} seeminglyHealthy=${seeminglyHealthy} knownAccounts=${known}`
  );
  if (selected.stdoutBroken) {
    logger?.warn?.(`[openim][state] getConnectedClient: selected account ${selected.config.accountId} has stdoutBroken=true — replies will fail`);
  }
  return selected;
}

export function connectedClientCount(): number {
  return clients.size;
}

/** 仅供单元测试注入客户端状态，便于验证 outbound 写回时的存活标记逻辑。 */
export function __setTestClient(accountId: string, state: OpenIMClientState): void {
  clients.set(accountId, state);
}

/** 仅供单元测试：清空所有已注册客户端。 */
export function __clearTestClients(): void {
  for (const state of clients.values()) {
    if (state.reconnect?.timer) clearTimeout(state.reconnect.timer);
    if (state.livenessTimer) clearInterval(state.livenessTimer);
  }
  clients.clear();
}

export async function startAccountClient(api: any, config: OpenIMAccountConfig): Promise<void> {
  // OpenClaw's channel account context exposes `log`, while the plugin API
  // exposes `logger`.  The shim passes the former to gateway.startAccount;
  // normalize it here so all inbound/read diagnostics use the same
  // `[bridge:openim] ...` log.write path instead of being silently skipped.
  if (!api?.logger && api?.log) {
    api.logger = api.log;
  }
  api.logger?.info?.(`[openim][startup] logger adapter ready account=${config.accountId} source=${api?.logger === api?.log ? "channel.log" : "api.logger"}`);

  const sdk = getSDK();
  let state: OpenIMClientState | null = null;
  try {
    const token = await resolveAccountToken(config);
    const resolvedConfig = { ...config, token };

    state = {
      sdk,
      config: resolvedConfig,
      messageAcceptAfterMs: Date.now() - MESSAGE_ACCEPT_GRACE_MS,
      replayFilterUntilMs: Date.now() + MESSAGE_REPLAY_FILTER_WINDOW_MS,
      coldStartHistoryUntilMs: Date.now() + COLD_START_HISTORY_WINDOW_MS,
      lastMessageSeenMs: Date.now(),
      handlersAttached: false,
      handlers: {
        onRecvNewMessage: () => undefined,
        onRecvNewMessages: () => undefined,
        onRecvOfflineNewMessage: () => undefined,
        onRecvOfflineNewMessages: () => undefined,
        onConversationChanged: () => undefined,
        onTotalUnreadMessageCountChanged: () => undefined,
      },
      reconnect: {
        attempts: 0,
        running: false,
        stopped: false,
      },
    } as OpenIMClientState;
    state.requestReconnect = (reason: string) => reconnectAccount(api, state as OpenIMClientState, reason);

    const consumeMessage = (msg: MessageItem, source: InboundMessageSource) => {
      (state as OpenIMClientState).lastMessageSeenMs = Date.now();
      api.logger?.info?.(
        `[openim][recv] account=${config.accountId} source=${source} ` +
          `msgID=${msg.clientMsgID || msg.serverMsgID || "<none>"} ` +
          `serverMsgID=${msg.serverMsgID || "<none>"} ` +
          `sendID=${msg.sendID || "<none>"} recvID=${msg.recvID || "<none>"} ` +
          `seq=${msg.seq ?? "<none>"} sessionType=${msg.sessionType ?? "<none>"} ` +
          `groupID=${msg.groupID || "<none>"} contentType=${msg.contentType ?? "<none>"} ` +
          `textLen=${msg.textElem?.content?.length ?? 0}`
      );
      processInboundMessage(api, state as OpenIMClientState, msg, source).catch((e: any) => {
        api.logger?.error?.(`[openim] processInboundMessage failed: ${formatSdkError(e)}`);
      });
    };

    state.handlers.onRecvNewMessage = (event: CallbackEvent<MessageItem>) => {
      api.logger?.info?.(
        `[openim][callback] OnRecvNewMessage account=${config.accountId} ` +
          `hasData=${Boolean(event?.data)} operationID=${event?.operationID || "<none>"} ` +
          `errCode=${event?.errCode ?? 0} errMsg=${event?.errMsg || "<none>"}`
      );
      if (event?.data) consumeMessage(event.data, "live");
      else api.logger?.warn?.(`[openim][callback] OnRecvNewMessage has no data account=${config.accountId}`);
    };
    state.handlers.onRecvOfflineNewMessage = (event: CallbackEvent<MessageItem>) => {
      api.logger?.info?.(
        `[openim][callback] OnRecvOfflineNewMessage account=${config.accountId} ` +
          `hasData=${Boolean(event?.data)} operationID=${event?.operationID || "<none>"} ` +
          `errCode=${event?.errCode ?? 0} errMsg=${event?.errMsg || "<none>"}`
      );
      if (event?.data) consumeMessage(event.data, "offline");
      else api.logger?.warn?.(`[openim][callback] OnRecvOfflineNewMessage has no data account=${config.accountId}`);
    };
    state.handlers.onRecvNewMessages = (event: CallbackEvent<MessageItem[]>) => {
      const list = Array.isArray(event?.data) ? event.data : [];
      api.logger?.info?.(
        `[openim][callback] OnRecvNewMessages account=${config.accountId} count=${list.length} ` +
          `operationID=${event?.operationID || "<none>"} errCode=${event?.errCode ?? 0} ` +
          `errMsg=${event?.errMsg || "<none>"}`
      );
      for (const msg of list) consumeMessage(msg, "batch");
    };
    state.handlers.onRecvOfflineNewMessages = (event: CallbackEvent<MessageItem[]>) => {
      const list = Array.isArray(event?.data) ? event.data : [];
      api.logger?.info?.(
        `[openim][callback] OnRecvOfflineNewMessages account=${config.accountId} count=${list.length} ` +
          `operationID=${event?.operationID || "<none>"} errCode=${event?.errCode ?? 0} ` +
          `errMsg=${event?.errMsg || "<none>"}`
      );
      for (const msg of list) consumeMessage(msg, "offline");
    };
    state.handlers.onConversationChanged = (event: CallbackEvent<unknown>) => {
      const list = Array.isArray(event?.data) ? event.data : [];
      const summary = list.slice(0, 10).map((item: any) => {
        const latest = typeof item?.latestMsg === "string" ? item.latestMsg : "";
        let latestSeq = "<none>";
        let latestSender = "<none>";
        try {
          const parsed = JSON.parse(latest);
          latestSeq = String(parsed?.seq ?? "<none>");
          latestSender = String(parsed?.sendID ?? "<none>");
        } catch {
          // The SDK may emit a conversation without a parseable latestMsg.
        }
        return `${item?.conversationID || "<none>"}{user=${item?.userID || "<none>"},unread=${item?.unreadCount ?? "<none>"},latestSeq=${latestSeq},latestSender=${latestSender}}`;
      }).join(";");
      api.logger?.info?.(
        `[openim][conversation] changed account=${config.accountId} count=${list.length} ` +
          `operationID=${event?.operationID || "<none>"} unreadTotalHint=${summary || "<none>"}`
      );
    };
    state.handlers.onTotalUnreadMessageCountChanged = (event: CallbackEvent<unknown>) => {
      api.logger?.info?.(
        `[openim][conversation] total unread changed account=${config.accountId} ` +
          `value=${event?.data ?? "<none>"} operationID=${event?.operationID || "<none>"} ` +
          `errCode=${event?.errCode ?? 0} errMsg=${event?.errMsg || "<none>"}`
      );
    };
    state.handlers.onUserTokenExpired = (event: CallbackEvent<unknown>) => {
      (state as OpenIMClientState).connectionLostAtMs = Date.now();
      api.logger?.warn?.(`[openim] account ${config.accountId} user token expired: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "user token expired");
    };
    state.handlers.onUserTokenInvalid = (event: CallbackEvent<unknown>) => {
      (state as OpenIMClientState).connectionLostAtMs = Date.now();
      api.logger?.warn?.(`[openim] account ${config.accountId} user token invalid: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "user token invalid");
    };
    state.handlers.onKickedOffline = (event: CallbackEvent<unknown>) => {
      (state as OpenIMClientState).connectionLostAtMs = Date.now();
      api.logger?.warn?.(`[openim] account ${config.accountId} kicked offline: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "kicked offline");
    };
    state.handlers.onConnectFailed = (event: CallbackEvent<unknown>) => {
      (state as OpenIMClientState).connectionLostAtMs = Date.now();
      api.logger?.warn?.(`[openim] account ${config.accountId} connect failed: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "connect failed");
    };
    state.handlers.onConnectSuccess = () => {
      if (!state) return;
      handleConnectSuccess(api, state as OpenIMClientState);
    };

    attachHandlers(sdk, state as OpenIMClientState);
    api.logger?.info?.(
      `[openim][startup] handlers attached account=${config.accountId} userID=${config.userID} ` +
        `events=OnRecvNewMessage,OnRecvNewMessages,OnRecvOfflineNewMessage,OnRecvOfflineNewMessages,` +
        `OnConversationChanged,OnTotalUnreadMessageCountChanged`
    );

    markMessageAcceptWindow(state);
    markColdStartHistoryWindow(state);
    api.logger?.info?.(
      `[openim][startup] login begin account=${config.accountId} userID=${config.userID} ` +
        `wsAddr=${config.wsAddr} apiAddr=${config.apiAddr}`
    );
    await sdk.login({
      userID: config.userID,
      token,
      wsAddr: config.wsAddr,
      apiAddr: config.apiAddr,
      platformID: config.platformID,
      logLevel: resolvedConfig.sdkLogLevel ?? LogLevel.Warn,
    });
    api.logger?.info?.(`[openim][startup] login success account=${config.accountId} userID=${config.userID}`);
    clients.set(config.accountId, state);
    startLivenessMonitor(api, state as OpenIMClientState);
    api.logger?.info?.(`[openim] account ${config.accountId} connected`);
  } catch (e: any) {
    if (state) detachHandlers(state);
    api.logger?.error?.(`[openim] account ${config.accountId} login failed: ${formatSdkError(e)}`);
  }
}

/** 仅供单元测试验证 SDK 监听器不会因重连重复挂载。 */
export function __attachHandlersForTest(sdk: any, state: OpenIMClientState): void {
  attachHandlers(sdk, state);
}

/** 仅供单元测试验证连接恢复会取消待执行的主动重连。 */
export function __handleConnectSuccessForTest(api: any, state: OpenIMClientState): void {
  handleConnectSuccess(api, state);
}

export async function stopAllClients(api: any): Promise<void> {
  const items = Array.from(clients.values());
  clients.clear();

  for (const state of items) {
    if (state.reconnect) {
      state.reconnect.stopped = true;
      if (state.reconnect.timer) clearTimeout(state.reconnect.timer);
      state.reconnect.timer = undefined;
    }
    stopLivenessMonitor(state);
    detachHandlers(state);
    try {
      await state.sdk.logout();
    } catch (e: any) {
      api.logger?.warn?.(`[openim] account ${state.config.accountId} logout failed: ${formatSdkError(e)}`);
    }
  }
}
