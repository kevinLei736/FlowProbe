import type { Frame, HttpLogEntry, Session } from '@shared/protocol'
import { UNGROUPED } from '../../store/useSessionOrg'

export interface Bucket {
  /** 桶起始时间戳（毫秒，已按 stepMs 对齐） */
  ts: number
  txBytes: number
  rxBytes: number
  txFrames: number
  rxFrames: number
}

/**
 * 把报文按固定时间桶聚合成吞吐序列。
 *
 * 桶宽默认 1 秒、窗口默认最近 3 分钟：看板要的是「刚刚发生了什么」，
 * 更长的历史交给导出 CSV，避免每次渲染都扫全量报文。
 */
export function bucketize(frames: Frame[], stepMs = 1000, windowMs = 180000, now = Date.now()): Bucket[] {
  const from = Math.floor((now - windowMs) / stepMs) * stepMs
  const map = new Map<number, Bucket>()
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]
    if (f.ts < from) break // 报文按时间递增，早于窗口即可停止回溯
    if (f.direction === 'system') continue
    const key = Math.floor(f.ts / stepMs) * stepMs
    let b = map.get(key)
    if (!b) {
      b = { ts: key, txBytes: 0, rxBytes: 0, txFrames: 0, rxFrames: 0 }
      map.set(key, b)
    }
    if (f.direction === 'tx') {
      b.txBytes += f.size ?? 0
      b.txFrames += 1
    } else {
      b.rxBytes += f.size ?? 0
      b.rxFrames += 1
    }
  }
  // 补齐空桶，折线才不会把静默期连成一条斜线
  const out: Bucket[] = []
  for (let t = from; t <= now; t += stepMs) {
    out.push(map.get(t) ?? { ts: t, txBytes: 0, rxBytes: 0, txFrames: 0, rxFrames: 0 })
  }
  return out
}

export interface SizeBin {
  label: string
  count: number
}

/** 报文长度分布。分档按常见 MTU 与协议帧长切，便于一眼看出是小包还是大包为主。 */
export function sizeHistogram(frames: Frame[]): SizeBin[] {
  const edges = [8, 32, 64, 128, 256, 512, 1024, 1500]
  const labels = ['≤8', '9-32', '33-64', '65-128', '129-256', '257-512', '513-1K', '1K-1.5K', '>1.5K']
  const counts = new Array(labels.length).fill(0) as number[]
  for (const f of frames) {
    if (f.direction === 'system') continue
    const size = f.size ?? 0
    let idx = edges.length
    for (let i = 0; i < edges.length; i++) {
      if (size <= edges[i]) {
        idx = i
        break
      }
    }
    counts[idx] += 1
  }
  return labels.map((label, i) => ({ label, count: counts[i] })).filter((b, i) => b.count > 0 || i < 6)
}

export interface Slice {
  label: string
  value: number
  color?: string
}

/** 会话状态分布，用于看板顶部的健康环图 */
export function statusSlices(sessions: Session[]): Slice[] {
  const order: Array<[string, string]> = [
    ['connected', '已连接'],
    ['listening', '监听中'],
    ['connecting', '连接中'],
    ['idle', '未启动'],
    ['closed', '已关闭'],
    ['error', '错误']
  ]
  return order
    .map(([key, label]) => ({ label, value: sessions.filter((s) => s.status === key).length }))
    .filter((s) => s.value > 0)
}

/** 按分组聚合流量，回答「哪个项目最吵」 */
export interface GroupStat {
  name: string
  sessions: number
  txBytes: number
  rxBytes: number
  frames: number
}

export function groupStats(sessions: Session[]): GroupStat[] {
  const map = new Map<string, GroupStat>()
  for (const s of sessions) {
    const name = (s.group ?? '').trim() || UNGROUPED
    let g = map.get(name)
    if (!g) {
      g = { name, sessions: 0, txBytes: 0, rxBytes: 0, frames: 0 }
      map.set(name, g)
    }
    g.sessions += 1
    g.txBytes += s.metrics.txBytes
    g.rxBytes += s.metrics.rxBytes
    g.frames += s.metrics.txFrames + s.metrics.rxFrames
  }
  return [...map.values()].sort((a, b) => b.txBytes + b.rxBytes - (a.txBytes + a.rxBytes))
}

/** HTTP Mock 请求日志的状态码分布 */
export function statusCodeSlices(logs: HttpLogEntry[]): Slice[] {
  const buckets = new Map<string, number>()
  for (const l of logs) {
    const family = Math.floor(l.status / 100) * 100
    const key = family >= 100 ? String(family / 100) + 'xx' : '其他'
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const order = ['2xx', '3xx', '4xx', '5xx', '1xx', '其他']
  return order
    .filter((k) => buckets.has(k))
    .map((k) => ({ label: k, value: buckets.get(k) ?? 0 }))
}

export interface LatencyStat {
  count: number
  min: number
  max: number
  avg: number
  p50: number
  p95: number
}

/**
 * 响应耗时统计。取 p50/p95 而不是只看均值：
 * 均值会被个别慢请求拉高，p95 才能说明「大多数请求有多慢」。
 */
export function latencyStat(durations: number[]): LatencyStat | null {
  if (durations.length === 0) return null
  const sorted = [...durations].sort((a, b) => a - b)
  const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95)
  }
}

/** 路径命中排行，快速定位 Mock 里最热的接口 */
export function topPaths(logs: HttpLogEntry[], limit = 8): { path: string; count: number; errRate: number }[] {
  const map = new Map<string, { count: number; err: number }>()
  for (const l of logs) {
    const key = l.method + ' ' + l.path
    const item = map.get(key) ?? { count: 0, err: 0 }
    item.count += 1
    if (l.status >= 400) item.err += 1
    map.set(key, item)
  }
  return [...map.entries()]
    .map(([path, v]) => ({ path, count: v.count, errRate: v.count ? v.err / v.count : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

export function formatRate(bytesPerSec: number): string {
  return formatBytes(Math.round(bytesPerSec)) + '/s'
}

/** 看板数据导出为 CSV：时间、发送字节、接收字节、帧数 */
export function bucketsToCsv(buckets: Bucket[]): string {
  const head = ['时间', '发送字节', '接收字节', '发送帧', '接收帧'].join(',')
  const rows = buckets.map((b) =>
    [new Date(b.ts).toISOString(), b.txBytes, b.rxBytes, b.txFrames, b.rxFrames].join(',')
  )
  return [head, ...rows].join('\r\n')
}
