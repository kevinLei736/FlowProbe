/**
 * 指数退避重连计时器。
 *
 * 固定间隔重连在对端长期不在时会一直刷屏、白耗资源。这里改为
 * base * 2^n 递增并封顶，同时加入抖动避免多个会话同时撞上来。
 */
export interface BackoffOptions {
  /** 首次重连等待（毫秒） */
  baseMs: number
  /** 单次等待上限（毫秒） */
  maxMs: number
  /** 最大尝试次数，0 或负数表示不限次 */
  maxAttempts: number
  /** 抖动比例 0..1，实际等待在 [wait*(1-j), wait] 之间 */
  jitter?: number
}

export function normalizeBackoff(cfg: {
  reconnectIntervalMs?: unknown
  reconnectMaxIntervalMs?: unknown
  reconnectMaxAttempts?: unknown
}): BackoffOptions {
  const baseMs = Math.max(200, Number(cfg.reconnectIntervalMs ?? 1000) || 1000)
  const rawMax = Number(cfg.reconnectMaxIntervalMs ?? 30000) || 30000
  return {
    baseMs,
    maxMs: Math.max(baseMs, rawMax),
    maxAttempts: Math.max(0, Number(cfg.reconnectMaxAttempts ?? 0) || 0),
    jitter: 0.2
  }
}

export class Backoff {
  private attempt = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private opts: BackoffOptions) {}

  update(opts: BackoffOptions): void {
    this.opts = opts
  }

  /** 已尝试次数（第一次重连前为 0） */
  get attempts(): number {
    return this.attempt
  }

  /** 是否还允许再试 */
  get exhausted(): boolean {
    return this.opts.maxAttempts > 0 && this.attempt >= this.opts.maxAttempts
  }

  /** 下一次等待时长，不推进计数（用于日志预告） */
  peekDelay(): number {
    return this.computeDelay(this.attempt)
  }

  private computeDelay(attempt: number): number {
    const raw = this.opts.baseMs * Math.pow(2, attempt)
    const capped = Math.min(raw, this.opts.maxMs)
    const j = this.opts.jitter ?? 0
    if (j <= 0) return Math.round(capped)
    const min = capped * (1 - j)
    return Math.round(min + Math.random() * (capped - min))
  }

  /**
   * 安排下一次重试。返回本次等待毫秒与第几次尝试；
   * 次数用尽时返回 null，由调用方决定放弃并报错。
   */
  schedule(run: () => void): { delayMs: number; attempt: number } | null {
    if (this.exhausted) return null
    const delayMs = this.computeDelay(this.attempt)
    this.attempt += 1
    this.cancel()
    this.timer = setTimeout(run, delayMs)
    return { delayMs, attempt: this.attempt }
  }

  /** 连接成功后调用，退避重新从头计算 */
  reset(): void {
    this.attempt = 0
    this.cancel()
  }

  /** 是否有一次重连正在等待触发 */
  get pending(): boolean {
    return this.timer !== null
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** 等待时长格式化：小于 1 秒显示毫秒，否则保留一位小数的秒 */
export function formatWait(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
