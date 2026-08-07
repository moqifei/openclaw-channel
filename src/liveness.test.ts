import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIVENESS_TIMEOUT_MS,
  DEFAULT_SEND_LIVENESS_TIMEOUT_MS,
  clearStdoutBroken,
  isPipeBrokenError,
  isStdoutBroken,
  markStdoutBroken,
  resolveLivenessTimeoutMs,
  resolveSendLivenessTimeoutMs,
  scheduleStdoutBrokenExit,
  shouldForceReconnect,
  updateLastFlush,
} from "./liveness";
import type { OpenIMAccountConfig, OpenIMClientState } from "./types";

function makeConfig(overrides: Partial<OpenIMAccountConfig> = {}): OpenIMAccountConfig {
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
    ...overrides,
  };
}

function makeState(
  config: OpenIMAccountConfig,
  opts: {
    lastMessageSeenMs: number;
    reconnect?: Partial<NonNullable<OpenIMClientState["reconnect"]>>;
  }
): OpenIMClientState {
  return {
    sdk: {} as any,
    config,
    messageAcceptAfterMs: 0,
    replayFilterUntilMs: 0,
    lastMessageSeenMs: opts.lastMessageSeenMs,
    handlers: {
      onRecvNewMessage: () => {},
      onRecvNewMessages: () => {},
      onRecvOfflineNewMessages: () => {},
    },
    reconnect: {
      attempts: 0,
      running: false,
      stopped: false,
      ...opts.reconnect,
    },
  };
}

const NOW = 1_000_000_000;

test("resolveLivenessTimeoutMs returns default when not configured", () => {
  const config = makeConfig();
  assert.equal(resolveLivenessTimeoutMs(config), DEFAULT_LIVENESS_TIMEOUT_MS);
});

test("resolveLivenessTimeoutMs honors per-account override", () => {
  const config = makeConfig({ livenessTimeoutMs: 10_000 });
  assert.equal(resolveLivenessTimeoutMs(config), 10_000);
});

test("active connection (idle < timeout) does NOT force reconnect", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW - 1_000 });
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), false);
});

test("stale connection (idle >= timeout) DOES force reconnect", () => {
  const config = makeConfig();
  const state = makeState(config, {
    lastMessageSeenMs: NOW - (DEFAULT_LIVENESS_TIMEOUT_MS + 1),
  });
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), true);
});

test("exactly at threshold boundary (idle == timeout) DOES force reconnect", () => {
  const config = makeConfig();
  const state = makeState(config, {
    lastMessageSeenMs: NOW - DEFAULT_LIVENESS_TIMEOUT_MS,
  });
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), true);
});

test("respects custom timeoutMs parameter", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW - 60_000 });
  // idle 60s, default 180s -> false; custom 30s -> true
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), false);
  assert.equal(shouldForceReconnect(state, NOW, 30_000), true);
});

test("does NOT force reconnect while a reconnect is already running", () => {
  const config = makeConfig();
  const state = makeState(config, {
    lastMessageSeenMs: NOW - (DEFAULT_LIVENESS_TIMEOUT_MS + 1),
    reconnect: { running: true },
  });
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), false);
});

test("does NOT force reconnect when reconnect controller is stopped", () => {
  const config = makeConfig();
  const state = makeState(config, {
    lastMessageSeenMs: NOW - (DEFAULT_LIVENESS_TIMEOUT_MS + 1),
    reconnect: { stopped: true },
  });
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), false);
});

test("does NOT force reconnect when reconnect controller is absent", () => {
  const config = makeConfig();
  const state = makeState(config, {
    lastMessageSeenMs: NOW - (DEFAULT_LIVENESS_TIMEOUT_MS + 1),
  });
  state.reconnect = undefined;
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), false);
});

// ---------------------------------------------------------------------------
// #1 反向存活探测：本进程与 orange 之间的 stdio 管道断裂感知
// ---------------------------------------------------------------------------

test("isPipeBrokenError detects EPIPE", () => {
  assert.equal(isPipeBrokenError({ code: "EPIPE" }), true);
});

test("isPipeBrokenError detects broken pipe in message", () => {
  assert.equal(isPipeBrokenError(new Error("write EPIPE")), true);
  assert.equal(isPipeBrokenError(new Error("write after end")), true);
});

test("isPipeBrokenError ignores unrelated errors", () => {
  assert.equal(isPipeBrokenError(new Error("network timeout")), false);
  assert.equal(isPipeBrokenError(null), false);
  assert.equal(isPipeBrokenError(new Error("ECONNREFUSED")), false);
});

test("markStdoutBroken flags pipe as broken and records timestamp", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  assert.equal(isStdoutBroken(state), false);
  markStdoutBroken(state, NOW);
  assert.equal(isStdoutBroken(state), true);
  assert.equal(state.lastStdoutErrorMs, NOW);
});

test("clearStdoutBroken resets the broken flag", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  markStdoutBroken(state, NOW);
  clearStdoutBroken(state);
  assert.equal(isStdoutBroken(state), false);
});

