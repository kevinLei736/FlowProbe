import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store/useStore'
import { KIND_META, STATUS_META } from '../../app/meta'
import { collectTags, groupSessions, useSessionOrg } from '../../store/useSessionOrg'
import { BarList, Donut, SERIES_COLORS, SizeBars, ThroughputChart } from './charts'
import {
  bucketize,
  bucketsToCsv,
  formatBytes,
  formatRate,
  groupStats,
  latencyStat,
  sizeHistogram,
  statusCodeSlices,
  statusSlices,
  topPaths
} from './metrics'
import { Select } from '../../components/ui/Select'

type Range = 60000 | 180000 | 600000

const RANGES: Array<[Range, string]> = [
  [60000, '近 1 分钟'],
  [180000, '近 3 分钟'],
  [600000, '近 10 分钟']
]

/**
 * 数据可视化看板。
 *
 * 定位是「全局视角」：单会话的字段曲线在会话视图里看，这里回答的是
 * 哪些链路在跑、谁在刷流量、包长分布是否异常、Mock 的错误率与耗时如何。
 * 所有图表按 1 秒节拍刷新，避免每帧重算上万条报文。
 */
export function DashboardView({ onClose }: { onClose: () => void }): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const framesBySession = useStore((s) => s.framesBySession)
  const httpLogsBySession = useStore((s) => s.httpLogsBySession)
  const setActive = useStore((s) => s.setActive)
  const tagFilter = useSessionOrg((s) => s.tagFilter)
  const toggleTag = useSessionOrg((s) => s.toggleTag)
  const clearTags = useSessionOrg((s) => s.clearTags)

  const [range, setRange] = useState<Range>(180000)
  const [scope, setScope] = useState<string>('all')
  const [tick, setTick] = useState(Date.now())

  // 1 秒节拍：图表按秒推进就够看趋势，也让重算频率与数据量解耦
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const tags = useMemo(() => collectTags(sessions), [sessions])

  // 作用域：全部会话 / 某个分组 / 单个会话；标签筛选始终生效
  const scoped = useMemo(() => {
    const byTag = groupSessions(sessions, '', tagFilter).flatMap((g) => g.sessions)
    if (scope === 'all') return byTag
    if (scope.startsWith('group:')) {
      const name = scope.slice(6)
      return byTag.filter((s) => ((s.group ?? '').trim() || '未分组') === name)
    }
    return byTag.filter((s) => s.id === scope)
  }, [sessions, tagFilter, scope])

  const scopedFrames = useMemo(
    () => scoped.flatMap((s) => framesBySession[s.id] ?? []).sort((a, b) => a.ts - b.ts),
    [scoped, framesBySession]
  )

  const scopedLogs = useMemo(
    () => scoped.flatMap((s) => httpLogsBySession[s.id] ?? []),
    [scoped, httpLogsBySession]
  )

  const buckets = useMemo(
    () => bucketize(scopedFrames, 1000, range, tick),
    [scopedFrames, range, tick]
  )

  const live = useMemo(() => {
    // 取最近 5 个完整桶算实时速率，单桶抖动太大
    const tail = buckets.slice(-6, -1)
    const n = Math.max(1, tail.length)
    return {
      tx: tail.reduce((a, b) => a + b.txBytes, 0) / n,
      rx: tail.reduce((a, b) => a + b.rxBytes, 0) / n,
      frames: tail.reduce((a, b) => a + b.txFrames + b.rxFrames, 0) / n
    }
  }, [buckets])

  const totals = useMemo(
    () =>
      scoped.reduce(
        (a, s) => ({
          tx: a.tx + s.metrics.txBytes,
          rx: a.rx + s.metrics.rxBytes,
          frames: a.frames + s.metrics.txFrames + s.metrics.rxFrames,
          peers: a.peers + s.metrics.peers
        }),
        { tx: 0, rx: 0, frames: 0, peers: 0 }
      ),
    [scoped]
  )

  const hist = useMemo(() => sizeHistogram(scopedFrames), [scopedFrames])
  const statuses = useMemo(() => statusSlices(scoped), [scoped])
  const gstats = useMemo(() => groupStats(scoped), [scoped])
  const codes = useMemo(() => statusCodeSlices(scopedLogs), [scopedLogs])
  const lat = useMemo(() => latencyStat(scopedLogs.map((l) => l.durationMs)), [scopedLogs])
  const paths = useMemo(() => topPaths(scopedLogs), [scopedLogs])

  const errRate = useMemo(() => {
    if (scopedLogs.length === 0) return 0
    return scopedLogs.filter((l) => l.status >= 400).length / scopedLogs.length
  }, [scopedLogs])

  const busiest = useMemo(
    () =>
      [...scoped]
        .map((s) => ({
          session: s,
          bytes: s.metrics.txBytes + s.metrics.rxBytes,
          frames: s.metrics.txFrames + s.metrics.rxFrames
        }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 8),
    [scoped]
  )

  const groupNames = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) set.add((s.group ?? '').trim() || '未分组')
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [sessions])

  const exportCsv = async (): Promise<void> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await window.toolbox.saveTextFile('看板吞吐-' + stamp + '.csv', bucketsToCsv(buckets))
  }

  return (
    <div style={s.wrap}>
      <header style={s.topbar}>
        <span style={s.title}>数据看板</span>
        <span style={s.badge}>{scoped.length} 个会话在统计范围内</span>
        <span style={s.spacer} />
        <Select
          size="sm"
          style={{ maxWidth: 240, minWidth: 150 }}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: '全部会话' },
            ...groupNames.map((g) => ({ value: 'group:' + g, label: g, group: '按分组' })),
            ...sessions.map((x) => ({ value: x.id, label: x.name, group: '单个会话' }))
          ]}
        />
        <div style={s.seg}>
          {RANGES.map(([v, label]) => (
            <button
              key={v}
              style={{ ...s.segBtn, ...(range === v ? s.segActive : {}) }}
              onClick={() => setRange(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <button style={s.ghost} onClick={() => void exportCsv()}>导出 CSV</button>
        <button style={s.ghost} onClick={onClose}>返回会话</button>
      </header>

      {tags.length > 0 && (
        <div style={s.tagBar}>
          <span style={s.tagLabel}>标签筛选</span>
          {tags.map((t) => {
            const on = tagFilter.includes(t.tag)
            return (
              <button
                key={t.tag}
                style={{ ...s.tagChip, ...(on ? s.tagChipOn : {}) }}
                onClick={() => toggleTag(t.tag)}
              >
                {t.tag}
              </button>
            )
          })}
          {tagFilter.length > 0 && (
            <button style={s.tagClear} onClick={clearTags}>清除</button>
          )}
        </div>
      )}

      <div style={s.body}>
        <div style={s.kpiRow}>
          <Kpi label="实时发送" value={formatRate(live.tx)} note={'累计 ' + formatBytes(totals.tx)} />
          <Kpi label="实时接收" value={formatRate(live.rx)} note={'累计 ' + formatBytes(totals.rx)} />
          <Kpi label="报文速率" value={live.frames.toFixed(1) + ' 帧/s'} note={'累计 ' + totals.frames + ' 帧'} />
          <Kpi label="在线连接" value={String(totals.peers)} note={'服务端对端合计'} />
          <Kpi
            label="Mock 错误率"
            value={scopedLogs.length === 0 ? '—' : (errRate * 100).toFixed(1) + '%'}
            note={scopedLogs.length + ' 条请求'}
            danger={errRate > 0.1}
          />
          <Kpi
            label="响应 P95"
            value={lat ? Math.round(lat.p95) + ' ms' : '—'}
            note={lat ? '中位 ' + Math.round(lat.p50) + ' ms · 最大 ' + Math.round(lat.max) + ' ms' : '暂无请求'}
          />
        </div>

        <Card title="吞吐趋势" hint="面积为字节量，上行=发送，下行=接收">
          <ThroughputChart buckets={buckets} />
          <div style={s.legendRow}>
            <Legend color={SERIES_COLORS[1]} text="发送 TX" />
            <Legend color={SERIES_COLORS[0]} text="接收 RX" />
            <span style={s.spacer} />
            <span style={s.hint}>桶宽 1 秒 · 窗口 {Math.round(range / 60000)} 分钟</span>
          </div>
        </Card>

        <div style={s.grid2}>
          <Card title="会话状态" hint="点右侧图例外的会话名可直接跳转">
            <Donut slices={statuses} total={scoped.length} caption="会话" />
          </Card>
          <Card title="报文长度分布" hint="判断是小包高频还是大包低频">
            <SizeBars bins={hist} />
          </Card>
        </div>

        <div style={s.grid2}>
          <Card title="流量最高的会话" hint="点击跳转到该会话">
            <div style={s.rankList}>
              {busiest.length === 0 && <div style={s.hint}>暂无数据</div>}
              {busiest.map((b) => {
                const st = STATUS_META[b.session.status]
                return (
                  <button key={b.session.id} style={s.rankRow} onClick={() => { setActive(b.session.id); onClose() }}>
                    <span style={{ ...s.dot, background: st.color }} />
                    <span style={s.rankName}>{b.session.name}</span>
                    <span style={s.rankKind}>{KIND_META[b.session.kind].label}</span>
                    <span style={s.rankVal}>{formatBytes(b.bytes)}</span>
                    <span style={s.rankSub}>{b.frames} 帧</span>
                  </button>
                )
              })}
            </div>
          </Card>
          <Card title="分组流量对比" hint="按分组累计收发字节">
            <BarList
              items={gstats.map((g) => ({
                label: g.name,
                value: g.txBytes + g.rxBytes,
                note: g.sessions + ' 会话'
              }))}
              color={SERIES_COLORS[3]}
              suffix={(v) => formatBytes(v)}
            />
          </Card>
        </div>

        <div style={s.grid2}>
          <Card title="Mock 状态码分布" hint="来自 HTTP Mock 请求日志">
            <Donut slices={codes} total={scopedLogs.length} caption="请求" />
          </Card>
          <Card title="热门接口" hint="括号内为错误占比">
            <BarList
              items={paths.map((p) => ({
                label: p.path,
                value: p.count,
                note: p.errRate > 0 ? (p.errRate * 100).toFixed(0) + '% 错' : ''
              }))}
              color={SERIES_COLORS[4]}
              suffix={(v) => v + ' 次'}
            />
          </Card>
        </div>
      </div>
    </div>
  )
}

function Kpi({
  label,
  value,
  note,
  danger
}: {
  label: string
  value: string
  note?: string
  danger?: boolean
}): JSX.Element {
  return (
    <div style={s.kpi}>
      <span style={s.kpiLabel}>{label}</span>
      <span style={{ ...s.kpiValue, ...(danger ? { color: 'var(--conn-error)' } : {}) }}>{value}</span>
      {note && <span style={s.kpiNote}>{note}</span>}
    </div>
  )
}

function Card({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section style={s.card}>
      <div style={s.cardHead}>
        <span style={s.cardTitle}>{title}</span>
        {hint && <span style={s.hint}>{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Legend({ color, text }: { color: string; text: string }): JSX.Element {
  return (
    <span style={s.legendItem}>
      <span style={{ ...s.legendSwatch, background: color }} />
      {text}
    </span>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' },
  topbar: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)' },
  title: { fontWeight: 600 },
  badge: { fontSize: 'var(--fs-xs)', color: 'var(--text-1)', background: 'var(--btn2-bg)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', padding: '2px 6px' },
  spacer: { flex: 1 },
  select: { background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)', maxWidth: 220 },
  seg: { display: 'flex', background: 'var(--bg-inset)', padding: 2, gap: 2, borderRadius: 'var(--r-sm)', overflow: 'hidden' },
  segBtn: { padding: '4px 10px', background: 'transparent', color: 'var(--text-2)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 'var(--fs-xs)' },
  segActive: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  ghost: { padding: '5px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  tagBar: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid var(--border)' },
  tagLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  tagChip: { padding: '2px 8px', background: 'var(--btn2-bg)', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 11, fontSize: 'var(--fs-micro)' },
  tagChipOn: { background: 'var(--selected-bg)', color: 'var(--text-0)' },
  tagClear: { padding: '2px 8px', background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-micro)' },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 },
  kpi: { display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 12px', background: 'var(--bg-1)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-lg)' },
  kpiLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  kpiValue: { fontSize: 19, fontFamily: 'var(--font-mono)', color: 'var(--text-0)' },
  kpiNote: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  card: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, background: 'var(--bg-1)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-lg)', minWidth: 0 },
  cardHead: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  cardTitle: { fontSize: 'var(--fs-sm)', fontWeight: 600 },
  hint: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 },
  legendRow: { display: 'flex', alignItems: 'center', gap: 12 },
  legendItem: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  legendSwatch: { width: 9, height: 9, borderRadius: 2 },
  rankList: { display: 'flex', flexDirection: 'column', gap: 3 },
  rankRow: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 6px', background: 'transparent', color: 'var(--text-0)', border: 'none', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)', textAlign: 'left' },
  dot: { width: 7, height: 7, borderRadius: 'var(--r-md)', flexShrink: 0 },
  rankName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rankKind: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)', flexShrink: 0 },
  rankVal: { width: 72, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' },
  rankSub: { width: 60, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--text-2)' }
}
