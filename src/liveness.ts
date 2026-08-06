import type { OpenIMAccountConfig, OpenIMClientState } from "./types";

/** 静默假死判定阈值：超过该时长未收到任何消息（含连接成功）即视为连接失效。 */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 180_000; // 3 分钟
/** 存活检测轮询间隔：定时检查 lastMessageSeenMs 是否过期。 */
export const LIVENESS_CHECK_INTERVAL_MS = 30_000;

/** 解析账号级别的存活检测阈值，未配置时使用默认值。 */
export function resolveLivenessTimeoutMs(config: OpenIMAccountConfig): number {
  return config.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
}

/**
 * 判断当前连接是否应因"静默假死"被强制重连。
 *
 * 条件（全部满足才返回 true）：
 * 1. 存在重连控制器且未被显式停止；
 * 2. 当前没有正在进行的重连（避免重复触发）；
 * 3. 距最近一次收到消息（或连接成功）已超过阈值。
 *
 * 该函数为纯函数，不依赖定时器或外部状态，便于单元测试。
 */
export function shouldForceReconnect(
  state: OpenIMClientState,
  now: number,
  timeoutMs: number
): boolean {
  const reconnect = state.reconnect;
  if (!reconnect || reconnect.stopped || reconnect.running) return false;
  const idleMs = now - state.lastMessageSeenMs;
  return idleMs >= timeoutMs;
}
