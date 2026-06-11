import { CbEvents, getSDK, type CallbackEvent, type MessageItem } from "@openim/client-sdk";
import { processInboundMessage } from "./inbound";
import { resolveAccountToken } from "./token";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";
import { formatSdkError } from "./utils";

const clients = new Map<string, OpenIMClientState>();

function detachHandlers(state: OpenIMClientState): void {
  state.sdk.off(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  state.sdk.off(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  state.sdk.off(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
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
      handlers: {
        onRecvNewMessage: () => undefined,
        onRecvNewMessages: () => undefined,
        onRecvOfflineNewMessages: () => undefined,
      },
    } as OpenIMClientState;

    const consumeMessage = (msg: MessageItem) => {
      processInboundMessage(api, state as OpenIMClientState, msg).catch((e: any) => {
        api.logger?.error?.(`[openim] processInboundMessage failed: ${formatSdkError(e)}`);
      });
    };

    state.handlers.onRecvNewMessage = (event: CallbackEvent<MessageItem>) => {
      if (event?.data) consumeMessage(event.data);
    };
    state.handlers.onRecvNewMessages = (event: CallbackEvent<MessageItem[]>) => {
      const list = Array.isArray(event?.data) ? event.data : [];
      for (const msg of list) consumeMessage(msg);
    };
    state.handlers.onRecvOfflineNewMessages = (event: CallbackEvent<MessageItem[]>) => {
      const list = Array.isArray(event?.data) ? event.data : [];
      for (const msg of list) consumeMessage(msg);
    };

    sdk.on(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
    sdk.on(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
    sdk.on(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);

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
    detachHandlers(state);
    try {
      await state.sdk.logout();
    } catch (e: any) {
      api.logger?.warn?.(`[openim] account ${state.config.accountId} logout failed: ${formatSdkError(e)}`);
    }
  }
}
