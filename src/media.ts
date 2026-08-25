import type { MessageItem } from "@openim/client-sdk";
import { File } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getRecvAndGroupID } from "./targets";
import { formatSdkError } from "./utils";
import type { OpenIMClientState, ParsedTarget } from "./types";

/** 单次 sendMessage 的硬超时，避免 SDK 调用无限挂起导致回复静默丢失（偶发"已读不回"的可疑点）。 */
const SEND_MESSAGE_TIMEOUT_MS = 15_000;

/** 发送失败重试次数（借鉴 orange wechat channel 的传输层重试思路）。 */
const SEND_MAX_ATTEMPTS = 3;
/** 重试退避基数（指数退避：base * 2^attempt）。 */
const SEND_RETRY_BASE_MS = 400;

/** 发送失败自愈钩子：由 clients.ts 注册，用于超时/重试耗尽后主动触发连接重建。 */
let sendFailureHandler: ((accountId: string) => void) | null = null;
export function registerSendFailureHandler(handler: (accountId: string) => void): void {
  sendFailureHandler = handler;
}

function withSendTimeout<T>(p: Promise<T>, label: string, logger?: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`sendMessage timed out after ${SEND_MESSAGE_TIMEOUT_MS}ms (${label})`);
      (err as any).code = "SEND_TIMEOUT";
      logger?.error?.(`[openim][send] ${label} TIMEOUT after ${SEND_MESSAGE_TIMEOUT_MS}ms`);
      reject(err);
    }, SEND_MESSAGE_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/**
 * 判断错误是否可重试（瞬时/传输层错误）：
 * - 超时（SEND_TIMEOUT）
 * - 网络/连接类（ECONNRESET/ETIMEDOUT/EPIPE/network/connection/socket）
 * 消息格式错误、token 失效等不可重试，直接抛出。
 */
function isRetryableSendError(e: any): boolean {
  const code = e?.code ?? "";
  const msg = (e?.message ?? "").toLowerCase();
  if (code === "SEND_TIMEOUT") return true;
  return ["econnreset", "etimedout", "epipe", "econnrefused", "network", "connection", "socket", "timeout", "broken pipe"].some((k) => msg.includes(k));
}

/**
 * 带超时 + 指数退避重试的 sendMessage（借鉴 orange wechat channel 的发送可靠性设计）。
 * 重试耗尽后，通知自愈钩子主动触发连接重建，避免被动等待存活检测或重启。
 */
