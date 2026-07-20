import { SessionType, type MessageItem } from "@openim/client-sdk";
import { sendCustomToTarget, sendTextToTarget } from "./media";
import type { ChatType, InboundBodyResult, InboundMediaItem, OpenIMClientState, ParsedTarget } from "./types";
import { resolveOpenIMUserInfo } from "./user";
import { formatSdkError } from "./utils";

const inboundDedup = new Map<string, number>();
const INBOUND_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INBOUND_DEDUP_SIZE = 20000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const AGENT_STREAM_EXT_TYPE = "agent_stream";
const AGENT_STREAM_SEND_INTERVAL_MS = 250;

type ImagePart = { type: "image"; data: string; mimeType: string };
export type InboundMessageSource = "live" | "batch" | "offline";
type AgentStreamEvent = "start" | "reasoning" | "answer" | "final" | "error";

function normalizeImageMimeType(value: unknown): string | undefined {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.startsWith("image/") ? mime : undefined;
}

function normalizeMimeType(value: unknown): string | undefined {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.includes("/") ? mime : undefined;
}

function normalizeString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function normalizeSize(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function summarizeMedia(item: InboundMediaItem): string {
  if (item.kind === "image") {
    return item.url ? `[Image] ${item.url}` : "[Image message]";
  }

  if (item.kind === "video") {
    const parts = ["[Video]"];
    if (item.fileName) parts.push(`name=${item.fileName}`);
    if (item.url) parts.push(`video=${item.url}`);
    if (item.snapshotUrl) parts.push(`snapshot=${item.snapshotUrl}`);
    if (item.size) parts.push(`size=${item.size}`);
    return parts.join(" ");
  }

  const parts = ["[File]"];
  if (item.fileName) parts.push(`name=${item.fileName}`);
  if (item.mimeType) parts.push(`type=${item.mimeType}`);
  if (item.url) parts.push(`url=${item.url}`);
  if (item.size) parts.push(`size=${item.size}`);
  return parts.join(" ");
}

function mergeInboundResults(parts: Array<InboundBodyResult | null | undefined>): InboundBodyResult {
  const valid = parts.filter(Boolean) as InboundBodyResult[];
  if (valid.length === 0) return { body: "", kind: "unknown" };

  const bodies = valid.map((item) => item.body).filter(Boolean);
  const media = valid.flatMap((item) => item.media ?? []);
  if (valid.length === 1) {
    return {
      body: bodies[0] || "",
      kind: valid[0].kind,
      media: media.length > 0 ? media : undefined,
    };
  }

  return {
    body: bodies.join("\n"),
    kind: "mixed",
    media: media.length > 0 ? media : undefined,
  };
}

async function fetchImageAsContentPart(url: string, hintedMimeType?: string): Promise<ImagePart> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`image fetch timeout after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`image fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${buffer.byteLength} bytes`);
  }

  const mimeType = normalizeImageMimeType(response.headers.get("content-type")) ?? normalizeImageMimeType(hintedMimeType) ?? "image/jpeg";
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
  };
}

function buildTextEnvelope(
  runtime: any,
  cfg: any,
  fromLabel: string,
  senderId: string,
  timestamp: number,
  bodyText: string,
  chatType: ChatType
): string {
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const formatted = runtime.channel.reply?.formatInboundEnvelope?.({
    channel: "OpenIM",
    from: fromLabel,
    timestamp,
    body: bodyText,
    chatType,
    sender: { name: fromLabel, id: senderId },
    envelope: envelopeOptions,
  });
  return typeof formatted === "string" ? formatted : bodyText;
}

async function materializeInboundMedia(media: InboundMediaItem[] | undefined): Promise<{ images: ImagePart[]; warnings: string[] }> {
  if (!Array.isArray(media) || media.length === 0) {
    return { images: [], warnings: [] };
  }

  const images: ImagePart[] = [];
  const warnings: string[] = [];

  for (const item of media) {
    try {
      if (item.kind === "image" && item.url) {
        images.push(await fetchImageAsContentPart(item.url, item.mimeType));
        continue;
      }

      if (item.kind === "video" && item.snapshotUrl) {
        images.push(await fetchImageAsContentPart(item.snapshotUrl));
        continue;
      }
    } catch (err) {
      warnings.push(`${summarizeMedia(item)} => ${formatSdkError(err)}`);
    }
  }

  return { images, warnings };
}

function extractPictureMedia(msg: MessageItem): InboundMediaItem[] {
  const pic = msg.pictureElem;
  if (!pic) return [];
  const source = pic.sourcePicture;
  const big = pic.bigPicture;
  const snapshot = pic.snapshotPicture;
  const url = normalizeString(source?.url) || normalizeString(big?.url) || normalizeString(snapshot?.url);
  const mimeType = normalizeImageMimeType(source?.type) || normalizeImageMimeType(big?.type) || normalizeImageMimeType(snapshot?.type);
  return [{ kind: "image", url, mimeType }];
}

function extractVideoMedia(msg: MessageItem): InboundMediaItem[] {
  const video = msg.videoElem as any;
  if (!video) return [];
  return [
    {
      kind: "video",
      url: normalizeString(video.videoUrl),
      snapshotUrl: normalizeString(video.snapshotUrl),
      fileName: normalizeString(video.videoName ?? video.fileName ?? video.snapshotName),
      size: normalizeSize(video.videoSize ?? video.duration),
      mimeType: normalizeMimeType(video.videoType ?? video.type),
    },
  ];
}

function extractFileMedia(msg: MessageItem): InboundMediaItem[] {
  const file = msg.fileElem as any;
  if (!file) return [];
  return [
    {
      kind: "file",
      url: normalizeString(file.sourceUrl),
      fileName: normalizeString(file.fileName),
      size: normalizeSize(file.fileSize),
      mimeType: normalizeMimeType(file.fileType ?? file.type),
    },
  ];
}

function extractInboundBody(msg: MessageItem, depth = 0): InboundBodyResult {
  const text = String(msg.textElem?.content ?? msg.atTextElem?.text ?? "").trim();
  const imageMedia = extractPictureMedia(msg);
  const videoMedia = extractVideoMedia(msg);
  const fileMedia = extractFileMedia(msg);

  if (msg.quoteElem?.quoteMessage) {
    const quotedMsg = msg.quoteElem.quoteMessage;
    const quotedSender = String(quotedMsg.senderNickname || quotedMsg.sendID || "unknown");
    const quoted = depth < 2 ? extractInboundBody(quotedMsg, depth + 1) : { body: "[quoted message]", kind: "mixed" as const };
    const currentParts: string[] = [];
    if (text) currentParts.push(`Reply: ${text}`);
    for (const item of [...imageMedia, ...videoMedia, ...fileMedia]) {
      currentParts.push(`Reply attachment: ${summarizeMedia(item)}`);
    }

    const bodyLines = [`[Quote] ${quotedSender}: ${quoted.body || "[empty message]"}`];
    if (currentParts.length > 0) bodyLines.push(currentParts.join("\n"));

    return {
      body: bodyLines.join("\n"),
      kind: currentParts.length > 0 ? "mixed" : quoted.kind,
      media: [...imageMedia, ...videoMedia, ...fileMedia],
    };
  }

  const parts: InboundBodyResult[] = [];
  if (text) parts.push({ body: text, kind: "text" });

  for (const item of imageMedia) {
    parts.push({ body: summarizeMedia(item), kind: "image", media: [item] });
  }
  for (const item of videoMedia) {
    parts.push({ body: summarizeMedia(item), kind: "video", media: [item] });
  }
  for (const item of fileMedia) {
    parts.push({ body: summarizeMedia(item), kind: "file", media: [item] });
  }

  if (msg.customElem?.data || msg.customElem?.description || msg.customElem?.extension) {
    const customText = msg.customElem.description || msg.customElem.data || msg.customElem.extension || "[Custom message]";
    parts.push({ body: `[Custom message] ${customText}`, kind: "mixed" });
  }

  return mergeInboundResults(parts);
}

function shouldProcessInboundMessage(accountId: string, msg: MessageItem): boolean {
  const idPart = String(msg.clientMsgID || msg.serverMsgID || `${msg.sendID}-${msg.seq || msg.createTime || 0}`);
  if (!idPart) return true;

  const key = `${accountId}:${idPart}`;
  const now = Date.now();
  const last = inboundDedup.get(key);
  inboundDedup.set(key, now);

  if (inboundDedup.size > MAX_INBOUND_DEDUP_SIZE) {
    for (const [k, ts] of inboundDedup.entries()) {
      if (now - ts > INBOUND_DEDUP_TTL_MS) inboundDedup.delete(k);
    }
    if (inboundDedup.size > MAX_INBOUND_DEDUP_SIZE) {
      const stale = Array.from(inboundDedup.entries()).sort((a, b) => a[1] - b[1]);
      for (const [k] of stale.slice(0, inboundDedup.size - MAX_INBOUND_DEDUP_SIZE)) {
        inboundDedup.delete(k);
      }
    }
  }

  return !(last && now - last < INBOUND_DEDUP_TTL_MS);
}

function getMessageTimeMs(msg: MessageItem): number {
  const raw = Number(msg.sendTime || msg.createTime || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 10_000_000_000 ? raw * 1000 : raw;
}

function messageIDForLog(msg: MessageItem): string {
  return String(msg.clientMsgID || msg.serverMsgID || `${msg.sendID}-${msg.seq || msg.createTime || 0}` || "unknown");
}

function isGroupMessage(msg: MessageItem): boolean {
  return msg.sessionType === SessionType.Group && !!msg.groupID;
}

/**
 * Detect whether an inbound message was generated by a digital twin (数字分身).
 *
 * The chat service stamps digital-twin replies with an `Ex` field whose JSON
 * contains `"openim_ext_type": "digital_twin"` (see chat/pkg/digitaltwin's
 * `IsDigitalTwinEx`).  When such a message reaches another OpenIM agent (e.g.
 * the recipient's 智能体机器人), that agent must NOT auto-reply, otherwise the
 * two bots loop.  We mirror chat's detection here so openclaw agents stay silent
 * on digital-twin-generated messages.
 */
const DIGITAL_TWIN_EXT_TYPE = "digital_twin";

/**
 * Read the raw digital-twin marker carriers from an inbound message.
 * chat stamps the marker into `Ex`; some SDK/gateway paths surface it via
 * `attachedInfo` instead, so we return both for diagnostics.
 */
function readExCarriers(msg: MessageItem): { ex: string; attachedInfo: string } {
  const ex = String((msg as { ex?: unknown }).ex ?? "").trim();
  const attachedInfo = String((msg as { attachedInfo?: unknown }).attachedInfo ?? "").trim();
  return { ex, attachedInfo };
}

function isDigitalTwinMessage(msg: MessageItem): boolean {
  // MessageItem.ex is declared in @openim/client-sdk/lib/types/entity.d.ts (line 245)
  // and carries the server-side Ex stamp set by chat's BuildReplyExWithSourceTraceTextAndError.
  // Fall back to attachedInfo because some delivery paths surface the marker there.
  const { ex, attachedInfo } = readExCarriers(msg);
  for (const raw of [ex, attachedInfo]) {
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data?.openim_ext_type === DIGITAL_TWIN_EXT_TYPE) return true;
      // The marker may also be nested (e.g. attachedInfoElem wraps it).
      const nested = data?.openim_digital_twin ?? data?.digital_twin;
      if (nested && typeof nested === "object") return true;
    } catch {
      // Not JSON — also accept a plain substring match as a last resort so a
      // marker delivered as a non-JSON string is still caught.
      if (raw.includes(`"${DIGITAL_TWIN_EXT_TYPE}"`) || raw.includes(DIGITAL_TWIN_EXT_TYPE)) {
        return true;
      }
    }
  }
  return false;
}

function isMentionedInGroup(msg: MessageItem, selfUserID: string): boolean {
  const list = msg.atTextElem?.atUserList;
  if (!Array.isArray(list) || list.length === 0) return false;
  const id = String(selfUserID);
  return list.some((item) => String(item) === id);
}

function isWhitelistedSender(client: OpenIMClientState, msg: MessageItem): boolean {
  const whitelist = client.config.inboundWhitelist;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return true;
  const senderId = String(msg.sendID || "").trim();
  if (!senderId) return false;
  return whitelist.some((id) => id === senderId);
}

async function sendReplyFromInbound(client: OpenIMClientState, msg: MessageItem, text: string): Promise<void> {
  const isGroup = isGroupMessage(msg);
  const target: ParsedTarget = isGroup ? { kind: "group", id: String(msg.groupID) } : { kind: "user", id: String(msg.sendID) };
  await sendTextToTarget(client, target, text);
}

function targetFromInboundMessage(msg: MessageItem): ParsedTarget {
  return isGroupMessage(msg)
    ? { kind: "group", id: String(msg.groupID) }
    : { kind: "user", id: String(msg.sendID) };
}

function createAgentStreamReplyController(
  client: OpenIMClientState,
  msg: MessageItem,
  log?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
  }
) {
  const target = targetFromInboundMessage(msg);
  const streamID = `openim-agent-stream-${msg.clientMsgID || msg.serverMsgID || Date.now()}`;
  const basePayload = {
    openim_ext_type: AGENT_STREAM_EXT_TYPE,
    version: 1,
    streamID,
    accountId: client.config.accountId,
    agentUserID: client.config.userID,
    targetUserID: String(msg.sendID || ""),
    triggerClientMsgID: String(msg.clientMsgID || ""),
    triggerServerMsgID: String(msg.serverMsgID || ""),
    createdAt: Date.now(),
  };
  let answerText = "";
  let reasoningText = "";
  let started = false;
  let finalized = false;
  let lastAnswerSentAt = 0;
  let lastReasoningSentAt = 0;
  let sendChain = Promise.resolve();

  const enqueue = (event: AgentStreamEvent, force = false, errorText = "") => {
    if (finalized && event !== "final" && event !== "error") return sendChain;
    const now = Date.now();
    if (!force && event === "answer" && now - lastAnswerSentAt < AGENT_STREAM_SEND_INTERVAL_MS) {
      return sendChain;
    }
    if (!force && event === "reasoning" && now - lastReasoningSentAt < AGENT_STREAM_SEND_INTERVAL_MS) {
      return sendChain;
    }
    if (event === "answer") lastAnswerSentAt = now;
    if (event === "reasoning") lastReasoningSentAt = now;

    const payload = {
      ...basePayload,
      event,
      status: event === "final" ? "done" : event === "error" ? "error" : "streaming",
      answerText,
      reasoningText,
      errorText,
      updatedAt: now,
    };
    const description =
      event === "final"
        ? answerText || "智能体回复"
        : event === "reasoning"
          ? "智能体正在思考"
          : "智能体正在回复";
    sendChain = sendChain.then(async () => {
      await sendCustomToTarget(client, target, payload, description);
      const line =
        `[openim] agent stream custom sent streamID=${streamID} event=${event} ` +
        `status=${payload.status} answerChars=${answerText.length} reasoningChars=${reasoningText.length}`;
      if (event === "final" || event === "error" || event === "start") {
        log?.info?.(line);
      } else {
        log?.debug?.(line);
      }
    });
    return sendChain;
  };

  const ensureStart = () => {
    if (started) return sendChain;
    started = true;
    return enqueue("start", true);
  };

  return {
    streamID,
    async start() {
      await ensureStart();
    },
    async updateReasoning(text: string) {
      const next = String(text || "");
      if (!next || next === reasoningText) return;
      reasoningText = next;
      await ensureStart();
      await enqueue("reasoning");
    },
    async updateAnswer(text: string) {
      const next = String(text || "");
      if (!next || next === answerText) return;
      answerText = next;
      await ensureStart();
      await enqueue("answer");
    },
    async final(text?: string) {
      const next = String(text || answerText || "").trim();
      if (next) answerText = next;
      if (!answerText && !reasoningText) return;
      finalized = true;
      await ensureStart();
      await enqueue("final", true);
      await sendChain;
    },
    async error(error: unknown) {
      finalized = true;
      await ensureStart();
      await enqueue("error", true, formatSdkError(error));
      await sendChain;
    },
    hasContent() {
      return Boolean(answerText || reasoningText);
    },
  };
}

function getConversationIDByInboundMessage(client: OpenIMClientState, msg: MessageItem): string {
  const sessionType = Number(msg.sessionType);
  if (sessionType === SessionType.Group && msg.groupID) {
    return `sg_${msg.groupID}`;
  }
  if (sessionType === SessionType.Notification) {
    return `sn_${[msg.sendID, msg.recvID || client.config.userID].map(String).sort().join("_")}`;
  }
  return `si_${[msg.sendID, msg.recvID || client.config.userID].map(String).sort().join("_")}`;
}

async function markInboundConversationAsRead(api: any, client: OpenIMClientState, msg: MessageItem, reason: string): Promise<void> {
  const conversationID = getConversationIDByInboundMessage(client, msg);
  if (!conversationID) return;

  try {
    await client.sdk.markConversationMessageAsRead(conversationID);
    api.logger?.info?.(`[openim] marked conversation as read: conversationID=${conversationID}, reason=${reason}, msgID=${messageIDForLog(msg)}`);
  } catch (err) {
    const text = formatSdkError(err);
    if (/hasReadSeq equal max|unread count is zero|conversation not exist/i.test(text)) {
      api.logger?.info?.(`[openim] mark read skipped: conversationID=${conversationID}, reason=${reason}, detail=${text}`);
      return;
    }
    api.logger?.warn?.(`[openim] mark conversation as read failed: conversationID=${conversationID}, reason=${reason}, error=${text}`);
  }
}

export async function processInboundMessage(
  api: any,
  client: OpenIMClientState,
  msg: MessageItem,
  source: InboundMessageSource = "live"
): Promise<void> {
  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[openim] runtime.channel.reply not available");
    return;
  }

  const msgID = messageIDForLog(msg);

  // === DIAGNOSTIC (digital-twin loop) ===
  // Dump the raw marker carriers for EVERY inbound message so we can verify in
  // production whether chat's digital-twin `Ex` marker survives delivery to this
  // agent.  If `ex` is empty here, the marker is being dropped somewhere between
  // chat's SendSimpleMsg and the SDK onRecvNewMessage callback — in that case the
  // fix must move to the server/SDK layer, not here.
  {
    const { ex, attachedInfo } = readExCarriers(msg);
    api.logger?.info?.(
      `[openim] inbound diag: source=${source} sendID=${msg.sendID} recvID=${msg.recvID} ` +
        `contentType=${msg.contentType} clientMsgID=${msg.clientMsgID} ` +
        `ex=${ex ? ex.slice(0, 300) : "<empty>"} attachedInfo=${attachedInfo ? attachedInfo.slice(0, 200) : "<empty>"} ` +
        `isDigitalTwin=${isDigitalTwinMessage(msg)}`
    );
  }
  // === END DIAGNOSTIC ===

  if (source === "offline" && !client.config.processOfflineMessages) {
    shouldProcessInboundMessage(client.config.accountId, msg);
    await markInboundConversationAsRead(api, client, msg, "offline-sync");
    api.logger?.info?.(`[openim] ignore offline synced message: msgID=${msgID}`);
    return;
  }

  const msgTime = getMessageTimeMs(msg);
  const replayFilterActive = Date.now() <= client.replayFilterUntilMs;
  if (!client.config.processOfflineMessages && replayFilterActive && msgTime > 0 && msgTime < client.messageAcceptAfterMs) {
    shouldProcessInboundMessage(client.config.accountId, msg);
    await markInboundConversationAsRead(api, client, msg, "historical-replay");
    api.logger?.info?.(
      `[openim] ignore historical replay message: source=${source}, msgID=${msgID}, msgTime=${msgTime}, acceptAfter=${client.messageAcceptAfterMs}, filterUntil=${client.replayFilterUntilMs}`
    );
    return;
  }

  if (String(msg.sendID) === String(client.config.userID)) {
    return;
  }
  // Skip messages generated by a digital twin (数字分身).  The chat service
  // marks these with an `Ex` field (`openim_ext_type: "digital_twin"`).  If we
  // let another agent auto-reply to them, the digital twin and that agent loop.
  if (isDigitalTwinMessage(msg)) {
    await markInboundConversationAsRead(api, client, msg, "digital-twin");
    api.logger?.info?.(`[openim] ignore digital twin generated message (loop guard): clientMsgID=${msgID}, sendID=${msg.sendID}`);
    return;
  }
  if (!shouldProcessInboundMessage(client.config.accountId, msg)) {
    await markInboundConversationAsRead(api, client, msg, "duplicate");
    return;
  }

  const inbound = extractInboundBody(msg);
  if (!inbound.body) {
    api.logger?.info?.(
      `[openim] ignore unsupported message: contentType=${msg.contentType}, clientMsgID=${msg.clientMsgID || "unknown"}`
    );
    await markInboundConversationAsRead(api, client, msg, "unsupported");
    return;
  }

  const group = isGroupMessage(msg);
  const mentioned = group && isMentionedInGroup(msg, client.config.userID);
  const hasWhitelist = client.config.inboundWhitelist.length > 0;
  if (hasWhitelist) {
    if (!isWhitelistedSender(client, msg)) {
      await markInboundConversationAsRead(api, client, msg, "not-whitelisted");
      return;
    }
    if (group && !mentioned) {
      await markInboundConversationAsRead(api, client, msg, "not-mentioned");
      return;
    }
  } else if (group && client.config.requireMention && !mentioned) {
    await markInboundConversationAsRead(api, client, msg, "not-mentioned");
    return;
  }

  await markInboundConversationAsRead(api, client, msg, "accepted");

  const baseSessionKey = group ? `openim:group:${msg.groupID}`.toLowerCase() : `openim:${msg.sendID}`.toLowerCase();
  const cfg = api.config;

  const route =
    runtime.channel.routing?.resolveAgentRoute?.({
      cfg,
      sessionKey: baseSessionKey,
      channel: "openim",
      accountId: client.config.accountId,
    }) ?? { agentId: "main", sessionKey: baseSessionKey };

  const sessionKey = String(route?.sessionKey ?? baseSessionKey).trim() || baseSessionKey;

  const storePath =
    runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
      agentId: route.agentId,
    }) ?? "";

  const senderId = String(msg.sendID);
  const userInfo = await resolveOpenIMUserInfo({
    client,
    userID: senderId,
    fallbackName: String(msg.senderNickname || ""),
    log: (line) => api.logger?.warn?.(String(line)),
  });
  api.logger?.info?.(`[openim] user info for ${senderId}: name=${userInfo.name} username=${userInfo.username}`);

  const chatType: ChatType = group ? "group" : "direct";
  const fromLabel = userInfo.name || String(msg.senderNickname || msg.sendID);
  const timestamp = msg.sendTime || Date.now();
  const mediaResult = await materializeInboundMedia(inbound.media);
  const warningText = mediaResult.warnings.map((warning) => `[Media fetch failed] ${warning}`).join("\n");
  const rawBody = warningText ? `${inbound.body}\n${warningText}` : inbound.body;
  const body = buildTextEnvelope(runtime, cfg, fromLabel, senderId, timestamp, rawBody, chatType);

  if (mediaResult.warnings.length > 0) {
    for (const warning of mediaResult.warnings) {
      api.logger?.warn?.(`[openim] inbound media fetch failed: ${warning}`);
    }
  }

  const ctxPayload = {
    Body: body,
    RawBody: rawBody,
    From: group ? `openim:group:${msg.groupID}` : `openim:${msg.sendID}`,
    To: `openim:${client.config.userID}`,
    SessionKey: sessionKey,
    AccountId: client.config.accountId,
    ChatType: chatType,
    GroupId: group ? String(msg.groupID || "") : undefined,
    group_id: group ? String(msg.groupID || "") : undefined,
    groupId: group ? String(msg.groupID || "") : undefined,
    ChatId: group ? String(msg.groupID || "") : undefined,
    ConversationLabel: fromLabel,
    SenderName: fromLabel,
    SenderId: senderId,
    SenderUsername: userInfo.username,
    Provider: "openim",
    Surface: "openim",
    MessageSid: msg.clientMsgID || `openim-${Date.now()}`,
    Timestamp: timestamp,
    OriginatingChannel: "openim",
    OriginatingTo: `openim:${client.config.userID}`,
    CommandAuthorized: true,
    _openim: {
      accountId: client.config.accountId,
      isGroup: group,
      senderId,
      senderName: fromLabel,
      username: userInfo.username,
      groupId: String(msg.groupID || ""),
      messageKind: inbound.kind,
      mediaCount: inbound.media?.length ?? 0,
      source,
    },
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !group
        ? {
            sessionKey,
            channel: "openim",
            to: String(msg.sendID),
            accountId: client.config.accountId,
          }
        : undefined,
      onRecordError: (err: unknown) => api.logger?.warn?.(`[openim] recordInboundSession: ${String(err)}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "openim",
      accountId: client.config.accountId,
      direction: "inbound",
    });
  }

  const streamReply = createAgentStreamReplyController(client, msg, api.logger);

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string }, info?: { kind?: string }) => {
          if (!payload.text) return;
          try {
            if (info?.kind === "final") {
              await streamReply.final(payload.text);
            } else {
              await streamReply.updateAnswer(payload.text);
            }
          } catch (e: any) {
            api.logger?.error?.(`[openim] deliver failed: ${formatSdkError(e)}`);
          }
        },
        onReplyStart: async () => {
          try {
            await streamReply.start();
          } catch (e: any) {
            api.logger?.warn?.(`[openim] stream start failed: ${formatSdkError(e)}`);
          }
        },
        onError: (err: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[openim] ${info?.kind || "reply"} failed: ${String(err)}`);
          void streamReply.error(err);
        },
      },
      replyOptions: {
        disableBlockStreaming: false,
        images: mediaResult.images,
        onPartialReply: async (payload: { text?: string }) => {
          if (!payload.text) return;
          api.logger?.debug?.(
            `[openim] agent stream partial callback streamID=${streamReply.streamID} chars=${payload.text.length}`
          );
          try {
            await streamReply.updateAnswer(payload.text);
          } catch (e: any) {
            api.logger?.warn?.(`[openim] stream answer update failed: ${formatSdkError(e)}`);
          }
        },
        onReasoningStream: async (payload: { text?: string }) => {
          if (!payload.text) return;
          api.logger?.debug?.(
            `[openim] agent stream reasoning callback streamID=${streamReply.streamID} chars=${payload.text.length}`
          );
          try {
            await streamReply.updateReasoning(payload.text);
          } catch (e: any) {
            api.logger?.warn?.(`[openim] stream reasoning update failed: ${formatSdkError(e)}`);
          }
        },
        onFinalTextOverride: async (payload: { text?: string }) => {
          if (!payload.text) return;
          api.logger?.debug?.(
            `[openim] agent stream final override streamID=${streamReply.streamID} chars=${payload.text.length}`
          );
          try {
            await streamReply.updateAnswer(payload.text);
          } catch (e: any) {
            api.logger?.warn?.(`[openim] stream final override failed: ${formatSdkError(e)}`);
          }
        },
      },
    });
    if (streamReply.hasContent()) {
      await streamReply.final();
    }
  } catch (err: any) {
    api.logger?.error?.(`[openim] dispatch failed: ${formatSdkError(err)}`);
    try {
      await streamReply.error(err);
      const errMsg = formatSdkError(err);
      await sendReplyFromInbound(client, msg, `Processing failed: ${errMsg.slice(0, 80)}`);
    } catch {
      // ignore secondary send errors
    }
  }
}
