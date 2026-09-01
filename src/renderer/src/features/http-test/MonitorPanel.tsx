import { useMemo, useState } from 'react'
import type { MonitorNotify, MonitorTask } from '@shared/protocol'
import { Select } from '../../components/ui/Select'
import { useApiClient } from './useApiClient'
import { blankTask, formatInterval, MIN_INTERVAL_SEC, secondsUntilDue, useMonitor } from './useMonitor'
import { executeTask } from './useMonitorScheduler'

/** 常用周期。给成预设而不是让用户填秒数，是因为绝大多数场景就落在这几档里 */
const INTERVALS = [
  { value: '10', label: '10 秒' },
  { value: '30', label: '30 秒' },
  { value: '60', label: '1 分钟' },
  { value: '300', label: '5 分钟' },
  { value: '900', label: '15 分钟' },
  { value: '1800', label: '30 分钟' },
  { value: '3600', label: '1 小时' },
  { value: '21600', label: '6 小时' }
]

const NOTIFY_OPTS: Array<{ value: MonitorNotify; label: string }> = [
  { value: 'fail', label: '仅失败时通知' },
  { value: 'always', label: '每次都通知' },
  { value: 'never', label: '不通知' }
]

/**
 * 接口巡检面板。
 *
 * 定位是「轻量可用性监控」：把已保存的接口集合按周期跑一遍，断言失败就通知。
 * 它不追求替代专业监控系统，价值在于联调阶段——挂机时不用一直手点「发送」。
 */
