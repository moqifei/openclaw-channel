import { CbEvents, getSDK, type CallbackEvent, type MessageItem } from "@openim/client-sdk";
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

/**
 * 登录后立即把本 bot 账号所有会话标记为已读。
 * 目的：让 server 端 hasReadSeq 追上 maxSeq，使 server 的 pushSyncNotification
 * 在下次登录时计算出的 seq 区间为空的（len==0），从而不再主动推送历史消息。
 * 这是"源头断流"手段；30s 冷启动窗口作为防御兜底（mark 完成前/失败时的保护）。
 * fire-and-forget：不阻塞 login 完成，失败仅告警。
 */
async function markAllConversationsAsRead(api: any, state: OpenIMClientState): Promise<void> {
  const log = api?.logger ?? (state as any).logger;
  try {
    // 等待 SDK 登录后自动同步会话列表完成，否则 getConversationListSplit 可能返回空。
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    const PAGE = 200;
    let offset = 0;
    let total = 0;
    for (;;) {
      const res: any = await state.sdk.getConversationListSplit({ offset, count: PAGE });
      const list: any[] = Array.isArray(res?.data) ? res.data : [];
      if (list.length === 0) break;
      for (const conv of list) {
        const cid = conv?.conversationID;
        if (!cid) continue;
        try {
          await state.sdk.markConversationMessageAsRead(cid);
          total++;
        } catch (err) {
          const text = formatSdkError(err);
          if (!/hasReadSeq equal max|unread count is zero|conversation not exist/i.test(text)) {
            log?.warn?.(`[openim] mark read failed during cold-start sweep: conversationID=${cid}, error=${text}`);
          }
        }
      }
      if (list.length < PAGE) break;
      offset += PAGE;
    }
    log?.info?.(`[openim] cold-start mark-as-read sweep done: markedConversations=${total}`);
  } catch (err) {
    log?.warn?.(`[openim] cold-start mark-as-read sweep failed: ${formatSdkError(err)}`);
  }
}

