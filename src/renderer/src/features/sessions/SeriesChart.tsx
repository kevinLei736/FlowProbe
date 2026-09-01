import { useMemo, useState } from 'react'
import type { Series } from './seriesExtract'
import { seriesStats } from './seriesExtract'

/** 曲线配色：中性偏冷的低饱和色，避免抢主界面的灰阶 */
const COLORS = ['#8fa8c8', '#c8a87f', '#9dc0a5', '#c090a8', '#a8a0c8', '#c8c08f']

const W = 1000 // viewBox 宽，SVG 靠 width:100% 自适应
const H = 200
const PAD_L = 46
const PAD_R = 12
const PAD_T = 10
const PAD_B = 22

/**
 * 报文数值曲线。用原生 SVG 折线绘制，不引入图表库：
 * 数据量已在抽取阶段限流，路径就是一串 L 指令，比引一个 200KB 的库划算。
 */
export function SeriesChart({
  series,
  onClose,
  onExport
}: {
  series: Series[]
  onClose: () => void
  onExport: () => void
}): JSX.Element {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const shown = series.filter((s) => !hidden.has(s.name))
  const stats = useMemo(() => seriesStats(series), [series])

  const bounds = useMemo(() => {
    let tMin = Number.POSITIVE_INFINITY
    let tMax = Number.NEGATIVE_INFINITY
    let vMin = Number.POSITIVE_INFINITY
    let vMax = Number.NEGATIVE_INFINITY
    for (const s of shown) {
      for (const p of s.points) {
        if (p.ts < tMin) tMin = p.ts
        if (p.ts > tMax) tMax = p.ts
        if (p.value < vMin) vMin = p.value
        if (p.value > vMax) vMax = p.value
      }
    }
    if (!Number.isFinite(tMin)) return null
    // 全部同值时给一个对称余量，否则折线会贴边成一条直线
    if (vMax - vMin < 1e-9) {
      const pad = Math.abs(vMax) > 1e-9 ? Math.abs(vMax) * 0.1 : 1
      vMin -= pad
      vMax += pad
    } else {
      const pad = (vMax - vMin) * 0.08
      vMin -= pad
      vMax += pad
    }
    if (tMax - tMin < 1) tMax = tMin + 1
    return { tMin, tMax, vMin, vMax }
  }, [shown])

  const x = (ts: number): number =>
    bounds ? PAD_L + ((ts - bounds.tMin) / (bounds.tMax - bounds.tMin)) * (W - PAD_L - PAD_R) : 0
  const y = (v: number): number =>
    bounds ? PAD_T + (1 - (v - bounds.vMin) / (bounds.vMax - bounds.vMin)) * (H - PAD_T - PAD_B) : 0

  const ticks = useMemo(() => {
    if (!bounds) return []
    const out: { v: number; y: number }[] = []
    for (let i = 0; i <= 4; i++) {
      const v = bounds.vMin + ((bounds.vMax - bounds.vMin) * i) / 4
      out.push({ v, y: y(v) })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds])

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.title}>数值曲线</span>
        <span style={s.hint}>
          {series.length === 0 ? '在模板里勾选字段的「曲线」即可绘制' : '最近 ' + Math.max(...series.map((x2) => x2.points.length)) + ' 个采样点'}
        </span>
        <span style={s.spacer} />
        {series.length > 0 && <button style={s.ghost} onClick={onExport}>导出 CSV</button>}
        <button style={s.ghost} onClick={onClose}>收起</button>
      </div>

      {series.length === 0 ? (
        <div style={s.empty}>
          暂无可绘制的数据。打开「模板」，给数值字段勾上「曲线」，再让报文流进来。
        </div>
      ) : (
        <>
          {!bounds && <div style={s.empty}>所有曲线都被隐藏了，点下方图例可重新显示。</div>}
          {bounds && <svg viewBox={'0 0 ' + W + ' ' + H} style={s.svg} preserveAspectRatio="none">
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD_L} y1={t.y} x2={W - PAD_R} y2={t.y} stroke="var(--border)" strokeWidth={1} />
                <text x={PAD_L - 6} y={t.y + 3.5} textAnchor="end" fontSize={10} fill="var(--text-2)">
                  {fmtNum(t.v)}
                </text>
              </g>
            ))}
            {shown.map((sr) => {
              const idx = series.findIndex((z) => z.name === sr.name)
              const color = COLORS[idx % COLORS.length]
              const d = sr.points.map((p, i) => (i === 0 ? 'M' : 'L') + x(p.ts).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ')
              return <path key={sr.name} d={d} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
            })}
            <text x={PAD_L} y={H - 6} fontSize={10} fill="var(--text-2)">{fmtTime(bounds.tMin)}</text>
            <text x={W - PAD_R} y={H - 6} textAnchor="end" fontSize={10} fill="var(--text-2)">{fmtTime(bounds.tMax)}</text>
          </svg>}

          <div style={s.legend}>
            {stats.map((st, i) => {
              const off = hidden.has(st.name)
              return (
                <button
                  key={st.name}
                  style={{ ...s.legendItem, opacity: off ? 0.4 : 1 }}
                  title={off ? '点击显示' : '点击隐藏'}
                  onClick={() =>
                    setHidden((prev) => {
                      const next = new Set(prev)
                      if (next.has(st.name)) next.delete(st.name)
                      else next.add(st.name)
                      return next
                    })
                  }
                >
                  <span style={{ ...s.swatch, background: COLORS[i % COLORS.length] }} />
                  <span style={s.legendName}>{st.name}</span>
                  <span style={s.legendVal}>
                    {fmtNum(st.last)}{st.unit ? ' ' + st.unit : ''}
                  </span>
                  <span style={s.legendMeta}>
                    最小 {fmtNum(st.min)} · 最大 {fmtNum(st.max)} · 均值 {fmtNum(st.avg)} · {st.count} 点
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Number.isInteger(v)) return String(v)
  return String(Number(v.toFixed(3)))
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

const s: Record<string, React.CSSProperties> = {
  wrap: { flexShrink: 0, borderTop: '1px solid var(--border)', background: 'var(--bg-1)', padding: '8px 14px 10px' },
  head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
  title: { fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-0)' },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  spacer: { flex: 1 },
  ghost: { padding: '3px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  svg: { width: '100%', height: 200, display: 'block' },
  legend: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  legendItem: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: 'var(--btn2-bg)', border: '1px solid transparent', borderRadius: 12, fontSize: 'var(--fs-xs)' },
  swatch: { width: 8, height: 8, borderRadius: 'var(--r-md)', flexShrink: 0 },
  legendName: { color: 'var(--text-0)' },
  legendVal: { color: 'var(--text-0)', fontFamily: 'var(--font-mono)', fontWeight: 600 },
  legendMeta: { color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)' },
  empty: { padding: '18px 4px', fontSize: 'var(--fs-sm)', color: 'var(--text-2)', textAlign: 'center' }
}
