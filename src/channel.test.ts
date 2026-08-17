import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenIMChannelPlugin } from "./channel";
import { __setTestClient, __clearTestClients } from "./clients";
import { isStdoutBroken } from "./liveness";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";

// 防止测试中真正调用 process.exit（node:test 会把其视为测试失败）。
// liveness.ts 在 OPENIM_DISABLE_STDOUT_EXIT=1 时只置位副作用、不调度退出。
process.env.OPENIM_DISABLE_STDOUT_EXIT = "1";

const NOW = 1_000_000_000;

function makeConfig(): OpenIMAccountConfig {
  return {
    accountId: "test-account",
    enabled: true,
    userID: "bot",
    wsAddr: "ws://127.0.0.1:10001",
    apiAddr: "http://127.0.0.1:10002",
    platformID: 12,
    adminSecret: "secret",
    adminUserID: "admin",
    requireMention: false,
    processOfflineMessages: true,
    inboundWhitelist: [],
  };
}

function fakeSdk(opts: { sendMessageError?: Error } = {}) {
  return {
    createTextMessage: async (text: string) => ({ data: { text } }),
    sendMessage: async (_args: unknown) => {
      if (opts.sendMessageError) throw opts.sendMessageError;
      return { data: {} };
    },
  } as any;
}

function makeState(sdk: any): OpenIMClientState {
  const config = makeConfig();
  return {
    sdk,
    config,
    messageAcceptAfterMs: 0,
    replayFilterUntilMs: 0,
    lastMessageSeenMs: NOW,
    handlers: { onRecvNewMessage: () => {}, onRecvNewMessages: () => {}, onRecvOfflineNewMessages: () => {} },
    reconnect: { attempts: 0, running: false, stopped: false },
  };
}

beforeEach(() => { __clearTestClients(); });
afterEach(() => { __clearTestClients(); });

test("success updates lastFlushMs", async () => {
  const state = makeState(fakeSdk());
  __setTestClient("test-account", state);
  const res = await OpenIMChannelPlugin.outbound.sendText({ to: "user:123", text: "hello", accountId: "test-account" });
  assert.equal(res.ok, true);
  assert.equal(typeof state.lastFlushMs, "number");
  assert.ok((state.lastFlushMs as number) >= NOW);
  assert.equal(isStdoutBroken(state), false);
});

test("EPIPE marks stdoutBroken", async () => {
  const state = makeState(fakeSdk({ sendMessageError: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) }));
  __setTestClient("test-account", state);
  const res = await OpenIMChannelPlugin.outbound.sendText({ to: "user:123", text: "hello", accountId: "test-account" });
  assert.equal(res.ok, false);
  assert.equal(isStdoutBroken(state), true);
  assert.equal(typeof state.lastStdoutErrorMs, "number");
});

test("non-pipe error does NOT mark stdoutBroken", async () => {
  const state = makeState(fakeSdk({ sendMessageError: new Error("network timeout") }));
  __setTestClient("test-account", state);
  const res = await OpenIMChannelPlugin.outbound.sendText({ to: "user:123", text: "hello", accountId: "test-account" });
  assert.equal(res.ok, false);
  assert.equal(isStdoutBroken(state), false);
});

test("EPIPE requests respawn", async () => {
  const state = makeState(fakeSdk({ sendMessageError: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) }));
  __setTestClient("test-account", state);

  const res = await OpenIMChannelPlugin.outbound.sendText({
    to: "user:123",
    text: "hello",
    accountId: "test-account",
  });
  assert.equal(res.ok, false);
  // 管道断裂必须被标记（#1）
  assert.equal(isStdoutBroken(state), true);
  // 并请求进程级自愈：置位退出调度位，由 orange 重新拉起本插件重建 stdio 通道（#3）
  assert.equal(state.stdoutExitScheduled, true);
});
