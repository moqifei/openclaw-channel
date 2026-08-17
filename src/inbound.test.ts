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

  assert.equal(markReadCalls, 1);
});
