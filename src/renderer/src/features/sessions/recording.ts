import type {
  ConnectionKind,
  Frame,
  RecordedFrame,
  RecordingFile
} from '@shared/protocol'

/**
 * 录制文件格式标识。
 *
 * 写入只用新标识；读取额外接受改名前的 debug-toolbox-recording ——
 * 这个字段是加载准入条件，只认新值会让用户改名前导出的文件全部打不开。
 */
export const RECORDING_FORMAT = 'flowprobe-recording' as const
const ACCEPTED_FORMATS: string[] = [RECORDING_FORMAT, 'debug-toolbox-recording']

/**
 * 把一段报文打包成录制文件。
 *
 * 存相对时间（offsetMs）而不是绝对时间戳：录制的价值在于「时序」，
 * 相对时间让文件在任何时候回放都能复现原始节奏，也便于人工编辑。
 */
export function framesToRecording(
  frames: Frame[],
  sessionName: string,
  sessionKind: ConnectionKind,
  note?: string
): RecordingFile {
  const startedAt = frames[0]?.ts ?? Date.now()
  const last = frames[frames.length - 1]?.ts ?? startedAt
  return {
    format: RECORDING_FORMAT,
    version: 1,
    sessionName,
    sessionKind,
    startedAt,
    durationMs: Math.max(0, last - startedAt),
    note,
    frames: frames.map((f) => ({
      offsetMs: Math.max(0, f.ts - startedAt),
      direction: f.direction,
      encoding: f.encoding,
      rawBase64: f.rawBase64,
      text: f.text,
      size: f.size,
      peerLabel: f.peerLabel,
      level: f.level,
      conn: f.conn
    }))
  }
}

export function recordingToJson(rec: RecordingFile): string {
  return JSON.stringify(rec, null, 2)
}

/** 校验并解析录制文件；返回字符串表示错误原因 */
export function parseRecording(text: string): RecordingFile | string {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return '不是合法的 JSON：' + (e as Error).message
  }
  if (!data || typeof data !== 'object') return '文件内容不是对象'
  const rec = data as Partial<RecordingFile>
  if (!ACCEPTED_FORMATS.includes(rec.format as string))
    return '不是本工具的录制文件（缺少 format 标识）'
  if (rec.version !== 1) return '录制文件版本不支持：' + String(rec.version)
  if (!Array.isArray(rec.frames)) return '缺少 frames 数组'
  // 时序可能被人工编辑打乱，统一按 offsetMs 排序后再回放
  const frames = [...rec.frames]
    .filter((f): f is RecordedFrame => !!f && typeof f.offsetMs === 'number')
    .sort((a, b) => a.offsetMs - b.offsetMs)
  if (frames.length === 0) return '录制文件里没有报文'
  return {
    format: RECORDING_FORMAT,
    version: 1,
    sessionName: String(rec.sessionName ?? '未知会话'),
    sessionKind: (rec.sessionKind ?? 'tcp-client') as ConnectionKind,
    startedAt: Number(rec.startedAt ?? Date.now()),
    durationMs: Number(rec.durationMs ?? frames[frames.length - 1].offsetMs),
    note: rec.note,
    frames
  }
}

/** 把录制帧还原成时间轴可渲染的 Frame，打上 replay 标记以区别真实链路 */
export function recordedToFrame(rf: RecordedFrame, sessionId: string, baseTs: number): Frame {
  return {
    id: 'replay-' + Math.random().toString(36).slice(2) + '-' + rf.offsetMs,
    sessionId,
    direction: rf.direction,
    ts: baseTs + rf.offsetMs,
    size: rf.size,
    encoding: rf.encoding,
    rawBase64: rf.rawBase64,
    text: rf.text,
    peerLabel: rf.peerLabel,
    level: rf.level,
    conn: rf.conn,
    replay: true
  }
}

export interface RecordingSummary {
  total: number
  tx: number
  rx: number
  system: number
  durationMs: number
  bytes: number
}

export function summarize(rec: RecordingFile): RecordingSummary {
  let tx = 0
  let rx = 0
  let system = 0
  let bytes = 0
  for (const f of rec.frames) {
    if (f.direction === 'tx') tx++
    else if (f.direction === 'rx') rx++
    else system++
    bytes += f.size ?? 0
  }
  return { total: rec.frames.length, tx, rx, system, durationMs: rec.durationMs, bytes }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return ms + ' ms'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + ' 秒'
  const m = Math.floor(s / 60)
  return m + ' 分 ' + Math.round(s - m * 60) + ' 秒'
}

/**
 * 回放调度器。
 *
 * 用逐帧 setTimeout 追赶「应到时刻」，而不是固定间隔累加：
 * 定时器本身有抖动，累加会让长录制越走越偏；对齐到起点则误差不累积。
 */
export class ReplayPlayer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private index = 0
  private startedAt = 0
  /** 已消耗的录制内时间，暂停时累计 */
  private consumed = 0
  private disposed = false

  constructor(
    private frames: RecordedFrame[],
    private speed: number,
    private onFrame: (rf: RecordedFrame) => void,
    private onProgress: (index: number, elapsedMs: number) => void,
    private onDone: () => void
  ) {}

  get position(): number {
    return this.index
  }

  start(): void {
    if (this.disposed) return
    this.startedAt = Date.now()
    this.schedule()
  }

  pause(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.consumed += (Date.now() - this.startedAt) * this.speed
  }

  resume(): void {
    if (this.disposed) return
    this.startedAt = Date.now()
    this.schedule()
  }

  setSpeed(speed: number): void {
    // 变速前先结算已走过的录制内时间，避免旧倍速的进度被重新按新倍速计算
    if (this.timer) {
      this.consumed += (Date.now() - this.startedAt) * this.speed
      clearTimeout(this.timer)
      this.timer = null
      this.speed = speed
      this.startedAt = Date.now()
      this.schedule()
    } else {
      this.speed = speed
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** 当前已走到的录制内时间（毫秒） */
  private elapsed(): number {
    return this.timer ? this.consumed + (Date.now() - this.startedAt) * this.speed : this.consumed
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.index >= this.frames.length) {
      this.onDone()
      return
    }
    const target = this.frames[this.index].offsetMs
    const wait = Math.max(0, (target - this.elapsed()) / this.speed)
    this.timer = setTimeout(() => {
      if (this.disposed) return
      // 一次性吐出所有已到期的帧：高频录制在低倍速下也不会因定时器精度丢帧
      const now = this.elapsed()
      while (this.index < this.frames.length && this.frames[this.index].offsetMs <= now + 1) {
        this.onFrame(this.frames[this.index])
        this.index++
      }
      this.onProgress(this.index, now)
      this.schedule()
    }, wait)
  }
}