async function sendMessageWithRetry(
  client: OpenIMClientState,
  payload: { recvID: string; groupID: string; message: any },
  label: string
): Promise<void> {
  const logger = (client as any).logger;
  let lastErr: any;
  let recoveryRequested = false;
  for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = SEND_RETRY_BASE_MS * 2 ** (attempt - 1);
      logger?.warn?.(`[openim][send] ${label} retry attempt ${attempt + 1}/${SEND_MAX_ATTEMPTS} after ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      await withSendTimeout(client.sdk.sendMessage(payload), label, logger);
      return;
    } catch (e: any) {
      lastErr = e;
      // A timed-out SDK request can remain parked in the SDK's internal WS
      // queue even though this wrapper rejects.  Ask the client supervisor to
      // rebuild the connection immediately so queued requests are cancelled;
      // otherwise every later stream frame would wait behind the same zombie
      // request until all retries are exhausted.
      if (e?.code === "SEND_TIMEOUT" && !recoveryRequested && sendFailureHandler) {
        recoveryRequested = true;
        try { sendFailureHandler(client.config.accountId); } catch { /* ignore */ }
      }
      if (!isRetryableSendError(e)) {
        logger?.warn?.(`[openim][send] ${label} non-retryable error, giving up: ${formatSdkError(e)}`);
        throw e;
      }
      logger?.warn?.(`[openim][send] ${label} retryable error (attempt ${attempt + 1}/${SEND_MAX_ATTEMPTS}): ${formatSdkError(e)}`);
    }
  }
  // 重试耗尽：通知自愈钩子（连接可能已半死）
  if (sendFailureHandler) {
    try { sendFailureHandler(client.config.accountId); } catch { /* ignore */ }
  }
  throw lastErr;
}

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

function toLocalPath(input: string): string {
  const raw = input.trim();
  if (raw.startsWith("file://")) return decodeURIComponent(raw.slice("file://".length));
  return raw;
}

function guessMime(pathOrName: string, fallback = "application/octet-stream"): string {
  const ext = extname(pathOrName).toLowerCase();
  const table: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".json": "application/json",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return table[ext] || fallback;
}

function inferNameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const name = basename(u.pathname || "");
    return name || fallback;
  } catch {
    return fallback;
  }
}

async function readLocalAsFile(pathInput: string, forcedName?: string): Promise<{
  file: File;
  filePath: string;
  fileName: string;
  size: number;
  mime: string;
}> {
  const filePath = toLocalPath(pathInput);
  const st = await stat(filePath);
  const data = await readFile(filePath);
  const fileName = forcedName?.trim() || basename(filePath) || `file-${Date.now()}`;
  const mime = guessMime(fileName);
  const file = new File([data], fileName, { type: mime });
  return { file, filePath, fileName, size: st.size, mime };
}

export async function sendTextToTarget(client: OpenIMClientState, target: ParsedTarget, text: string): Promise<void> {
  const targetLabel = target.kind === "user" ? `user:${target.id}` : `group:${target.id}`;
  const log = (client as any).logger?.debug?.bind((client as any).logger);
  log?.(`[openim][send] sendTextToTarget begin: account=${client.config.accountId} target=${targetLabel} textChars=${text.length}`);
  const created = await client.sdk.createTextMessage(text);
  const message = created?.data;
  if (!message) {
    (client as any).logger?.error?.(`[openim][send] sendTextToTarget FAILED: createTextMessage returned empty (account=${client.config.accountId} target=${targetLabel})`);
    throw new Error("createTextMessage failed");
  }

  const recvID = target.kind === "user" ? target.id : "";
  const groupID = target.kind === "group" ? target.id : "";

  const t0 = Date.now();
  try {
    await sendMessageWithRetry(
      client,
      { recvID, groupID, message },
      `sendTextToTarget account=${client.config.accountId} target=${targetLabel}`
    );
    const costMs = Date.now() - t0;
    (client as any).logger?.info?.(`[openim][send] sendTextToTarget OK: account=${client.config.accountId} target=${targetLabel} textChars=${text.length} costMs=${costMs}`);
  } catch (e: any) {
    const costMs = Date.now() - t0;
    (client as any).logger?.error?.(`[openim][send] sendTextToTarget FAILED: account=${client.config.accountId} target=${targetLabel} costMs=${costMs} error=${formatSdkError(e)}`);
    throw e;
  }
}

export async function sendCustomToTarget(
  client: OpenIMClientState,
  target: ParsedTarget,
  data: unknown,
  description = "",
  extension = ""
): Promise<void> {
  const targetLabel = target.kind === "user" ? `user:${target.id}` : `group:${target.id}`;
  const extType = (data && typeof data === "object" && (data as any).openim_ext_type) || "<none>";
  (client as any).logger?.debug?.(`[openim][send] sendCustomToTarget begin: account=${client.config.accountId} target=${targetLabel} extType=${extType} description="${description}"`);
  const created = await client.sdk.createCustomMessage({
    data: JSON.stringify(data),
    description,
    extension,
  });
  const message = created?.data;
  if (!message) {
    (client as any).logger?.error?.(`[openim][send] sendCustomToTarget FAILED: createCustomMessage returned empty (account=${client.config.accountId} target=${targetLabel} extType=${extType})`);
    throw new Error("createCustomMessage failed");
  }

  const { recvID, groupID } = getRecvAndGroupID(target);
  const t0 = Date.now();
  try {
    await sendMessageWithRetry(
      client,
      { recvID, groupID, message },
      `sendCustomToTarget account=${client.config.accountId} target=${targetLabel} extType=${extType}`
    );
    const costMs = Date.now() - t0;
    (client as any).logger?.info?.(`[openim][send] sendCustomToTarget OK: account=${client.config.accountId} target=${targetLabel} extType=${extType} description="${description}" costMs=${costMs}`);
  } catch (e: any) {
    const costMs = Date.now() - t0;
    (client as any).logger?.error?.(`[openim][send] sendCustomToTarget FAILED: account=${client.config.accountId} target=${targetLabel} extType=${extType} costMs=${costMs} error=${formatSdkError(e)}`);
    throw e;
  }
}

export async function sendImageToTarget(client: OpenIMClientState, target: ParsedTarget, image: string): Promise<void> {
  const input = image.trim();
  if (!input) throw new Error("image is empty");

  let message: MessageItem | undefined;
  if (isUrl(input)) {
    const name = inferNameFromUrl(input, "image.jpg");
    const pic = {
      uuid: randomUUID(),
      type: guessMime(name, "image/jpeg"),
      size: 0,
      width: 0,
      height: 0,
      url: input,
    };
    const created = await client.sdk.createImageMessageByURL({
      sourcePicture: pic,
      bigPicture: { ...pic },
      snapshotPicture: { ...pic },
      sourcePath: name,
    });
    message = created?.data;
  } else {
    const local = await readLocalAsFile(input);
    const pic = {
      uuid: randomUUID(),
      type: local.mime,
      size: local.size,
      width: 0,
      height: 0,
      url: "",
    };
    const created = await client.sdk.createImageMessageByFile({
      sourcePicture: pic,
      bigPicture: { ...pic },
      snapshotPicture: { ...pic },
      sourcePath: local.filePath,
      file: local.file,
    });
    message = created?.data;
  }

  if (!message) throw new Error("createImageMessage failed");
  const { recvID, groupID } = getRecvAndGroupID(target);
  await client.sdk.sendMessage({ recvID, groupID, message });
}

export async function sendVideoToTarget(
  client: OpenIMClientState,
  target: ParsedTarget,
  video: string,
  name?: string
): Promise<void> {
  const input = video.trim();
  if (!input) throw new Error("video is empty");
  // Product policy: do not send OpenIM video messages; send videos as file messages.
  await sendFileToTarget(client, target, input, name);
}

export async function sendFileToTarget(
  client: OpenIMClientState,
  target: ParsedTarget,
  filePathOrUrl: string,
  name?: string
): Promise<void> {
  const input = filePathOrUrl.trim();
  if (!input) throw new Error("file is empty");

  let message: MessageItem | undefined;
  if (isUrl(input)) {
    const fileName = name?.trim() || inferNameFromUrl(input, "file.bin");
    const created = await client.sdk.createFileMessageByURL({
      filePath: fileName,
      fileName,
      uuid: randomUUID(),
      sourceUrl: input,
      fileSize: 0,
      fileType: guessMime(fileName),
    });
    message = created?.data;
  } else {
    const local = await readLocalAsFile(input, name);
    const created = await client.sdk.createFileMessageByFile({
      filePath: local.filePath,
      fileName: local.fileName,
      uuid: randomUUID(),
      sourceUrl: "",
      fileSize: local.size,
      fileType: local.mime,
      file: local.file,
    });
    message = created?.data;
  }

  if (!message) throw new Error("createFileMessage failed");
  const { recvID, groupID } = getRecvAndGroupID(target);
  await client.sdk.sendMessage({ recvID, groupID, message });
}
