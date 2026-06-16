import { CbEvents, getSDK, type CallbackEvent, type MessageItem } from "@openim/client-sdk";
import { processInboundMessage, type InboundMessageSource } from "./inbound";
import { resolveAccountToken } from "./token";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";
import { formatSdkError } from "./utils";

const clients = new Map<string, OpenIMClientState>();
const MESSAGE_ACCEPT_GRACE_MS = 5 * 60_000;
const MESSAGE_REPLAY_FILTER_WINDOW_MS = 2 * 60_000;

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

  const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(reconnect.attempts, 5));
  reconnect.attempts += 1;
  api.logger?.warn?.(`[openim] account ${state.config.accountId} reconnect scheduled in ${delayMs}ms: ${reason}`);

  reconnect.timer = setTimeout(() => {
    reconnect.timer = undefined;
    reconnectAccount(api, state, reason).catch((e: any) => {
      api.logger?.error?.(`[openim] account ${state.config.accountId} reconnect failed: ${formatSdkError(e)}`);
      scheduleReconnect(api, state, "reconnect failed");
    });
  }, delayMs);
}

async function reconnectAccount(api: any, state: OpenIMClientState, reason: string): Promise<void> {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped || reconnect.running) return;
  reconnect.running = true;

  try {
    api.logger?.warn?.(`[openim] account ${state.config.accountId} reconnecting: ${reason}`);
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
    api.logger?.info?.(`[openim] account ${state.config.accountId} reconnected`);
  } finally {
    reconnect.running = false;
  }
}

export function getConnectedClient(accountId?: string): OpenIMClientState | null {
  if (accountId && clients.has(accountId)) {
    return clients.get(accountId) ?? null;
  }
  if (clients.has("default")) return clients.get("default") ?? null;

  const first = clients.values().next();
  return first.done ? null : first.value;
}

export function connectedClientCount(): number {
  return clients.size;
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
      if (state?.reconnect) state.reconnect.attempts = 0;
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
    detachHandlers(state);
    try {
      await state.sdk.logout();
    } catch (e: any) {
      api.logger?.warn?.(`[openim] account ${state.config.accountId} logout failed: ${formatSdkError(e)}`);
    }
  }
}
