import assert from "node:assert/strict";
import { test } from "node:test";
import { CbEvents } from "@openim/client-sdk";
import { __attachHandlersForTest, __handleConnectSuccessForTest } from "./clients";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";

function config(): OpenIMAccountConfig {
  return {
    accountId: "bot-1",
    enabled: true,
    userID: "bot",
    wsAddr: "ws://127.0.0.1:10001",
    apiAddr: "http://127.0.0.1:10002",
    platformID: 12,
    adminSecret: "secret",
    adminUserID: "admin",
    requireMention: false,
    processOfflineMessages: false,
    inboundWhitelist: [],
  };
}

function state(sdk: any): OpenIMClientState {
  return {
    sdk,
    config: config(),
    messageAcceptAfterMs: 0,
    replayFilterUntilMs: 0,
    lastMessageSeenMs: 1,
    handlers: {
      onRecvNewMessage: () => undefined,
      onRecvNewMessages: () => undefined,
      onRecvOfflineNewMessages: () => undefined,
      onUserTokenExpired: () => undefined,
      onUserTokenInvalid: () => undefined,
      onKickedOffline: () => undefined,
      onConnectFailed: () => undefined,
      onConnectSuccess: () => undefined,
    },
    reconnect: { attempts: 3, running: false, stopped: false },
  };
}

test("handler attachment is idempotent because OpenIM SDK on() appends listeners", () => {
  const registrations = new Map<string, number>();
  const sdk = {
    on(event: string) {
      registrations.set(event, (registrations.get(event) ?? 0) + 1);
    },
    off() {},
  };
  const client = state(sdk);

  __attachHandlersForTest(sdk, client);
  __attachHandlersForTest(sdk, client);
  __attachHandlersForTest(sdk, client);

  for (const event of [
    CbEvents.OnRecvNewMessage,
    CbEvents.OnRecvNewMessages,
    CbEvents.OnRecvOfflineNewMessages,
    CbEvents.OnUserTokenExpired,
    CbEvents.OnUserTokenInvalid,
    CbEvents.OnKickedOffline,
    CbEvents.OnConnectFailed,
    CbEvents.OnConnectSuccess,
  ]) {
    assert.equal(registrations.get(event), 1, `${event} must only be registered once`);
  }
});

test("SDK self-recovery cancels pending reconnect without forceReconnect", () => {
  let forceReconnectCalls = 0;
  const sdk = {
    forceReconnect() {
      forceReconnectCalls += 1;
    },
  };
  const client = state(sdk);
  client.connectionLostAtMs = Date.now() - 1_000;
  client.stdoutBroken = true;
  let timerFired = false;
  client.reconnect!.timer = setTimeout(() => {
    timerFired = true;
  }, 50);

  __handleConnectSuccessForTest({ logger: { info() {} } }, client);

  assert.equal(client.reconnect!.timer, undefined);
  assert.equal(client.reconnect!.attempts, 0);
  assert.equal(client.connectionLostAtMs, undefined);
  assert.equal(client.stdoutBroken, false);
  assert.equal(forceReconnectCalls, 0);
  assert.equal(timerFired, false);
});
