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
  /**
   * 冷启动历史同步丢弃窗口的截止时间戳。
   * login（首次或重连重登）成功后立即进入该窗口：窗口内所有 offline 来源的历史消息
   * 一律静默丢弃、不 markAsRead、不 dispatch，避免 SDK 冷启动自动拉取的历史会话同步
   * （seq 从 2 涨到 N 的那一段）触发补齐循环/占用磁盘。窗口结束后恢复正常的离线消息处理。
   * 历史消息丢了就丢了，orange 重启场景不需要这些历史。
   * 可选：未设置（undefined/0）时视为窗口已过，正常处理所有消息。
   */
  coldStartHistoryUntilMs?: number;
  /** 最近一次收到消息（或连接成功）的时间戳，用于静默假死存活检测。 */
  lastMessageSeenMs: number;
  /**
   * 最近一次通过 reestablishSession 恢复会话的时间戳（去重用）。
   * onConnectSuccess 由每次 login 成功触发，reestablishSession 内部的 login 也会回调它；
   * 用该字段保证同一断连窗口（30s）内只恢复一次，切断 login 死循环。
   */
  lastSessionRestoreMs?: number;
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