function detachHandlers(state: OpenIMClientState): void {
  state.sdk.off(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  state.sdk.off(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  state.sdk.off(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
  if (state.handlers.onUserTokenExpired) state.sdk.off(CbEvents.OnUserTokenExpired, state.handlers.onUserTokenExpired);
  if (state.handlers.onUserTokenInvalid) state.sdk.off(CbEvents.OnUserTokenInvalid, state.handlers.onUserTokenInvalid);
  if (state.handlers.onKickedOffline) state.sdk.off(CbEvents.OnKickedOffline, state.handlers.onKickedOffline);
  if (state.handlers.onConnectFailed) state.sdk.off(CbEvents.OnConnectFailed, state.handlers.onConnectFailed);
  if (state.handlers.onConnectSuccess) state.sdk.off(CbEvents.OnConnectSuccess, state.handlers.onConnectSuccess);
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
 * 启动静默假死存活检测。
 * 每隔 LIVENESS_CHECK_INTERVAL_MS 检查一次 lastMessageSeenMs，若超过阈值未收到任何消息，
 * 说明 SDK 长连接已静默失效（收不到消息也不回调 onConnectFailed），主动触发重连。
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
  sendTimeoutMs: number
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
 * 设计为可重入：重复调用不会产生重复副作用（SDK 的 on 是覆盖式注册）。
 */
function attachHandlers(sdk: any, state: OpenIMClientState): void {
  sdk.on(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  sdk.on(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  sdk.on(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
  sdk.on(CbEvents.OnUserTokenExpired, state.handlers.onUserTokenExpired);
  sdk.on(CbEvents.OnUserTokenInvalid, state.handlers.onUserTokenInvalid);
  sdk.on(CbEvents.OnKickedOffline, state.handlers.onKickedOffline);
  sdk.on(CbEvents.OnConnectFailed, state.handlers.onConnectFailed);
  sdk.on(CbEvents.OnConnectSuccess, state.handlers.onConnectSuccess);
}

/**
 * 重建会话：重新 login + 重新挂载监听器。解决 open-im-server 重启后
 * "显示在线但不收消息" 的问题——server 重启使旧 WS 会话的消息订阅失效，
 * 必须重新 login 以重建会话上下文。
 */
/**
 * 仅重建 WS 长连接，不重新 login。
 * 方案 3：当 SDK 仍处于 Logged 状态时，连接断开只需重建 WS 即可复用既有会话
 * （token / 在线状态 / 消息订阅都还在），无需再次 login —— 再次 login 会触发
 * server 端 login repeat(10102) 风暴，并反复触发 server 内部 MultiTerminalLoginCheck
 * 的 PlatformID 软失败。forceReconnect() 只重建底层 WS，避开整条 login 链路。
 */
async function reconnectWsOnly(api: any, state: OpenIMClientState): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped || reconnect.running) return;
  reconnect.running = true;
  const log = api?.logger ?? (state as any).logger;
  try {
    log?.warn?.(`[openim] account ${state.config.accountId} WS-only reconnect (no login, reuse existing session)`);
    await state.sdk.forceReconnect();
    reconnect.attempts = 0;
    state.connectionLostAtMs = undefined;
    clearStdoutBroken(state);
    // forceReconnect 后会再次触发 onConnectSuccess，但此时已是同一会话，
    // needsRestore 去重逻辑会保证不重复重建。
    log?.info?.(`[openim] account ${state.config.accountId} WS-only reconnect issued`);
  } catch (e: any) {
    log?.warn?.(`[openim] account ${state.config.accountId} WS-only reconnect failed (will fallback to full login): ${formatSdkError(e)}`);
    // WS-only 失败则降级为完整 login 重连。
    await fullLoginReconnect(api, state, "ws-only reconnect failed");
  } finally {
    if (reconnect) reconnect.running = false;
  }
}

/**
 * 完整 login 重连：logout（容忍失败）+ 重新 login + 重挂监听器。
 * 仅当 SDK 已不在 Logged 状态（token 失效 / 被踢 / 会话完全丢失）时使用。
 */
async function fullLoginReconnect(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped || reconnect.running) return;
  reconnect.running = true;

  const log = api?.logger ?? (state as any).logger;
  try {
    log?.warn?.(`[openim] account ${state.config.accountId} full login reconnect: ${reason}`);
    try {
      await state.sdk.logout();
    } catch {
      // Ignore logout failures; token expiry and broken sockets commonly make logout fail too.
    }

    const token = await resolveAccountToken(state.config, { forceRefresh: true });
    state.config = { ...state.config, token };
    markMessageAcceptWindow(state);
    markColdStartHistoryWindow(state);
    await state.sdk.login({
      userID: state.config.userID,
      token,
      wsAddr: state.config.wsAddr,
      apiAddr: state.config.apiAddr,
      platformID: state.config.platformID,
    });
    // 重新挂载监听器，绑定到重建后的会话上下文。
    attachHandlers(state.sdk, state);
    reconnect.attempts = 0;
    clearStdoutBroken(state);
    log?.info?.(`[openim] account ${state.config.accountId} reconnected (full login)`);
    // 源头断流：重登后把会话标为已读，使 server 端 hasReadSeq 追上 maxSeq，下次不再推历史。
    void markAllConversationsAsRead(api, state);
  } finally {
    reconnect.running = false;
  }
}

/**
 * 智能重连入口：先判断 SDK 登录状态，已登录则只重建 WS，否则完整 login。
 * 这是方案 3 的核心 —— 绝大多数"连接闪断"场景下 SDK 仍是 Logged 状态，
 * 只重建 WS 即可，彻底规避 10102 风暴。
 */
async function smartReconnect(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const log = api?.logger ?? (state as any).logger;
  let logged = false;
  try {
    const status = await state.sdk.getLoginStatus();
    // LoginStatus enum: Logout=1, Logging=2, Logged=3
    logged = (status as any)?.data === 3;
  } catch {
    // getLoginStatus 不可用时保守走完整 login。
  }
  log?.info?.(`[openim] account ${state.config.accountId} smartReconnect status=${logged ? "Logged" : "not-Logged"}: ${reason}`);
  if (logged) {
    await reconnectWsOnly(api, state);
  } else {
    await fullLoginReconnect(api, state, reason);
  }
}

async function reestablishSession(api: any, state: OpenIMClientState): Promise<void> {
  const reconnect = state.reconnect;
  // 与 smartReconnect 共用互斥，避免并发导致双 login 风暴。
  if (!reconnect || reconnect.stopped || reconnect.running) return;
  reconnect.running = true;
  const log = api?.logger ?? (state as any).logger;
  try {
    // 方案 3：SDK 仍在 Logged 状态时，静默重连只需重建 WS，不重新 login，
    // 避免 login repeat(10102) 风暴与 server 端 MultiTerminalLoginCheck 的 PlatformID 软失败。
    // LoginStatus enum: Logout=1, Logging=2, Logged=3
    let logged = false;
    try {
      const status = await state.sdk.getLoginStatus();
      logged = (status as any)?.data === 3;
    } catch {
      // getLoginStatus 不可用时保守走完整 login。
    }
    if (logged) {
      log?.warn?.(`[openim] account ${state.config.accountId} session re-establish via WS-only reconnect (already logged)`);
      await state.sdk.forceReconnect();
    } else {
      const token = await resolveAccountToken(state.config, { forceRefresh: true }).catch(() => state.config.token ?? "");
      state.config = { ...state.config, token };
      markMessageAcceptWindow(state);
      markColdStartHistoryWindow(state);
      await state.sdk.login({
        userID: state.config.userID,
        token,
        wsAddr: state.config.wsAddr,
        apiAddr: state.config.apiAddr,
        platformID: state.config.platformID,
      });
      // 源头断流：重登后把会话标为已读，使 server 端 hasReadSeq 追上 maxSeq，下次不再推历史。
      void markAllConversationsAsRead(api, state);
    }
  } catch (e: any) {
    // login 失败不致命：SDK 会自动重连并再次触发 onConnectSuccess，届时重试。
    log?.warn?.(`[openim] account ${state.config.accountId} re-login attempt failed (will retry on next connect): ${formatSdkError(e)}`);
  } finally {
    reconnect.running = false;
  }
  // 重新挂载监听器，绑定到新会话上下文。
  attachHandlers(state.sdk, state);
  log?.info?.(`[openim] account ${state.config.accountId} session re-established`);
}

/**
 * 应用层重连入口（被 scheduleReconnect / liveness 调用）。
 * 方案 3：先检查 SDK 登录状态 —— 已 Logged 则只重建 WS（forceReconnect），
 * 否则完整 login 重连。彻底规避反复 login 引发的 10102 风暴。
 */
async function reconnectAccount(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  await smartReconnect(api, state, reason);
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
  clients.clear();
}

export async function startAccountClient(api: any, config: OpenIMAccountConfig): Promise<void> {
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
      lastSessionRestoreMs: undefined,
      handlers: {
        onRecvNewMessage: () => undefined,
        onRecvNewMessages: () => undefined,
        onRecvOfflineNewMessages: () => undefined,
      },
      reconnect: {
        attempts: 0,
        running: false,
        stopped: false,
      },
    } as OpenIMClientState;

    const consumeMessage = (msg: MessageItem, source: InboundMessageSource) => {
      (state as OpenIMClientState).lastMessageSeenMs = Date.now();
      processInboundMessage(api, state as OpenIMClientState, msg, source).catch((e: any) => {
        api.logger?.error?.(`[openim] processInboundMessage failed: ${formatSdkError(e)}`);
      });
    };

    state.handlers.onRecvNewMessage = (event: CallbackEvent<MessageItem>) => {
      if (event?.data) consumeMessage(event.data, "live");
    };
    state.handlers.onRecvNewMessages = (event: CallbackEvent<MessageItem[]>) => {
      const list = Array.isArray(event?.data) ? event.data : [];
      for (const msg of list) consumeMessage(msg, "batch");
    };
    state.handlers.onRecvOfflineNewMessages = (event: CallbackEvent<MessageItem[]>) => {
      const list = Array.isArray(event?.data) ? event.data : [];
      for (const msg of list) consumeMessage(msg, "offline");
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
      const s = state as OpenIMClientState;
      const prevSeen = s.lastMessageSeenMs;
      if (state.reconnect) state.reconnect.attempts = 0;
      s.lastMessageSeenMs = Date.now();
      // 连接成功即视为"明确断连"已恢复，清除标志，避免 liveness 重复强制重连。
      s.connectionLostAtMs = undefined;
      clearStdoutBroken(s);

      // 关键修复（登录风暴收敛）：
      // open-im-server 重启后，旧 WS 会话的消息订阅会失效，需要重新 login 重建会话。
      // 但 SDK 每次 login 成功都会回调 onConnectSuccess，若此处无条件再 login，
      // 会形成 login -> onConnectSuccess -> login ... 的死循环，导致 token 被高频
      // invalidate（server 侧 DELETE_CACHE_AUTH 暴涨）进而 OOM。
      //
      // 防御要点：
      //   1. 首次连接不触发（SDK 自带完整会话）。
      //   2. 仅当存在连接"断连间隔"（非首次）且本次不是由 reconnectAccount 主动
      //      重连引起的（reconnect.running 为 false，即 SDK 自己静默重连）时，才
      //      触发一次 reestablishSession；reconnectAccount 自己已做 logout+login，
      //      无需重复。
      //   3. 用 lastSessionRestoreMs 去重：reestablishSession 内的 login 会再次触发
      //      onConnectSuccess，必须保证同一断连窗口内只恢复一次，彻底切断死循环。
      const firstConnect = prevSeen === undefined || prevSeen <= 0;
      const now = Date.now();
      const recentlyRestored = s.lastSessionRestoreMs && (now - s.lastSessionRestoreMs) < 30_000;
      const needsRestore =
        !firstConnect &&
        state.reconnect &&
        !state.reconnect.running &&
        !state.reconnect.stopped &&
        !recentlyRestored;
      if (needsRestore) {
        s.lastSessionRestoreMs = now;
        api.logger?.warn?.(`[openim] account ${config.accountId} silent reconnect detected, re-login to restore message subscription`);
        reestablishSession(api, s).catch((e: any) => {
          api.logger?.error?.(`[openim] account ${config.accountId} re-login failed after reconnect: ${formatSdkError(e)}`);
          scheduleReconnect(api, s, "re-login failed");
        });
      } else {
        api.logger?.info?.(`[openim] account ${config.accountId} connection healthy`);
      }
    };

    attachHandlers(sdk, state as OpenIMClientState);
    // 保存 detach 能力，供重连后重新注册使用。
    (state as any).__detachHandlers = () => detachHandlers(state as OpenIMClientState);
    // 保存当前账号配置引用，供 onConnectSuccess 重新 login 使用。
    (state as any).__api = api;

    markMessageAcceptWindow(state);
    markColdStartHistoryWindow(state);
    await sdk.login({
      userID: config.userID,
      token,
      wsAddr: config.wsAddr,
      apiAddr: config.apiAddr,
      platformID: config.platformID,
    });
    clients.set(config.accountId, state);
    // 源头断流：登录后立即把所有会话标为已读，使 server 端 hasReadSeq 追上 maxSeq，
    // 下次重启时 server 不再主动推送历史。fire-and-forget，不阻塞启动。
    void markAllConversationsAsRead(api, state);
    startLivenessMonitor(api, state as OpenIMClientState);
    api.logger?.info?.(`[openim] account ${config.accountId} connected`);
  } catch (e: any) {
    if (state) detachHandlers(state);
    api.logger?.error?.(`[openim] account ${config.accountId} login failed: ${formatSdkError(e)}`);
  }
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
