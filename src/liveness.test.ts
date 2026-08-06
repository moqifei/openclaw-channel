import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIVENESS_TIMEOUT_MS,
  resolveLivenessTimeoutMs,
  shouldForceReconnect,
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
