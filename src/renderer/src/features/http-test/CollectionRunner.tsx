import { useMemo, useState } from 'react'
import type { SavedHttpRequest } from '@shared/protocol'
import { useApiClient } from './useApiClient'
import {
  runCollection,
  stepFailed,
  summarize,
  toMarkdown,
  type RunResult
} from './runCollection'

export function CollectionRunner({ onClose }: { onClose: () => void }): JSX.Element {
  const { collections, environments, activeEnvId } = useApiClient()
  const activeEnv = environments.find((e) => e.id === activeEnvId) ?? null

  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(collections.map((c) => [c.id, true]))
  )
  const [order, setOrder] = useState<string[]>(() => collections.map((c) => c.id))
  const [delayMs, setDelayMs] = useState(0)
  const [stopOnFail, setStopOnFail] = useState(false)
  const [running, setRunning] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const [summary, setSummary] = useState<RunResult | null>(null)
  const [runtimeVars, setRuntimeVars] = useState<Record<string, string>>({})
  const [savedTo, setSavedTo] = useState<string | null>(null)

  // 集合可能在打开面板后变化，这里补齐新增项的顺序与选中状态
  const orderedItems = useMemo<SavedHttpRequest[]>(() => {
    const map = new Map(collections.map((c) => [c.id, c]))
    const listed = order.map((id) => map.get(id)).filter(Boolean) as SavedHttpRequest[]
    const rest = collections.filter((c) => !order.includes(c.id))
    return [...listed, ...rest]
  }, [collections, order])

  const chosenCount = orderedItems.filter((c) => selected[c.id] !== false).length

  const move = (id: string, dir: -1 | 1): void => {
    const ids = orderedItems.map((c) => c.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    const next = [...ids]
    next[i] = ids[j]
    next[j] = ids[i]
    setOrder(next)
  }

  const run = async (): Promise<void> => {
    setRunning(true)
    setSummary(null)
    setSavedTo(null)
    // 执行逻辑不在这里：与定时巡检共用 runCollection，避免两处判定漂移
    const result = await runCollection({
      items: orderedItems.filter((c) => selected[c.id] !== false),
      envVars: activeEnv?.variables,
      delayMs,
      stopOnFail,
      onStep: setCurrent,
      onVars: setRuntimeVars
    })
    setSummary(result)
    setRunning(false)
  }

  const stats = useMemo(() => (summary ? summarize(summary) : null), [summary])

  const exportReport = async (kind: 'md' | 'json'): Promise<void> => {
    if (!summary) return
    const stamp = new Date(summary.startedAt)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const name = `接口测试报告_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.${kind}`
    const content = kind === 'json' ? JSON.stringify(summary, null, 2) : toMarkdown(summary, activeEnv?.name)
    const path = await window.toolbox.saveTextFile(name, content)
    if (path) setSavedTo(path)
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>集合批量运行</span>
          <span style={styles.hint}>
            环境：{activeEnv?.name ?? '无'} · 已选 {chosenCount}/{orderedItems.length}
          </span>
          <span style={styles.spacer} />
          <button style={styles.close} onClick={onClose}>✕</button>
        </div>

        <div style={styles.toolbar}>
          <label style={styles.field}>
            间隔
            <input
              style={styles.num}
              type="number"
              min={0}
              value={delayMs}
              onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value) || 0))}
            />
            ms
          </label>
          <label style={styles.check}>
            <input type="checkbox" checked={stopOnFail} onChange={(e) => setStopOnFail(e.target.checked)} />
            失败即停止
          </label>
          <span style={styles.spacer} />
          {summary && (
            <>
              <button style={styles.ghost} onClick={() => exportReport('md')}>导出 Markdown</button>
              <button style={styles.ghost} onClick={() => exportReport('json')}>导出 JSON</button>
            </>
          )}
          <button style={styles.run} disabled={running || chosenCount === 0} onClick={run}>
            {running ? '运行中…' : `运行 ${chosenCount} 个请求`}
          </button>
        </div>

        {savedTo && <div style={styles.saved}>报告已保存：{savedTo}</div>}

        <div style={styles.body}>
          <div style={styles.left}>
            <div style={styles.sectionTitle}>执行顺序</div>
            <div style={styles.list}>
              {orderedItems.length === 0 && (
                <div style={styles.empty}>集合为空，请先在接口测试里保存请求</div>
              )}
              {orderedItems.map((item, i) => (
                <div
                  key={item.id}
                  style={{ ...styles.row, ...(current === item.id ? styles.rowActive : {}) }}
                >
                  <input
                    type="checkbox"
                    checked={selected[item.id] !== false}
                    onChange={(e) => setSelected((s) => ({ ...s, [item.id]: e.target.checked }))}
                  />
                  <span style={styles.idx}>{i + 1}</span>
                  <span style={styles.method}>{item.request.method}</span>
                  <span style={styles.name} title={item.request.url}>{item.name}</span>
                  <span style={styles.badge}>{(item.assertions ?? []).length} 断言</span>
                  <button style={styles.mini} onClick={() => move(item.id, -1)}>↑</button>
                  <button style={styles.mini} onClick={() => move(item.id, 1)}>↓</button>
                </div>
              ))}
            </div>

            {Object.keys(runtimeVars).length > 0 && (
              <>
                <div style={styles.sectionTitle}>运行时变量</div>
                <div style={styles.varsBox}>
                  {Object.entries(runtimeVars).map(([k, v]) => (
                    <div key={k} style={styles.varRow}>
                      <span style={styles.varKey}>{k}</span>
                      <span style={styles.varVal} title={v}>{v}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={styles.right}>
            <div style={styles.sectionTitle}>运行结果</div>
            {!summary && <div style={styles.empty}>{running ? '正在按顺序执行…' : '尚未运行'}</div>}
            {summary && stats && (
              <>
                <div style={styles.statsRow}>
                  <Stat label="用例" value={`${stats.stepPass}/${stats.ran}`} bad={stats.stepFail > 0} />
                  <Stat
                    label="断言"
                    value={stats.assertTotal ? `${stats.assertPass}/${stats.assertTotal}` : '—'}
                    bad={stats.assertPass !== stats.assertTotal}
                  />
                  <Stat label="跳过" value={String(stats.skipped)} bad={stats.skipped > 0} />
                  <Stat label="总耗时" value={`${summary.totalMs}ms`} />
                </div>
                <div style={styles.resultList}>
                  {summary.steps.map((s, i) => {
                    const failed = stepFailed(s)
                    return (
                      <div key={s.requestId + i} style={styles.resultCard}>
                        <div style={styles.resultHead}>
                          <span style={{ ...styles.mark, color: s.skipped ? 'var(--text-2)' : failed ? 'var(--error)' : 'var(--text-0)' }}>
                            {s.skipped ? '—' : failed ? '✕' : '✓'}
                          </span>
                          <span style={styles.method}>{s.method}</span>
                          <span style={styles.name}>{s.name}</span>
                          <span style={styles.spacer} />
                          {s.skipped ? (
                            <span style={styles.metaDim}>已跳过</span>
                          ) : (
                            <>
                              <span style={styles.meta}>{s.status || '失败'}</span>
                              <span style={styles.metaDim}>{s.durationMs}ms</span>
                              <span style={styles.metaDim}>{s.sizeBytes}B</span>
                            </>
                          )}
                        </div>
                        <div style={styles.resultUrl}>{s.url}</div>
                        {s.error && <div style={styles.errLine}>{s.error}</div>}
                        {s.asserts.map((a) => (
                          <div key={a.id} style={styles.assertLine}>
                            <span style={{ color: a.passed ? 'var(--text-1)' : 'var(--error)' }}>
                              {a.passed ? '✓' : '✕'}
                            </span>
                            <span>{a.detail}</span>
                          </div>
                        ))}
                        {Object.keys(s.extracted).length > 0 && (
                          <div style={styles.extractLine}>
                            提取：{Object.entries(s.extracted).map(([k, v]) => `${k}=${v}`).join('  ')}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }): JSX.Element {
  return (
    <div style={styles.stat}>
      <div style={{ ...styles.statValue, color: bad ? 'var(--error)' : 'var(--text-0)' }}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 60 },
  panel: { width: 'min(1180px, 94vw)', height: 'min(760px, 92vh)', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border)' },
  title: { fontSize: 'var(--fs-md)', fontWeight: 600 },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  spacer: { flex: 1 },
  close: { background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-md)' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid var(--border)' },
  field: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  num: { width: 72, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  ghost: { padding: '5px 12px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  run: { padding: '6px 18px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)' },
  saved: { padding: '6px 14px', fontSize: 'var(--fs-xs)', color: 'var(--text-2)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' },
  body: { flex: 1, display: 'grid', gridTemplateColumns: '400px 1fr', minHeight: 0 },
  left: { display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', minHeight: 0, overflowY: 'auto' },
  right: { display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-0)' },
  sectionTitle: { padding: '10px 14px 6px', fontSize: 'var(--fs-xs)', color: 'var(--text-2)', letterSpacing: 0.4, textTransform: 'uppercase' },
  list: { display: 'flex', flexDirection: 'column' },
  row: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 'var(--fs-sm)' },
  rowActive: { background: 'var(--selected-bg)' },
  idx: { width: 16, textAlign: 'right', fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  method: { fontSize: 'var(--fs-micro)', fontFamily: 'var(--font-mono)', color: 'var(--text-2)', width: 46, flexShrink: 0 },
  name: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)', flexShrink: 0 },
  mini: { background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-xs)', padding: '0 2px' },
  empty: { padding: '16px 14px', fontSize: 'var(--fs-sm)', color: 'var(--text-2)' },
  varsBox: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 14px 12px' },
  varRow: { display: 'flex', gap: 8, fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)' },
  varKey: { color: 'var(--text-1)', minWidth: 90 },
  varVal: { color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  statsRow: { display: 'flex', gap: 10, padding: '0 14px 10px' },
  stat: { flex: 1, background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '8px 10px' },
  statValue: { fontSize: 'var(--fs-lg)', fontWeight: 600, fontFamily: 'var(--font-mono)' },
  statLabel: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)', marginTop: 2 },
  resultList: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '0 14px 14px' },
  resultCard: { border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '8px 10px', background: 'var(--bg-1)' },
  resultHead: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' },
  mark: { fontSize: 'var(--fs-sm)', width: 12 },
  meta: { fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-0)' },
  metaDim: { fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-2)' },
  resultUrl: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  errLine: { fontSize: 'var(--fs-xs)', color: 'var(--error)', marginTop: 4 },
  assertLine: { display: 'flex', gap: 6, fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', marginTop: 3, color: 'var(--text-1)' },
  extractLine: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', marginTop: 4 }
}
