import type { OpenIMAccountConfig, OpenIMClientState } from "./types";

/** 静默假死判定阈值：超过该时长未收到任何消息（含连接成功）即视为连接失效。 */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 180_000; // 3 分钟
/** 发侧存活判定阈值：超过该时长未成功向对端（orange）写回任何消息即视为管道失效。 */
export const DEFAULT_SEND_LIVENESS_TIMEOUT_MS = 180_000; // 3 分钟
/** 存活检测轮询间隔：定时检查 lastMessageSeenMs / lastFlushMs 是否过期。 */
export const LIVENESS_CHECK_INTERVAL_MS = 30_000;

/** 解析账号级别的收侧存活检测阈值，未配置时使用默认值。 */
export function resolveLivenessTimeoutMs(config: OpenIMAccountConfig): number {
  return config.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
}

/** 解析账号级别的发侧存活检测阈值，未配置时使用默认值。 */
export function resolveSendLivenessTimeoutMs(config: OpenIMAccountConfig): number {
  return config.sendLivenessTimeoutMs ?? DEFAULT_SEND_LIVENESS_TIMEOUT_MS;
}

/**
 * 判断一个错误是否为"管道断裂"类错误（对端已关闭 stdio 管道）。
 * 典型为写入已关闭的 stdout/stderr 收到 EPIPE（Broken pipe）。
 * 抽成纯函数便于单元测试，也便于在 outbound 投递失败时复用。
 */
export function isPipeBrokenError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "EPIPE" || e.code === "ECONNRESET" || e.code === "ENOTCONN") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /EPIPE|broken pipe|write after end|socket (is )?closed/i.test(msg);
}

/**
 * 判断当前连接是否应因"静默假死"被强制重连。
 *
 * 触发条件（满足任一即返回 true，且必须存在重连控制器且未被停止、无正在进行的重连）：
 * 1. 收侧超时：距最近一次收到消息（或连接成功）已超过 recvTimeoutMs；
 * 2. 发侧超时（仅当 sendTimeoutMs 提供）：距最近一次成功写回对端已超过 sendTimeoutMs；
 * 3. 管道已断裂：stdoutBroken 已被标记（如写入时收到 EPIPE），无需等待超时立即重连。
 *
 * 该函数为纯函数，不依赖定时器或外部状态，便于单元测试。
 */
export function shouldForceReconnect(
  state: OpenIMClientState,
  now: number,
  recvTimeoutMs: number,
  sendTimeoutMs?: number
): boolean {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped || reconnect.running) return false;

  // 条件 3：管道已断裂，立即重连。
  if (state.stdoutBroken) return true;

  // 条件 1：收侧超时。
  const recvIdleMs = now - state.lastMessageSeenMs;
  if (recvIdleMs >= recvTimeoutMs) return true;

  // 条件 2：发侧超时（可选）。
  if (typeof sendTimeoutMs === "number" && typeof state.lastFlushMs === "number") {
    const sendIdleMs = now - state.lastFlushMs;
    if (sendIdleMs >= sendTimeoutMs) return true;
  }

  return false;
}

/** 标记本进程与 orange 的 stdio 管道已断裂（反向存活探测的落点）。 */
export function markStdoutBroken(state: OpenIMClientState, now: number): void {
  state.stdoutBroken = true;
  state.lastStdoutErrorMs = now;
}

/** 清除管道断裂标记（重连成功后调用）。 */
export function clearStdoutBroken(state: OpenIMClientState): void {
  state.stdoutBroken = false;
}

/** 记录一次成功向对端写回/投递的时间，用于发侧存活检测。 */
export function updateLastFlush(state: OpenIMClientState, now: number): void {
  state.lastFlushMs = now;
  // 成功写回说明管道是通的，顺带清除之前可能的误标记。
  if (state.stdoutBroken) state.stdoutBroken = false;
}

/** 便捷判断：管道是否已断裂。 */
export function isStdoutBroken(state: OpenIMClientState): boolean {
  return Boolean(state.stdoutBroken);
}

/**
 * 管道断裂后的进程级自愈：让 orange 重新拉起本插件以重建 stdio 通道。
 *
 * 当本进程与 orange 之间的 stdio 管道已断裂（stdoutBroken）时，仅重连 IM SDK
 * 无法恢复与 orange 的通信（reconnectAccount 只重建 IM 长连接，不重建 stdio 管道）。
 * 因此这里主动退出进程，交给 orange 的进程管理器重新 spawn 子进程，
 * 从而完整重建 stdin/stdout 这条控制通道。
 *
 * 退出通过可注入的 exitImpl 执行，默认 process.exit(1)，便于单元测试。
 * 退出前先置位 stdoutBroken，并避免重复调度（用 state 上的标记位去重）。
 */
export function scheduleStdoutBrokenExit(
  state: OpenIMClientState,
  exitImpl: (code: number) => void = process.exit
): void {
  if (!state.stdoutBroken) return;
  if (state.stdoutExitScheduled) return;
  state.stdoutExitScheduled = true;
  // 测试环境下可通过环境变量禁用真实退出，仅验证调度副作用。
  if (process.env.OPENIM_DISABLE_STDOUT_EXIT === "1") return;
  // 延迟一拍退出，确保当前错误日志/flush 已被上层处理，且避免同步退出打断调用栈。
  setTimeout(() => exitImpl(1), 0).unref?.();
}
