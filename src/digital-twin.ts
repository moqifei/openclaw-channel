export const OpenIMDigitalTwinProtocol = {
  mode: "http_task",
  transport: "http",
  channel: "openim",
  orangeReplyPath: "/api/v1/digital-twin/reply",
  perTwinAccount: false,
  accountScopePrefix: "digital_twin:",
  agentScopePrefix: "digital_twin__",
} as const;

export interface OpenIMDigitalTwinTask {
  ownerUserID: string;
  senderUserID: string;
  messageContent: string;
  fallbackReplyText?: string;
  prompt?: string;
  serverMsgID?: string;
  clientMsgID?: string;
  operationID?: string;
  /** Real gateway username (e.g. testuser), resolved from OpenIM user info cache. */
  username?: string;
}

export interface NormalizedOpenIMDigitalTwinTask extends OpenIMDigitalTwinTask {
  channel: "openim";
  accountId: string;
  agentId: string;
  target: string;
  workspaceScope: "digital_twin_owner";
  /** Real gateway username, if resolved. */
  username?: string;
}

export interface KnowledgeCitation {
  title: string;
  spaceName: string;
  relevanceScore: number;
}

export interface OpenIMDigitalTwinReply {
  ownerUserID: string;
  senderUserID: string;
  replyText: string;
  source?: string;
  serverMsgID?: string;
  clientMsgID?: string;
  operationID?: string;
  citations?: KnowledgeCitation[];
}

export interface NormalizedOpenIMDigitalTwinReply extends OpenIMDigitalTwinReply {
  channel: "openim";
  accountId: string;
  agentId: string;
  target: string;
  workspaceScope: "digital_twin_owner";
  metadata: {
    protocol: "openim_digital_twin_http_task";
    ownerUserID: string;
    senderUserID: string;
    accountId: string;
    agentId: string;
    workspaceScope: "digital_twin_owner";
    source: string;
    serverMsgID?: string;
    clientMsgID?: string;
    operationID?: string;
  };
}

export function digitalTwinAccountId(ownerUserID: string): string {
  const owner = String(ownerUserID ?? "").trim();
  if (!owner) throw new Error("ownerUserID is required");
  return `${OpenIMDigitalTwinProtocol.accountScopePrefix}${owner}`;
}

export function digitalTwinAgentId(ownerUserID: string): string {
  const owner = String(ownerUserID ?? "").trim();
  if (!owner) throw new Error("ownerUserID is required");
  const safeOwner = owner.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "owner";
  return `${OpenIMDigitalTwinProtocol.agentScopePrefix}${safeOwner}`;
}

export function normalizeOpenIMDigitalTwinTask(task: OpenIMDigitalTwinTask): NormalizedOpenIMDigitalTwinTask {
  const ownerUserID = String(task.ownerUserID ?? "").trim();
  const senderUserID = String(task.senderUserID ?? "").trim();
  if (!ownerUserID) throw new Error("ownerUserID is required");
  if (!senderUserID) throw new Error("senderUserID is required");

  return {
    ownerUserID,
    senderUserID,
    messageContent: String(task.messageContent ?? "").trim(),
    fallbackReplyText: String(task.fallbackReplyText ?? "").trim(),
    prompt: String(task.prompt ?? "").trim(),
    serverMsgID: String(task.serverMsgID ?? "").trim(),
    clientMsgID: String(task.clientMsgID ?? "").trim(),
    operationID: String(task.operationID ?? "").trim(),
    username: task.username,
    channel: OpenIMDigitalTwinProtocol.channel,
    accountId: digitalTwinAccountId(ownerUserID),
    agentId: digitalTwinAgentId(ownerUserID),
    target: `user:${senderUserID}`,
    workspaceScope: "digital_twin_owner",
  };
}

export function buildOpenIMDigitalTwinPrompt(task: OpenIMDigitalTwinTask): string {
  const normalized = normalizeOpenIMDigitalTwinTask(task);
  const lines = [
    "你是 OpenIM 用户的数字分身，请代表用户做简短、自然、谨慎的回复。",
  ];
  if (normalized.prompt) {
    lines.push(`用户分身设定：${normalized.prompt}`);
  }
  lines.push(`收到的消息：${normalized.messageContent}`);
  return lines.join("\n");
}

export function normalizeOpenIMDigitalTwinReply(reply: OpenIMDigitalTwinReply): NormalizedOpenIMDigitalTwinReply {
  const ownerUserID = String(reply.ownerUserID ?? "").trim();
  const senderUserID = String(reply.senderUserID ?? "").trim();
  const replyText = String(reply.replyText ?? "").trim();
  if (!ownerUserID) throw new Error("ownerUserID is required");
  if (!senderUserID) throw new Error("senderUserID is required");
  if (!replyText) throw new Error("replyText is required");

  const source = String(reply.source ?? "orange_dispatcher").trim() || "orange_dispatcher";
  const normalized: NormalizedOpenIMDigitalTwinReply = {
    ownerUserID,
    senderUserID,
    replyText,
    source,
    citations: reply.citations,
    serverMsgID: String(reply.serverMsgID ?? "").trim(),
    clientMsgID: String(reply.clientMsgID ?? "").trim(),
    operationID: String(reply.operationID ?? "").trim(),
    channel: OpenIMDigitalTwinProtocol.channel,
    accountId: digitalTwinAccountId(ownerUserID),
    agentId: digitalTwinAgentId(ownerUserID),
    target: `user:${senderUserID}`,
    workspaceScope: "digital_twin_owner",
    metadata: {
      protocol: "openim_digital_twin_http_task",
      ownerUserID,
      senderUserID,
      accountId: digitalTwinAccountId(ownerUserID),
      agentId: digitalTwinAgentId(ownerUserID),
      workspaceScope: "digital_twin_owner",
      source,
    },
  };
  if (normalized.serverMsgID) normalized.metadata.serverMsgID = normalized.serverMsgID;
  if (normalized.clientMsgID) normalized.metadata.clientMsgID = normalized.clientMsgID;
  if (normalized.operationID) normalized.metadata.operationID = normalized.operationID;
  return normalized;
}