test("#1 broken pipe forces immediate reconnect (no timeout wait)", () => {
  const config = makeConfig();
  // 收侧/发侧都还"新鲜"，但管道已断裂 -> 必须立即重连
  const state = makeState(config, { lastMessageSeenMs: NOW - 1_000 });
  state.lastFlushMs = NOW - 1_000;
  markStdoutBroken(state, NOW - 500);
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), true);
});

test("#1 broken pipe still forces reconnect before reconnect controller settles", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  markStdoutBroken(state, NOW);
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), true);
});

// ---------------------------------------------------------------------------
// #2 收发双维存活检测：发侧（写回 orange）超时也要重连
// ---------------------------------------------------------------------------

test("resolveSendLivenessTimeoutMs returns default when not configured", () => {
  const config = makeConfig();
  assert.equal(resolveSendLivenessTimeoutMs(config), DEFAULT_SEND_LIVENESS_TIMEOUT_MS);
});

test("resolveSendLivenessTimeoutMs honors per-account override", () => {
  const config = makeConfig({ sendLivenessTimeoutMs: 15_000 });
  assert.equal(resolveSendLivenessTimeoutMs(config), 15_000);
});

test("#2 active connection (both sides fresh) does NOT force reconnect", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW - 1_000 });
  state.lastFlushMs = NOW - 1_000;
  assert.equal(
    shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    false
  );
});

test("#2 send-side stale (no flush to orange) DOES force reconnect", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW - 1_000 });
  // 收侧还很新鲜，但发侧已超过阈值未成功写回
  state.lastFlushMs = NOW - (DEFAULT_SEND_LIVENESS_TIMEOUT_MS + 1);
  assert.equal(
    shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    true
  );
});

test("#2 send-side timeout ignored when sendTimeoutMs not provided (backward compatible)", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW - 1_000 });
  state.lastFlushMs = NOW - (DEFAULT_SEND_LIVENESS_TIMEOUT_MS + 1_000);
  // 不传 sendTimeoutMs 时只检收侧，发侧过期不影响
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS), false);
});

test("#2 send-side exactly at boundary triggers reconnect", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  state.lastFlushMs = NOW - DEFAULT_SEND_LIVENESS_TIMEOUT_MS;
  assert.equal(
    shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    true
  );
});

test("#2 custom send timeout respected", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  state.lastFlushMs = NOW - 60_000;
  // 发侧空闲 60s，默认发侧阈值 180s -> false；自定义 30s -> true
  assert.equal(
    shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    false
  );
  assert.equal(shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS, 30_000), true);
});

test("#2 broken pipe takes precedence over fresh timers", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  state.lastFlushMs = NOW;
  markStdoutBroken(state, NOW);
  // 即便收发两侧都健康，管道断裂也应立即重连
  assert.equal(
    shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    true
  );
});

test("updateLastFlush records timestamp and clears broken flag", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  markStdoutBroken(state, NOW - 1_000);
  updateLastFlush(state, NOW + 5_000);
  assert.equal(state.lastFlushMs, NOW + 5_000);
  assert.equal(isStdoutBroken(state), false);
});

test("describe/health helpers integrate: successful flush then broken pipe", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  updateLastFlush(state, NOW);
  assert.equal(
    shouldForceReconnect(state, NOW + 10_000, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    false
  );
  markStdoutBroken(state, NOW + 11_000);
  assert.equal(
    shouldForceReconnect(state, NOW + 12_000, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    true
  );
});

// ---------------------------------------------------------------------------
// #3 进程级自愈：管道断裂后主动退出，由 orange 重新拉起以重建 stdio 通道
// ---------------------------------------------------------------------------

test("#3 does NOT schedule exit when pipe is healthy", () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  let exited: number | null = null;
  scheduleStdoutBrokenExit(state, (code) => { exited = code; });
  assert.equal(exited, null);
  assert.equal(state.stdoutExitScheduled, undefined);
});

test("#3 schedules process.exit(1) when pipe is broken", async () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  markStdoutBroken(state, NOW);
  let exited: number | null = null;
  scheduleStdoutBrokenExit(state, (code) => { exited = code; });
  // 退出通过 setTimeout(...,0) 调度，等待其触发
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(exited, 1);
  assert.equal(state.stdoutExitScheduled, true);
});

test("#3 does not schedule exit twice (dedup)", async () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  markStdoutBroken(state, NOW);
  const calls: number[] = [];
  const exitImpl = (code: number) => { calls.push(code); };
  scheduleStdoutBrokenExit(state, exitImpl);
  scheduleStdoutBrokenExit(state, exitImpl); // 第二次应被去重
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls, [1]);
});

test("#3 integration: broken pipe triggers both detection and exit", async () => {
  const config = makeConfig();
  const state = makeState(config, { lastMessageSeenMs: NOW });
  // 模拟 outbound 探测到 EPIPE
  markStdoutBroken(state, NOW);
  assert.equal(
    shouldForceReconnect(state, NOW, DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_SEND_LIVENESS_TIMEOUT_MS),
    true
  );
  let exited: number | null = null;
  scheduleStdoutBrokenExit(state, (code) => { exited = code; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(exited, 1);
});
