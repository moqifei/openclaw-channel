import { CbEvents, getSDK, type CallbackEvent, type MessageItem } from "@openim/client-sdk";
import { processInboundMessage, type InboundMessageSource } from "./inbound";
import { resolveAccountToken } from "./token";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";
import { formatSdkError } from "./utils";
import {
  LIVENESS_CHECK_INTERVAL_MS,
  clearStdoutBroken,
  markStdoutBroken,
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
 * 发送失败自愈钩子（借鉴 orange wechat channel 的传输层重试 + 主动重建思路）：
 * media.ts 在 sendMessage 重试耗尽后回调此钩子，主动标记 stdout 断裂并触发重连，
 * 让"偶发已读不回"立即自愈，而非被动等待 180s 存活检测或重启 orange。
 */
registerSendFailureHandler((accountId: string) => {
  const state = clients.get(accountId);
  if (!state) return;
  // 复用 liveness 的 stdout 断裂标记与重连调度（stdoutBroken 会驱动强制重连/退出重建）。
  markStdoutBroken(state, Date.now());
  scheduleReconnect(undefined as any, state, "send failure after retries");
});

function markMessageAcceptWindow(state: OpenIMClientState): void {
  const now = Date.now();
  state.messageAcceptAfterMs = now - MESSAGE_ACCEPT_GRACE_MS;
  state.replayFilterUntilMs = now + MESSAGE_REPLAY_FILTER_WINDOW_MS;
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
    // 周期性健康快照：偶发"假死但未达阈值"时也能看到空闲时长趋势。
    api.logger?.debug?.(
      `[openim][health] account ${state.config.accountId} ` +
        `recvIdleMs=${recvIdleMs} sendIdleMs=${sendIdleMs} stdoutBroken=${!!state.stdoutBroken} ` +
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
  const recvIdleMs = now - state.lastMessageSeenMs;
  if (recvIdleMs >= recvTimeoutMs) {
    return `no inbound message for ${Math.round(recvIdleMs / 1000)}s >= ${Math.round(recvTimeoutMs / 1000)}s`;
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

async function reconnectAccount(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped || reconnect.running) return;
  reconnect.running = true;

  const log = api?.logger ?? (state as any).logger;
  try {
    log?.warn?.(`[openim] account ${state.config.accountId} reconnecting: ${reason}`);
    try {
      await state.sdk.logout();
    } catch {
      // Ignore logout failures; token expiry and broken sockets commonly make logout fail too.
    }

    const token = await resolveAccountToken(state.config, { forceRefresh: true });
    state.config = { ...state.config, token };
    markMessageAcceptWindow(state);
    await state.sdk.login({
      userID: state.config.userID,
      token,
      wsAddr: state.config.wsAddr,
      apiAddr: state.config.apiAddr,
      platformID: state.config.platformID,
    });
    reconnect.attempts = 0;
    clearStdoutBroken(state);
    log?.info?.(`[openim] account ${state.config.accountId} reconnected`);
  } finally {
    reconnect.running = false;
  }
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
      lastMessageSeenMs: Date.now(),
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
      api.logger?.warn?.(`[openim] account ${config.accountId} user token expired: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "user token expired");
    };
    state.handlers.onUserTokenInvalid = (event: CallbackEvent<unknown>) => {
      api.logger?.warn?.(`[openim] account ${config.accountId} user token invalid: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "user token invalid");
    };
    state.handlers.onKickedOffline = (event: CallbackEvent<unknown>) => {
      api.logger?.warn?.(`[openim] account ${config.accountId} kicked offline: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "kicked offline");
    };
    state.handlers.onConnectFailed = (event: CallbackEvent<unknown>) => {
      api.logger?.warn?.(`[openim] account ${config.accountId} connect failed: ${formatSdkError(event?.data)}`);
      scheduleReconnect(api, state as OpenIMClientState, "connect failed");
    };
    state.handlers.onConnectSuccess = () => {
      if (!state) return;
      if (state.reconnect) state.reconnect.attempts = 0;
      state.lastMessageSeenMs = Date.now();
      clearStdoutBroken(state as OpenIMClientState);
      api.logger?.info?.(`[openim] account ${config.accountId} connection healthy`);
    };

    sdk.on(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
    sdk.on(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
    sdk.on(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
    sdk.on(CbEvents.OnUserTokenExpired, state.handlers.onUserTokenExpired);
    sdk.on(CbEvents.OnUserTokenInvalid, state.handlers.onUserTokenInvalid);
    sdk.on(CbEvents.OnKickedOffline, state.handlers.onKickedOffline);
    sdk.on(CbEvents.OnConnectFailed, state.handlers.onConnectFailed);
    sdk.on(CbEvents.OnConnectSuccess, state.handlers.onConnectSuccess);

    markMessageAcceptWindow(state);
    await sdk.login({
      userID: config.userID,
      token,
      wsAddr: config.wsAddr,
      apiAddr: config.apiAddr,
      platformID: config.platformID,
    });
    clients.set(config.accountId, state);
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
