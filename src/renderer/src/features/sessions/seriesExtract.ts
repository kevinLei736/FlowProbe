import type { Frame, ProtoTemplate } from '@shared/protocol'
import { base64ToBytes } from './frameExport'
import { parseByTemplate, pickTemplate } from './protoParse'

export interface SeriesPoint {
  ts: number
  value: number
}

export interface Series {
  /** 字段名，作为图例与 key */
  name: string
  unit?: string
  points: SeriesPoint[]
}

/**
 * 从报文里抽取被标记「绘制曲线」的字段，按字段名聚合成多条序列。
 *
 * 只扫描最近 limit 条报文：曲线是用来看趋势的，几万条历史全画既没意义也拖慢渲染。
 */
export function extractSeries(
  frames: Frame[],
  templates: ProtoTemplate[],
  selection: string,
  limit = 1000
): Series[] {
  if (!selection) return []
  const chartTemplates = templates.filter((t) => t.fields.some((f) => f.chart === true))
  if (chartTemplates.length === 0) return []

  const start = Math.max(0, frames.length - limit)
  const bucket = new Map<string, Series>()

  for (let i = start; i < frames.length; i++) {
    const fr = frames[i]
    if (fr.direction === 'system' || !fr.rawBase64) continue
    const bytes = base64ToBytes(fr.rawBase64)
    if (bytes.length === 0) continue
    const dir = fr.direction === 'tx' ? 'tx' : 'rx'
    const tpl =
      selection === 'auto'
        ? pickTemplate(templates, bytes, dir)
        : templates.find((t) => t.id === selection) ?? null
    if (!tpl || !tpl.fields.some((f) => f.chart === true)) continue

    const parsed = parseByTemplate(bytes, tpl)
    for (const pf of parsed.fields) {
      if (pf.chart !== true || pf.num === undefined || !Number.isFinite(pf.num)) continue
      let s = bucket.get(pf.name)
      if (!s) {
        s = { name: pf.name, unit: pf.unit, points: [] }
        bucket.set(pf.name, s)
      }
      s.points.push({ ts: fr.ts, value: pf.num })
    }
  }

  return [...bucket.values()].filter((s) => s.points.length > 0)
}

/** 序列导出为 CSV：时间一列，每个字段一列，按时间戳对齐 */
export function seriesToCsv(series: Series[]): string {
  const tsSet = new Set<number>()
  for (const s of series) for (const p of s.points) tsSet.add(p.ts)
  const stamps = [...tsSet].sort((a, b) => a - b)
  const maps = series.map((s) => {
    const m = new Map<number, number>()
    for (const p of s.points) m.set(p.ts, p.value)
    return m
  })
  const head = ['时间', ...series.map((s) => (s.unit ? s.name + '(' + s.unit + ')' : s.name))].join(',')
  const rows = stamps.map((ts) =>
    [new Date(ts).toISOString(), ...maps.map((m) => (m.has(ts) ? String(m.get(ts)) : ''))].join(',')
  )
  return [head, ...rows].join('\r\n')
}

export interface SeriesStat {
  name: string
  unit?: string
  last: number
  min: number
  max: number
  avg: number
  count: number
}

export function seriesStats(series: Series[]): SeriesStat[] {
  return series.map((s) => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let sum = 0
    for (const p of s.points) {
      if (p.value < min) min = p.value
      if (p.value > max) max = p.value
      sum += p.value
    }
    return {
      name: s.name,
      unit: s.unit,
      last: s.points[s.points.length - 1]?.value ?? 0,
      min,
      max,
      avg: sum / s.points.length,
      count: s.points.length
    }
  })
}