export function MonitorPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { collections, environments, activeEnvId } = useApiClient()
  const tasks = useMonitor((s) => s.tasks)
  const runs = useMonitor((s) => s.runs)
  const runningId = useMonitor((s) => s.runningId)
  const addTask = useMonitor((s) => s.addTask)
  const updateTask = useMonitor((s) => s.updateTask)
  const removeTask = useMonitor((s) => s.removeTask)
  const clearRuns = useMonitor((s) => s.clearRuns)
  const clearUnread = useMonitor((s) => s.clearUnread)

  const [selId, setSelId] = useState<string | null>(tasks[0]?.id ?? null)
  // 打开面板即视为已读：红点的作用是把人叫过来，人到了就该消掉
  useMemo(() => clearUnread(), [clearUnread])

  const sel = tasks.find((t) => t.id === selId) ?? null

  /*
    周期选项要把「当前值」兜住。
    预设档位覆盖不到的秒数（导入的配置、手改的 localStorage）如果不补进列表，
    自绘下拉框找不到匹配项就会退回 placeholder，看上去像「没设置周期」，
    实际上任务正常在跑 —— 这种不一致最容易让人误判。
  */
  const intervalOpts = useMemo(() => {
    if (!sel) return INTERVALS
    const cur = String(sel.intervalSec)
    if (INTERVALS.some((o) => o.value === cur)) return INTERVALS
    return [...INTERVALS, { value: cur, label: formatInterval(sel.intervalSec) + '（自定义）' }].sort(
      (a, b) => Number(a.value) - Number(b.value)
    )
  }, [sel])
  const selRuns = useMemo(
    () => (sel ? runs.filter((r) => r.taskId === sel.id) : runs),
    [runs, sel]
  )

  const create = (): void => {
    const t = blankTask('巡检' + (tasks.length + 1))
    addTask(t)
    setSelId(t.id)
  }

  const runNow = async (t: MonitorTask): Promise<void> => {
    if (runningId) return
    await executeTask(t)
  }

  const targetCount = (t: MonitorTask): number =>
    t.requestIds.length === 0 ? collections.length : t.requestIds.length

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.panel} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <span style={st.title}>接口巡检</span>
          <span style={st.hint}>按周期自动跑集合，断言失败即通知。关掉面板仍在后台运行</span>
          <span style={st.spacer} />
          <button style={st.ghost} onClick={create}>新建任务</button>
          <button style={st.close} onClick={onClose}>✕</button>
        </div>

        {collections.length === 0 && (
          <div style={st.tip}>集合为空。请先在接口测试里保存几个请求并配好断言，巡检才有可跑的内容。</div>
        )}

        <div style={st.body}>
          <div style={st.left}>
            <div style={st.sectionTitle}>任务</div>
            <div style={st.list}>
              {tasks.length === 0 && <div style={st.empty}>还没有巡检任务</div>}
              {tasks.map((t) => {
                const due = secondsUntilDue(t)
                return (
                  <button
                    key={t.id}
                    style={{ ...st.taskRow, ...(selId === t.id ? st.taskRowOn : {}) }}
                    onClick={() => setSelId(t.id)}
                  >
                    <span
                      style={{
                        ...st.dot,
                        background: !t.enabled
                          ? 'var(--text-3)'
                          : t.lastPassed === false
                            ? 'var(--error)'
                            : t.lastPassed === true
                              ? 'var(--text-1)'
                              : 'var(--text-3)'
                      }}
                    />
                    <span style={st.taskName}>{t.name}</span>
                    <span style={st.taskMeta}>
                      {runningId === t.id
                        ? '运行中'
                        : !t.enabled
                          ? '已暂停'
                          : due === 0
                            ? '即将运行'
                            : due + 's'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div style={st.right}>
            {!sel ? (
              <div style={st.empty}>左侧选择或新建一个巡检任务</div>
            ) : (
              <>
                <div style={st.fixedTop}>
                <div style={st.sectionTitle}>任务设置</div>
                <div style={st.form}>
                  <label style={st.row}>
                    <span style={st.lbl}>名称</span>
                    <input
                      style={st.input}
                      value={sel.name}
                      onChange={(e) => updateTask(sel.id, { name: e.target.value })}
                    />
                  </label>

                  <label style={st.row}>
                    <span style={st.lbl}>周期</span>
                    <Select
                      size="sm"
                      style={{ width: 160 }}
                      value={String(sel.intervalSec)}
                      onChange={(v) => updateTask(sel.id, { intervalSec: Math.max(MIN_INTERVAL_SEC, Number(v)) })}
                      options={intervalOpts}
                    />
                    <span style={st.note}>每 {formatInterval(sel.intervalSec)} 跑一次</span>
                  </label>

                  <label style={st.row}>
                    <span style={st.lbl}>环境</span>
                    <Select
                      size="sm"
                      style={{ width: 160 }}
                      value={sel.envId ?? ''}
                      onChange={(v) => updateTask(sel.id, { envId: v || null })}
                      options={[
                        { value: '', label: '跟随当前环境' },
                        ...environments.map((e) => ({ value: e.id, label: e.name, group: '环境' }))
                      ]}
                    />
                    <span style={st.note}>
                      当前：{environments.find((e) => e.id === (sel.envId ?? activeEnvId))?.name ?? '无'}
                    </span>
                  </label>

                  <label style={st.row}>
                    <span style={st.lbl}>通知</span>
                    <Select
                      size="sm"
                      style={{ width: 160 }}
                      value={sel.notify}
                      onChange={(v) => updateTask(sel.id, { notify: v as MonitorNotify })}
                      options={NOTIFY_OPTS}
                    />
                    {sel.notify === 'fail' && (
                      <>
                        <span style={st.note}>连续失败</span>
                        <input
                          style={st.num}
                          type="number"
                          min={1}
                          max={10}
                          value={sel.failThreshold}
                          onChange={(e) =>
                            updateTask(sel.id, { failThreshold: Math.max(1, Number(e.target.value) || 1) })
                          }
                        />
                        <span style={st.note}>次才通知（压掉网络抖动造成的偶发告警）</span>
                      </>
                    )}
                  </label>

                  <label style={st.row}>
                    <span style={st.lbl}>步骤间隔</span>
                    <input
                      style={st.num}
                      type="number"
                      min={0}
                      value={sel.delayMs}
                      onChange={(e) => updateTask(sel.id, { delayMs: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span style={st.note}>ms</span>
                    <span style={st.gap} />
                    <label style={st.check}>
                      <input
                        type="checkbox"
                        checked={sel.stopOnFail}
                        onChange={(e) => updateTask(sel.id, { stopOnFail: e.target.checked })}
                      />
                      失败即停止
                    </label>
                    <label style={st.check}>
                      <input
                        type="checkbox"
                        checked={sel.enabled}
                        onChange={(e) => updateTask(sel.id, { enabled: e.target.checked })}
                      />
                      启用
                    </label>
                  </label>
                </div>

                <div style={st.sectionTitle}>
                  巡检范围（不勾选=集合全部 {collections.length} 个，之后新增的接口自动纳入）
                </div>
                <div style={st.picks}>
                  {collections.length === 0 && <div style={st.empty}>集合为空</div>}
                  {collections.map((c) => {
                    const on = sel.requestIds.includes(c.id)
                    return (
                      <label key={c.id} style={st.pickRow}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            updateTask(sel.id, {
                              requestIds: e.target.checked
                                ? [...sel.requestIds, c.id]
                                : sel.requestIds.filter((x) => x !== c.id)
                            })
                          }
                        />
                        <span style={st.pickMethod}>{c.request.method}</span>
                        <span style={st.pickName} title={c.request.url}>{c.name}</span>
                        <span style={st.pickBadge}>{(c.assertions ?? []).length} 断言</span>
                      </label>
                    )
                  })}
                </div>

                <div style={st.actions}>
                  <span style={st.note}>
                    将执行 {targetCount(sel)} 个接口
                    {sel.lastRunAt ? ' · 上次 ' + new Date(sel.lastRunAt).toLocaleTimeString() : ' · 尚未运行'}
                  </span>
                  <span style={st.gap} />
                  <button style={st.danger} onClick={() => { removeTask(sel.id); setSelId(null) }}>删除任务</button>
                  <button
                    style={st.primary}
                    disabled={Boolean(runningId) || targetCount(sel) === 0}
                    onClick={() => void runNow(sel)}
                  >
                    {runningId === sel.id ? '运行中…' : '立即运行'}
                  </button>
                </div>

                </div>

                <div style={{ ...st.sectionTitle, flexShrink: 0 }}>
                  巡检历史
                  {selRuns.length > 0 && (
                    <button style={st.linkBtn} onClick={clearRuns}>清空</button>
                  )}
                </div>
                <div style={st.runs}>
                  {selRuns.length === 0 && <div style={st.empty}>暂无记录</div>}
                  {selRuns.map((r) => (
                    <div key={r.id} style={st.runRow}>
                      <span style={{ ...st.mark, color: r.stepFail > 0 ? 'var(--error)' : 'var(--text-1)' }}>
                        {r.stepFail > 0 ? '✕' : '✓'}
                      </span>
                      <span style={st.runTime}>{new Date(r.startedAt).toLocaleString()}</span>
                      <span style={st.runMeta}>{r.stepPass}/{r.ran} 通过</span>
                      <span style={st.runMeta}>{r.assertPass}/{r.assertTotal} 断言</span>
                      <span style={st.runMeta}>{r.totalMs}ms</span>
                      {r.failures.length > 0 && (
                        <span style={st.runFail} title={r.failures.map((f) => f.name + ' → ' + f.detail).join('\n')}>
                          {r.failures[0].name} → {r.failures[0].detail}
                          {r.failures.length > 1 ? ' 等 ' + r.failures.length + ' 项' : ''}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--overlay)',
    backdropFilter: 'blur(2px)',
    WebkitBackdropFilter: 'blur(2px)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 58
  },
  panel: {
    width: 'min(1080px, 94vw)',
    height: 'min(740px, 92vh)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden'
  },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontSize: 'var(--fs-md)', fontWeight: 600 },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  spacer: { flex: 1 },
  gap: { flex: 1 },
  close: { background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-md)' },
  tip: {
    padding: '8px 16px',
    background: 'var(--bg-2)',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-1)'
  },
  body: { flex: 1, display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 0 },
  left: { display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', minHeight: 0 },
  /*
   * 右栏不整体滚动：巡检历史会长到几百条，整栏滚动会把「任务设置」顶出视野，
   * 用户想改个周期得先滚回顶部。改成设置区固定 + 历史区独立滚动。
   */
  right: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: 'var(--bg-0)' },
  fixedTop: { flexShrink: 0 },
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px 6px',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-2)'
  },
  linkBtn: { marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-2)', fontSize: 'var(--fs-xs)' },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: '0 8px 8px' },
  taskRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 9px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-1)',
    textAlign: 'left'
  },
  taskRowOn: { background: 'var(--selected-strong-bg)', color: 'var(--text-0)' },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  taskName: { flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
  taskMeta: { flexShrink: 0, fontSize: 'var(--fs-micro)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  form: { display: 'flex', flexDirection: 'column', gap: 8, padding: '0 14px 10px' },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  lbl: { width: 62, flexShrink: 0, color: 'var(--text-2)', fontSize: 'var(--fs-sm)' },
  note: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  input: {
    flex: 1,
    minWidth: 0,
    height: 'var(--control-h-sm)',
    padding: '0 8px',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    outline: 'none'
  },
  num: {
    width: 68,
    height: 'var(--control-h-sm)',
    padding: '0 8px',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    fontFamily: 'var(--font-mono)',
    outline: 'none'
  },
  check: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  picks: { display: 'flex', flexDirection: 'column', gap: 2, padding: '0 14px 8px', maxHeight: 180, overflowY: 'auto' },
  pickRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 6px',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-1)'
  },
  pickMethod: { width: 46, flexShrink: 0, fontSize: 'var(--fs-micro)', fontFamily: 'var(--font-mono)', color: 'var(--text-2)' },
  pickName: { flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
  pickBadge: { flexShrink: 0, fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px 10px', borderBottom: '1px solid var(--border-subtle)' },
  primary: { padding: '6px 16px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)' },
  ghost: { padding: '5px 12px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  danger: { padding: '5px 12px', background: 'transparent', color: 'var(--error)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  runs: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: '0 14px 14px' },
  runRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 7px',
    background: 'var(--bg-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-xs)'
  },
  mark: { width: 12, flexShrink: 0 },
  runTime: { width: 150, flexShrink: 0, fontFamily: 'var(--font-mono)', color: 'var(--text-1)' },
  runMeta: { flexShrink: 0, fontFamily: 'var(--font-mono)', color: 'var(--text-2)' },
  runFail: { flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--error)' },
  empty: { padding: '14px', fontSize: 'var(--fs-sm)', color: 'var(--text-2)' }
}
