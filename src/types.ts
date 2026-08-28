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
  /** OpenIM SDK 日志级别。默认 Warn(3)，避免 SDK Debug 日志输出完整消息体。 */
  sdkLogLevel?: number;
  /** 可选：覆盖静默假死存活检测阈值（毫秒），默认 180000（3 分钟）。 */
  livenessTimeoutMs?: number;
  /** 可选：启用发侧存活检测并设置阈值（毫秒）。默认关闭，避免把业务空闲误判为断连。 */
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
  /** 最近一次收到消息（或连接成功）的时间戳，用于健康观测；正常空闲不触发重连。 */
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
  /**
   * 连接明确丢失的标志时间戳。仅当 SDK 触发明确的断连事件
   * （OnConnectFailed / OnKickedOffline / OnUserTokenInvalid / OnUserTokenExpired）
   * 时才置位，onConnectSuccess 时清除。
   *
   * 设计意图：存活检测（liveness）不应把"bot 长时间无消息"误判为"假死"而强制重连。
   * 真正的强制重连只依赖"连接明确丢失"这一信号，避免无异常时每 3 分钟无脑重连
   * （之前会把 bot 的安静期当作假死，反复 forceReconnect 叠加 SDK 自身重连，导致
   * system busy / PingInterval undefined 风暴）。
   */
  connectionLostAtMs?: number;
  /** 存活检测定时器；检查明确断连、发送侧超时和 stdio 断裂。 */
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
  /** SDK 的 on() 会追加监听器；该标记保证同一批回调只挂载一次。 */
  handlersAttached?: boolean;
  reconnect?: {
    timer?: ReturnType<typeof setTimeout>;
    attempts: number;
    running: boolean;
    stopped: boolean;
  };
  /** Account-scoped fresh-SDK recovery used by a terminal reply timeout. */
  requestReconnect?: (reason: string) => Promise<void>;
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
