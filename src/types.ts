import type { ApiService, CallbackEvent, MessageItem } from "@openim/client-sdk";

export type ChatType = "direct" | "group";

export interface OpenIMAccountConfig {
  accountId: string;
  enabled: boolean;
  userID: string;
  token?: string;
  wsAddr: string;
  apiAddr: string;
  platformID: number;
  adminSecret: string;
  adminUserID: string;
  chatApiAddr?: string;
  chatToken?: string;
  requireMention: boolean;
  processOfflineMessages: boolean;
  inboundWhitelist: string[];
  /** 可选：覆盖静默假死存活检测阈值（毫秒），默认 180000（3 分钟）。 */
  livenessTimeoutMs?: number;
  /** 可选：覆盖发侧存活检测阈值（毫秒），默认 180000（3 分钟）。仅当启用发侧探测时生效。 */
  sendLivenessTimeoutMs?: number;
}

export interface OpenIMClientState {
  sdk: ApiService;
  config: OpenIMAccountConfig;
  messageAcceptAfterMs: number;
  replayFilterUntilMs: number;
  /** 最近一次收到消息（或连接成功）的时间戳，用于静默假死存活检测。 */
  lastMessageSeenMs: number;
  /**
   * 最近一次成功向对端（orange 主机）写回/投递消息的时间戳，用于发侧存活检测。
   * 若长期未成功写回，说明本进程与 orange 之间的管道可能已断裂（反向存活探测）。
   */
  lastFlushMs?: number;
  /**
   * 标记本进程与 orange 主机之间的 stdio 管道是否已断裂（例如写入时收到 EPIPE）。
   * 一旦置位，存活检测会立即触发重连，无需等待超时。相当于 openclaw-lark 的 probe() 反向健康检查。
   */
  stdoutBroken?: boolean;
  /** 管道断裂发生时的时间戳。 */
  lastStdoutErrorMs?: number;
  /** 管道断裂后是否已调度进程退出（去重用，避免重复 exit）。 */
  stdoutExitScheduled?: boolean;
  /** 存活检测定时器；超过 LIVENESS_TIMEOUT_MS 未收到消息则主动重连。 */
  livenessTimer?: ReturnType<typeof setInterval>;
  handlers: {
    onRecvNewMessage: (event: CallbackEvent<MessageItem>) => void;
    onRecvNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
    onRecvOfflineNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
    onUserTokenExpired?: (event: CallbackEvent<unknown>) => void;
    onUserTokenInvalid?: (event: CallbackEvent<unknown>) => void;
    onKickedOffline?: (event: CallbackEvent<unknown>) => void;
    onConnectFailed?: (event: CallbackEvent<unknown>) => void;
    onConnectSuccess?: (event: CallbackEvent<unknown>) => void;
  };
  reconnect?: {
    timer?: ReturnType<typeof setTimeout>;
    attempts: number;
    running: boolean;
    stopped: boolean;
  };
}

export interface ParsedTarget {
  kind: "user" | "group";
  id: string;
}

export interface InboundMediaItem {
  kind: "image" | "video" | "file";
  url?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  snapshotUrl?: string;
}

export interface InboundBodyResult {
  body: string;
  kind: "text" | "image" | "video" | "file" | "mixed" | "unknown";
  media?: InboundMediaItem[];
}
