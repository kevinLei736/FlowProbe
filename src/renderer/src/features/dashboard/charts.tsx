import { useMemo } from 'react'
import type { Bucket, SizeBin, Slice } from './metrics'
import { formatBytes } from './metrics'

/** 看板配色：与主界面同一套低饱和中性色，深浅主题下都不刺眼 */
export const SERIES_COLORS = ['#8fa8c8', '#c8a87f', '#9dc0a5', '#c090a8', '#a8a0c8', '#c8c08f']

const W = 600
const H = 140
const PAD_L = 44
const PAD_R = 8
const PAD_T = 8
const PAD_B = 18

/**
 * 双序列面积图（发送 / 接收）。同样用原生 SVG：
 * 桶数固定在两百个量级，路径字符串比引图表库更省。
 */
export function ThroughputChart({ buckets }: { buckets: Bucket[] }): JSX.Element {
  const max = useMemo(
    () => Math.max(1, ...buckets.map((b) => Math.max(b.txBytes, b.rxBytes))),
    [buckets]
  )
  const n = buckets.length
  const x = (i: number): number => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R))
  const y = (v: number): number => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B)

  const line = (key: 'txBytes' | 'rxBytes'): string =>
    buckets.map((b, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(b[key]).toFixed(1)).join(' ')
  const area = (key: 'txBytes' | 'rxBytes'): string =>
    line(key) + ' L' + x(n - 1).toFixed(1) + ' ' + y(0).toFixed(1) + ' L' + x(0).toFixed(1) + ' ' + y(0).toFixed(1) + ' Z'

  return (
    <svg viewBox={'0 0 ' + W + ' ' + H} style={{ width: '100%', height: 140 }} preserveAspectRatio="none">
      {[0, 0.5, 1].map((p) => (
        <g key={p}>
          <line x1={PAD_L} y1={y(max * p)} x2={W - PAD_R} y2={y(max * p)} stroke="var(--border)" strokeWidth={1} />
          <text x={PAD_L - 5} y={y(max * p) + 3.5} textAnchor="end" fontSize={9} fill="var(--text-2)">
            {formatBytes(Math.round(max * p))}
          </text>
        </g>
      ))}
      <path d={area('rxBytes')} fill={SERIES_COLORS[0]} opacity={0.16} />
      <path d={area('txBytes')} fill={SERIES_COLORS[1]} opacity={0.16} />
      <path d={line('rxBytes')} fill="none" stroke={SERIES_COLORS[0]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <path d={line('txBytes')} fill="none" stroke={SERIES_COLORS[1]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** 横向条形图，用于报文长度分布与路径排行 */
export function BarList({
  items,
  color = SERIES_COLORS[0],
  suffix
}: {
  items: { label: string; value: number; note?: string }[]
  color?: string
  suffix?: (v: number) => string
}): JSX.Element {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div style={barStyles.wrap}>
      {items.length === 0 && <div style={barStyles.empty}>暂无数据</div>}
      {items.map((it) => (
        <div key={it.label} style={barStyles.row}>
          <span style={barStyles.label} title={it.label}>{it.label}</span>
          <span style={barStyles.track}>
            <span style={{ ...barStyles.fill, width: (it.value / max) * 100 + '%', background: color }} />
          </span>
          <span style={barStyles.value}>{suffix ? suffix(it.value) : it.value}</span>
          {it.note && <span style={barStyles.note}>{it.note}</span>}
        </div>
      ))}
    </div>
  )
}

export function SizeBars({ bins }: { bins: SizeBin[] }): JSX.Element {
  return (
    <BarList
      items={bins.map((b) => ({ label: b.label + ' B', value: b.count }))}
      color={SERIES_COLORS[2]}
      suffix={(v) => v + ' 条'}
    />
  )
}

/** 环图：会话状态与状态码分布共用 */
export function Donut({ slices, total, caption }: { slices: Slice[]; total: number; caption: string }): JSX.Element {
  const R = 54
  const STROKE = 14
  const C = 2 * Math.PI * R
  let acc = 0
  const sum = slices.reduce((a, b) => a + b.value, 0) || 1
  return (
    <div style={donutStyles.wrap}>
      <svg viewBox="0 0 140 140" style={{ width: 128, height: 128, flexShrink: 0 }}>
        <circle cx={70} cy={70} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
        {slices.map((s, i) => {
          const len = (s.value / sum) * C
          const dash = len + ' ' + (C - len)
          const offset = -acc
          acc += len
          return (
            <circle
              key={s.label}
              cx={70}
              cy={70}
              r={R}
              fill="none"
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={STROKE}
              strokeDasharray={dash}
              strokeDashoffset={offset}
              transform="rotate(-90 70 70)"
            />
          )
        })}
        <text x={70} y={66} textAnchor="middle" fontSize={22} fill="var(--text-0)" fontFamily="var(--mono)">
          {total}
        </text>
        <text x={70} y={84} textAnchor="middle" fontSize={9.5} fill="var(--text-2)">
          {caption}
        </text>
      </svg>
      <div style={donutStyles.legend}>
        {slices.length === 0 && <div style={barStyles.empty}>暂无数据</div>}
        {slices.map((s, i) => (
          <div key={s.label} style={donutStyles.legendRow}>
            <span style={{ ...donutStyles.swatch, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            <span style={donutStyles.legendName}>{s.label}</span>
            <span style={donutStyles.legendVal}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const barStyles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 5 },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xs)' },
  label: { width: 86, flexShrink: 0, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  track: { flex: 1, minWidth: 0, height: 8, background: 'var(--bg-2)', borderRadius: 'var(--r-xs)', overflow: 'hidden' },
  fill: { display: 'block', height: '100%', borderRadius: 'var(--r-xs)' },
  value: { width: 56, flexShrink: 0, textAlign: 'right', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)' },
  note: { width: 48, flexShrink: 0, textAlign: 'right', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)' },
  empty: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', padding: '8px 0' }
}

const donutStyles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', gap: 16 },
  legend: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 },
  legendRow: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-xs)' },
  swatch: { width: 8, height: 8, borderRadius: 2, flexShrink: 0 },
  legendName: { flex: 1, minWidth: 0, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  legendVal: { color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }
}
