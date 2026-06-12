import { SessionType, type MessageItem } from "@openim/client-sdk";
import { sendTextToTarget } from "./media";
import type { ChatType, InboundBodyResult, InboundMediaItem, OpenIMClientState, ParsedTarget } from "./types";
import { resolveOpenIMUserInfo } from "./user";
import { formatSdkError } from "./utils";

const inboundDedup = new Map<string, number>();
const INBOUND_DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;

type ImagePart = { type: "image"; data: string; mimeType: string };

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

  if (inboundDedup.size > 2000) {
    for (const [k, ts] of inboundDedup.entries()) {
      if (now - ts > INBOUND_DEDUP_TTL_MS) inboundDedup.delete(k);
    }
  }

  return !(last && now - last < INBOUND_DEDUP_TTL_MS);
}

function isGroupMessage(msg: MessageItem): boolean {
  return msg.sessionType === SessionType.Group && !!msg.groupID;
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

export async function processInboundMessage(api: any, client: OpenIMClientState, msg: MessageItem): Promise<void> {
  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[openim] runtime.channel.reply not available");
    return;
  }

  if (String(msg.sendID) === String(client.config.userID)) {
    return;
  }
  if (!shouldProcessInboundMessage(client.config.accountId, msg)) {
    return;
  }

  const inbound = extractInboundBody(msg);
  if (!inbound.body) {
    api.logger?.info?.(
      `[openim] ignore unsupported message: contentType=${msg.contentType}, clientMsgID=${msg.clientMsgID || "unknown"}`
    );
    return;
  }

  const group = isGroupMessage(msg);
  const mentioned = group && isMentionedInGroup(msg, client.config.userID);
  const hasWhitelist = client.config.inboundWhitelist.length > 0;
  if (hasWhitelist) {
    if (!isWhitelistedSender(client, msg)) return;
    if (group && !mentioned) return;
  } else if (group && client.config.requireMention && !mentioned) {
    return;
  }

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

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string }) => {
          if (!payload.text) return;
          try {
            await sendReplyFromInbound(client, msg, payload.text);
          } catch (e: any) {
            api.logger?.error?.(`[openim] deliver failed: ${formatSdkError(e)}`);
          }
        },
        onError: (err: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[openim] ${info?.kind || "reply"} failed: ${String(err)}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: true,
        images: mediaResult.images,
      },
    });
  } catch (err: any) {
    api.logger?.error?.(`[openim] dispatch failed: ${formatSdkError(err)}`);
    try {
      const errMsg = formatSdkError(err);
      await sendReplyFromInbound(client, msg, `Processing failed: ${errMsg.slice(0, 80)}`);
    } catch {
      // ignore secondary send errors
    }
  }
}
