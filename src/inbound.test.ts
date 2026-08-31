import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SessionType, type MessageItem } from "@openim/client-sdk";
import {
  __createAgentStreamReplyControllerForTest,
  __resetInboundDedupForTest,
  processInboundMessage,
} from "./inbound";
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
    processOfflineMessages: true,
    inboundWhitelist: [],
  };
}

function message(id = "msg-1"): MessageItem {
  return {
    clientMsgID: id,
    serverMsgID: `server-${id}`,
    createTime: Date.now(),
    sendTime: Date.now(),
    sessionType: SessionType.Single,
    sendID: "user-1",
    recvID: "bot",
    groupID: "",
    contentType: 101,
    senderNickname: "User One",
    textElem: { content: "hello" },
  } as MessageItem;
}

function state(sdk: any): OpenIMClientState {
  return {
    sdk,
    config: config(),
    messageAcceptAfterMs: 0,
    replayFilterUntilMs: 0,
    lastMessageSeenMs: Date.now(),
    handlers: {
      onRecvNewMessage: () => undefined,
      onRecvNewMessages: () => undefined,
      onRecvOfflineNewMessages: () => undefined,
    },
    reconnect: { attempts: 0, running: false, stopped: false },
  };
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

beforeEach(() => __resetInboundDedupForTest());

test("start emits an immediate agent stream start frame", async () => {
  const events: string[] = [];
  const sdk = {
    async createCustomMessage(input: { data: string }) {
      events.push(JSON.parse(input.data).event);
      return { data: { customElem: input } };
    },
    async sendMessage() {
      return { data: {} };
    },
  };
  const controller = __createAgentStreamReplyControllerForTest(state(sdk), message(), silentLogger());

  await controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(events[0], "start");
});

test("agent stream final is sent exactly once when final() is called twice", async () => {
  const events: string[] = [];
  const sdk = {
    async createCustomMessage(input: { data: string }) {
      events.push(JSON.parse(input.data).event);
      return { data: { customElem: input } };
    },
    async sendMessage() {
      return { data: {} };
    },
  };
  const controller = __createAgentStreamReplyControllerForTest(state(sdk), message(), silentLogger());

  await controller.updateAnswer("reply");
  await Promise.all([controller.final("reply"), controller.final("reply")]);

  assert.equal(events.filter((event) => event === "final").length, 1);
});

test("stream updates are coalesced so Orange dispatch is not serialized on every token", async () => {
  const events: string[] = [];
  const sdk = {
    async createCustomMessage(input: { data: string }) {
      events.push(JSON.parse(input.data).event);
      return { data: { customElem: input } };
    },
    async sendMessage() {
      return { data: {} };
    },
  };
  const controller = __createAgentStreamReplyControllerForTest(state(sdk), message(), silentLogger());

  // Simulate a fast reasoning/answer stream.  Only the latest intermediate
  // frame should be sent; the terminal frame must still be delivered.
  for (let i = 0; i < 50; i++) {
    await controller.updateReasoning(`thinking-${i}`);
    await controller.updateAnswer(`answer-${i}`);
  }
  await controller.final("answer-final");

  assert.equal(events.filter((event) => event === "final").length, 1);
  assert.ok(events.length <= 4, `expected coalesced stream frames, got ${events.join(",")}`);
});

test("final does not wait for cosmetic stream frames", async () => {
  const events: string[] = [];
  let resolveSend!: () => void;
  const sdk = {
    async createCustomMessage(input: { data: string }) {
      const event = JSON.parse(input.data).event;
      events.push(event);
      return { data: { customElem: input } };
    },
    async sendMessage() {
      await new Promise<void>((resolve) => { resolveSend = resolve; });
      return { data: {} };
    },
  };
  const controller = __createAgentStreamReplyControllerForTest(state(sdk), message(), silentLogger());
  await controller.updateAnswer("reply");
  const finalPromise = controller.final("reply");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((event) => event === "final").length, 1);
  resolveSend();
  await finalPromise;
});

test("duplicate SDK callbacks do not issue duplicate mark-as-read requests", async () => {
  let markReadCalls = 0;
  const sdk = {
    async markConversationMessageAsRead() {
      markReadCalls += 1;
      return { data: null };
    },
    async getUsersInfo() {
      return { data: [{ userID: "user-1", nickname: "User One" }] };
    },
    async createCustomMessage(input: { data: string }) {
      return { data: { customElem: input } };
    },
    async sendMessage() {
      return { data: {} };
    },
  };
  const client = state(sdk);
  const api = {
    config: {},
    logger: silentLogger(),
    runtime: {
      channel: {
        reply: {
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
          },
        },
      },
    },
  };
  const msg = message();

  await Promise.all([
    processInboundMessage(api, client, msg, "live"),
    processInboundMessage(api, client, msg, "batch"),
  ]);

  // Accepted-message read receipts are intentionally deferred until after the
  // reply dispatch has started, so a broken SDK history pull cannot block the
  // Orange response path.
  await new Promise((resolve) => setTimeout(resolve, 2_600));

  assert.equal(markReadCalls, 1);
});

test("mark-as-read uses the SDK login ID when inbound recvID is stale", async () => {
  let markedConversationID = "";
  let markReadStarted!: () => void;
  const markReadStartedPromise = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const sdk = {
    async markConversationMessageAsRead(conversationID: string) {
      markedConversationID = conversationID;
      markReadStarted();
      return { data: null };
    },
    async getUsersInfo() {
      return { data: [{ userID: "user-1", nickname: "User One" }] };
    },
    async createCustomMessage(input: { data: string }) {
      return { data: { customElem: input } };
    },
    async sendMessage() {
      return { data: {} };
    },
  };
  const client = state(sdk);
  const api = {
    config: {},
    logger: silentLogger(),
    runtime: {
      channel: {
        reply: {
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
          },
        },
      },
    },
  };
  const inbound = { ...message("stale-recv-id"), recvID: "old-bot-id" } as MessageItem;

  await processInboundMessage(api, client, inbound, "live");
  await markReadStartedPromise;

  assert.equal(markedConversationID, "si_bot_user-1");
});

test("a stuck mark-as-read request cannot block Orange dispatch", async () => {
  let dispatchCalls = 0;
  const sdk = {
    async markConversationMessageAsRead() {
      await new Promise<void>(() => {});
    },
    async getUsersInfo() {
      return { data: [{ userID: "user-1", nickname: "User One" }] };
    },
    async createCustomMessage(input: { data: string }) {
      return { data: { customElem: input } };
    },
    async sendMessage() {
      return { data: {} };
    },
  };
  const client = state(sdk);
  const api = {
    config: {},
    logger: silentLogger(),
    runtime: {
      channel: {
        reply: {
          async dispatchReplyWithBufferedBlockDispatcher(params: any) {
            dispatchCalls += 1;
            await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
          },
        },
      },
    },
  };

  const startedAt = Date.now();
  await processInboundMessage(api, client, message("stuck-read"), "live");

  assert.equal(dispatchCalls, 1);
  assert.ok(Date.now() - startedAt < 1_000, "dispatch should not wait for mark-as-read");
});
