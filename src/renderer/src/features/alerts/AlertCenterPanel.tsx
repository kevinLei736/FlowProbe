import { useMemo, useState } from 'react'
import type { AlertOp, AlertRule, AlertSeverity, AlertSource, ConnectionKind } from '@shared/protocol'
import { Select } from '../../components/ui/Select'
import { useStore } from '../../store/useStore'
import { useProtoTemplates, templateFitsKind } from '../../store/useProtoTemplates'
import { KIND_CAPS, KIND_META } from '../../app/meta'
import { useMonitor } from '../http-test/useMonitor'
import { useAlerts } from './useAlerts'

/**
 * 告警中心。
 *
 * 把两类告警放进同一个面板：报文断言命中（本模块产生）与接口巡检失败
 * （M28.2 产生）。它们的来源完全不同，但对用户是同一件事——
 * 「刚才有什么不对的」。分成两个面板会让人每次都要想「该去哪看」。
 */

const SOURCE_OPTS: Array<{ value: AlertSource; label: string }> = [
  { value: 'field', label: '解析字段' },
  { value: 'text', label: '报文文本' },
  { value: 'checksum', label: '校验结果' }
]

/** 数值类运算与文本类运算分开列，避免出现「温度 contains 80」这种无意义组合 */
const NUM_OPS: Array<{ value: AlertOp; label: string }> = [
  { value: 'gt', label: '大于 >' },
  { value: 'gte', label: '大于等于 ≥' },
  { value: 'lt', label: '小于 <' },
  { value: 'lte', label: '小于等于 ≤' },
  { value: 'eq', label: '等于 =' },
  { value: 'ne', label: '不等于 ≠' },
  { value: 'between', label: '落在区间' },
  { value: 'outside', label: '超出区间' }
]

const TEXT_OPS: Array<{ value: AlertOp; label: string }> = [
  { value: 'contains', label: '包含' },
  { value: 'notContains', label: '不包含' },
  { value: 'regex', label: '正则匹配' },
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' }
]

const COOLDOWNS = [
  { value: '0', label: '不冷却' },
  { value: '10', label: '10 秒' },
  { value: '30', label: '30 秒' },
  { value: '60', label: '1 分钟' },
  { value: '300', label: '5 分钟' }
]

type Tab = 'events' | 'rules'

export function AlertCenterPanel({
  onClose,
  initialTab = 'events',
  presetSessionId = null
}: {
  onClose: () => void
  initialTab?: Tab
  /**
   * 从某个会话的工具栏进来时带上会话 id：新建规则直接锁定这个会话。
   * 从菜单/左栏进来是 null，新规则默认作用于全部支持告警的会话。
   */
  presetSessionId?: string | null
}): JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab)
  const rules = useAlerts((s) => s.rules)
  const events = useAlerts((s) => s.events)
  const addRule = useAlerts((s) => s.addRule)
  const updateRule = useAlerts((s) => s.updateRule)
  const removeRule = useAlerts((s) => s.removeRule)
  const duplicateRule = useAlerts((s) => s.duplicateRule)
  const clearEvents = useAlerts((s) => s.clearEvents)
  const clearUnread = useAlerts((s) => s.clearUnread)
  const monitorRuns = useMonitor((s) => s.runs)
  const clearMonitorUnread = useMonitor((s) => s.clearUnread)
  const sessions = useStore((s) => s.sessions)
  const templates = useProtoTemplates((s) => s.templates)

  const [selId, setSelId] = useState<string | null>(rules[0]?.id ?? null)
  // 打开即已读：红点的作用是把人叫过来，人到了就该消掉
  useMemo(() => {
    clearUnread()
    clearMonitorUnread()
  }, [clearUnread, clearMonitorUnread])

  const sel = rules.find((r) => r.id === selId) ?? null

  /**
   * 统一时间线：报文告警 + 巡检失败按时间倒排。
   *
   * 巡检一次运行可能有多个失败接口，这里摊平成多行——
   * 用户关心的是「哪个接口挂了」，把它们折进一行反而要再点一次才能看到。
   */
  const timeline = useMemo(() => {
    type Row = {
      key: string
      ts: number
      kind: 'frame' | 'monitor'
      severity: AlertSeverity
      title: string
      source: string
      detail: string
      snapshot?: string
    }
    const rows: Row[] = []
    for (const e of events) {
      rows.push({
        key: 'f' + e.id,
        ts: e.ts,
        kind: 'frame',
        severity: e.severity,
        title: e.ruleName,
        source: e.sessionName + ' · ' + (e.direction === 'tx' ? '发送' : '接收'),
        detail: e.detail,
        snapshot: e.snapshotHex
      })
    }
    for (const run of monitorRuns) {
      for (let i = 0; i < run.failures.length; i++) {
        const f = run.failures[i]
        rows.push({
          key: 'm' + run.id + ':' + i,
          ts: run.startedAt,
          kind: 'monitor',
          severity: 'error',
          title: f.name,
          source: '巡检 · ' + run.taskName,
          detail: (f.status > 0 ? '状态 ' + f.status + ' · ' : '') + f.detail
        })
      }
    }
    return rows.sort((a, b) => b.ts - a.ts)
  }, [events, monitorRuns])

  /** 只列支持告警的会话：HTTP Mock 没有报文字节，挂在它上面的规则永远不会命中 */
  const alertSessions = useMemo(() => sessions.filter((s) => KIND_CAPS[s.kind].alertRule), [sessions])

  /** 规则选中会话后，模板下拉只给该会话类型可用的；未限定会话则给全部 */
  const ruleTemplates = useMemo(() => {
    if (!sel) return templates
    const kind: ConnectionKind | null = sel.sessionId
      ? (sessions.find((s) => s.id === sel.sessionId)?.kind ?? null)
      : sel.kinds[0] ?? null
    if (!kind) return templates
    return templates.filter((t) => templateFitsKind(t, kind))
  }, [sel, sessions, templates])

  /** 选中模板的字段名，供字段下拉直接选而不用手打 */
  const fieldOpts = useMemo(() => {
    if (!sel || sel.source !== 'field') return []
    const list =
      sel.templateId && sel.templateId !== 'auto'
        ? ruleTemplates.filter((t) => t.id === sel.templateId)
        : ruleTemplates
    const names = new Set<string>()
    for (const t of list) for (const f of t.fields) names.add(f.name)
    return [...names].map((n) => ({ value: n, label: n }))
  }, [sel, ruleTemplates])

  const create = (): void => {
    const kind = presetSessionId ? sessions.find((s) => s.id === presetSessionId)?.kind : undefined
    const r = addRule(kind, presetSessionId)
    setSelId(r.id)
    setTab('rules')
  }

  const exportEvents = async (): Promise<void> => {
    if (timeline.length === 0) return
    const head = ['时间', '类型', '级别', '规则/接口', '来源', '说明', '报文快照'].join(',')
    const body = timeline.map((r) =>
      [
        new Date(r.ts).toISOString(),
        r.kind === 'frame' ? '报文告警' : '巡检失败',
        r.severity === 'error' ? '错误' : '警告',
        r.title,
        r.source,
        r.detail,
        r.snapshot ?? ''
      ]
        .map((x) => '"' + String(x).split('"').join('""') + '"')
        .join(',')
    )
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await window.toolbox.saveTextFile('告警记录-' + stamp + '.csv', [head, ...body].join('\r\n'))
  }

  const opOpts = sel && sel.source === 'text' ? TEXT_OPS : NUM_OPS
  const needsRange = sel ? sel.op === 'between' || sel.op === 'outside' : false

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.panel} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <span style={st.title}>告警中心</span>
          <div style={st.tabs}>
            <button
              style={{ ...st.tab, ...(tab === 'events' ? st.tabOn : {}) }}
              onClick={() => setTab('events')}
            >
              告警记录{timeline.length > 0 ? '（' + timeline.length + '）' : ''}
            </button>
            <button
              style={{ ...st.tab, ...(tab === 'rules' ? st.tabOn : {}) }}
              onClick={() => setTab('rules')}
            >
              报文规则{rules.length > 0 ? '（' + rules.length + '）' : ''}
            </button>
          </div>
          <span style={st.spacer} />
          {tab === 'events' ? (
            <>
              <button style={st.ghost} disabled={timeline.length === 0} onClick={() => void exportEvents()}>
                导出 CSV
              </button>
              <button style={st.ghost} disabled={events.length === 0} onClick={clearEvents}>
                清空报文告警
              </button>
            </>
          ) : (
            <button style={st.ghost} onClick={create}>新建规则</button>
          )}
          <button style={st.close} onClick={onClose}>✕</button>
        </div>

        {tab === 'events' ? (
          <div style={st.timeline}>
            {timeline.length === 0 && (
              <div style={st.empty}>
                暂无告警。到「报文规则」页给字段设个阈值，命中时这里会留下时间、来源会话与当时的报文快照。
              </div>
            )}
            {timeline.map((r) => (
              <div key={r.key} style={st.evRow}>
                <span
                  style={{
                    ...st.evDot,
                    background: r.severity === 'error' ? 'var(--error)' : 'var(--warn)'
                  }}
                />
                <span style={st.evTime}>{new Date(r.ts).toLocaleString()}</span>
                <span style={st.evKind}>{r.kind === 'frame' ? '报文' : '巡检'}</span>
                <span style={st.evTitle} title={r.title}>{r.title}</span>
                <span style={st.evSource} title={r.source}>{r.source}</span>
                <span style={st.evDetail} title={r.detail}>{r.detail}</span>
                {r.snapshot && <span style={st.evSnap} title={r.snapshot}>{r.snapshot}</span>}
              </div>
            ))}
          </div>
        ) : (
          <div style={st.body}>
            <div style={st.left}>
              <div style={st.sectionTitle}>规则</div>
              <div style={st.list}>
                {rules.length === 0 && <div style={st.empty}>还没有规则</div>}
                {rules.map((r) => (
                  <button
                    key={r.id}
                    style={{ ...st.taskRow, ...(selId === r.id ? st.taskRowOn : {}) }}
                    onClick={() => setSelId(r.id)}
                  >
                    <span
                      style={{
                        ...st.dot,
                        background: !r.enabled
                          ? 'var(--text-3)'
                          : r.severity === 'error'
                            ? 'var(--error)'
                            : 'var(--warn)'
                      }}
                    />
                    <span style={st.taskName}>{r.name}</span>
                    <span style={st.taskMeta}>{r.hits ? r.hits + ' 次' : '—'}</span>
                  </button>
                ))}
              </div>
            </div>

            <div style={st.right}>
              {!sel ? (
                <div style={st.empty}>左侧选择或新建一条规则</div>
              ) : (
                <div style={st.form}>
                  <label style={st.row}>
                    <span style={st.lbl}>名称</span>
                    <input
                      style={st.input}
                      value={sel.name}
                      onChange={(e) => updateRule(sel.id, { name: e.target.value })}
                    />
                  </label>

                  <label style={st.row}>
                    <span style={st.lbl}>作用范围</span>
                    <Select
                      size="sm"
                      style={{ width: 200 }}
                      value={sel.sessionId ?? (sel.kinds[0] ? 'kind:' + sel.kinds[0] : '')}
                      onChange={(v) => {
                        if (v === '') updateRule(sel.id, { sessionId: null, kinds: [] })
                        else if (v.startsWith('kind:'))
                          updateRule(sel.id, { sessionId: null, kinds: [v.slice(5) as ConnectionKind] })
                        else updateRule(sel.id, { sessionId: v, kinds: [] })
                      }}
                      options={[
                        { value: '', label: '全部支持告警的会话' },
                        ...Object.entries(KIND_META)
                          .filter(([k]) => KIND_CAPS[k as ConnectionKind].alertRule)
                          .map(([k, m]) => ({ value: 'kind:' + k, label: '按类型 · ' + m.label, group: '连接类型' })),
                        ...alertSessions.map((s) => ({ value: s.id, label: s.name, group: '指定会话' }))
                      ]}
                    />
                    <span style={st.note}>
                      按类型生效时换设备重建会话不用重配；指定会话适合临时排查
                    </span>
                  </label>

                  <label style={st.row}>
                    <span style={st.lbl}>方向</span>
                    <Select
                      size="sm"
                      style={{ width: 120 }}
                      value={sel.direction}
                      onChange={(v) => updateRule(sel.id, { direction: v as AlertRule['direction'] })}
                      options={[
                        { value: 'rx', label: '接收' },
                        { value: 'tx', label: '发送' },
                        { value: 'any', label: '不限' }
                      ]}
                    />
                    <span style={st.lbl2}>判定对象</span>
                    <Select
                      size="sm"
                      style={{ width: 130 }}
                      value={sel.source}
                      onChange={(v) => {
                        const source = v as AlertSource
                        // 切到文本时把数值类运算换掉，否则会留下「文本 大于 80」这种无效组合
                        const op: AlertOp =
                          source === 'text'
                            ? TEXT_OPS.some((o) => o.value === sel.op)
                              ? sel.op
                              : 'contains'
                            : NUM_OPS.some((o) => o.value === sel.op)
                              ? sel.op
                              : 'gt'
                        updateRule(sel.id, { source, op })
                      }}
                      options={SOURCE_OPTS}
                    />
                  </label>

                  {sel.source !== 'text' && (
                    <label style={st.row}>
                      <span style={st.lbl}>解析模板</span>
                      <Select
                        size="sm"
                        style={{ width: 200 }}
                        value={sel.templateId ?? 'auto'}
                        onChange={(v) => updateRule(sel.id, { templateId: v })}
                        options={[
                          { value: 'auto', label: '按前缀自动匹配' },
                          ...ruleTemplates.map((t) => ({ value: t.id, label: t.name, group: '模板' }))
                        ]}
                      />
                      {ruleTemplates.length === 0 && (
                        <span style={st.warnNote}>还没有可用模板，请先在会话工具栏「模板」里建一个</span>
                      )}
                    </label>
                  )}

                  {sel.source === 'field' && (
                    <label style={st.row}>
                      <span style={st.lbl}>字段</span>
                      {fieldOpts.length > 0 ? (
                        <Select
                          size="sm"
                          style={{ width: 200 }}
                          value={sel.field ?? ''}
                          onChange={(v) => updateRule(sel.id, { field: v })}
                          options={fieldOpts}
                          placeholder="选择字段"
                        />
                      ) : (
                        <input
                          style={st.input}
                          value={sel.field ?? ''}
                          onChange={(e) => updateRule(sel.id, { field: e.target.value })}
                          placeholder="字段名，与模板里一致"
                        />
                      )}
                    </label>
                  )}

                  {sel.source !== 'checksum' && (
                    <label style={st.row}>
                      <span style={st.lbl}>条件</span>
                      <Select
                        size="sm"
                        style={{ width: 140 }}
                        value={sel.op}
                        onChange={(v) => updateRule(sel.id, { op: v as AlertOp })}
                        options={opOpts}
                      />
                      <input
                        style={st.val}
                        value={sel.value ?? ''}
                        onChange={(e) => updateRule(sel.id, { value: e.target.value })}
                        placeholder={sel.source === 'text' ? '关键字 / 正则' : '阈值'}
                      />
                      {needsRange && (
                        <>
                          <span style={st.note}>~</span>
                          <input
                            style={st.val}
                            value={sel.value2 ?? ''}
                            onChange={(e) => updateRule(sel.id, { value2: e.target.value })}
                            placeholder="上限"
                          />
                        </>
                      )}
                    </label>
                  )}

                  {sel.source === 'checksum' && (
                    <div style={st.note}>校验判定不需要阈值：模板配了校验方式，校验不符即命中。</div>
                  )}

                  <label style={st.row}>
                    <span style={st.lbl}>级别</span>
                    <Select
                      size="sm"
                      style={{ width: 120 }}
                      value={sel.severity}
                      onChange={(v) => updateRule(sel.id, { severity: v as AlertSeverity })}
                      options={[
                        { value: 'warn', label: '警告' },
                        { value: 'error', label: '错误' }
                      ]}
                    />
                    <span style={st.lbl2}>冷却</span>
                    <Select
                      size="sm"
                      style={{ width: 120 }}
                      value={String(sel.cooldownSec)}
                      onChange={(v) => updateRule(sel.id, { cooldownSec: Number(v) || 0 })}
                      options={COOLDOWNS}
                    />
                    <span style={st.note}>同一规则在冷却期内只记一次，避免刷屏</span>
                  </label>

                  <div style={st.row}>
                    <span style={st.lbl}>命中动作</span>
                    <label style={st.check}>
                      <input
                        type="checkbox"
                        checked={sel.highlight}
                        onChange={(e) => updateRule(sel.id, { highlight: e.target.checked })}
                      />
                      高亮报文行
                    </label>
                    <label style={st.check}>
                      <input
                        type="checkbox"
                        checked={sel.notify}
                        onChange={(e) => updateRule(sel.id, { notify: e.target.checked })}
                      />
                      系统通知
                    </label>
                    <label style={st.check} title="出问题就停下来保留现场，适合抓偶发故障">
                      <input
                        type="checkbox"
                        checked={sel.stopSession}
                        onChange={(e) => updateRule(sel.id, { stopSession: e.target.checked })}
                      />
                      自动断开会话
                    </label>
                    <label style={st.check}>
                      <input
                        type="checkbox"
                        checked={sel.enabled}
                        onChange={(e) => updateRule(sel.id, { enabled: e.target.checked })}
                      />
                      启用
                    </label>
                  </div>

                  <div style={st.actions}>
                    <span style={st.note}>
                      已命中 {sel.hits ?? 0} 次
                      {sel.lastFiredAt ? ' · 最近 ' + new Date(sel.lastFiredAt).toLocaleTimeString() : ''}
                    </span>
                    <span style={st.spacer} />
                    <button style={st.ghost} onClick={() => duplicateRule(sel.id)}>复制</button>
                    <button
                      style={st.danger}
                      onClick={() => {
                        removeRule(sel.id)
                        setSelId(null)
                      }}
                    >
                      删除规则
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
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
    zIndex: 60
  },
  panel: {
    width: 'min(1080px, 94vw)',
    height: 'min(680px, 88vh)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0
  },
  title: { fontWeight: 600, fontSize: 'var(--fs-md)' },
  tabs: { display: 'flex', gap: 2, padding: 2, background: 'var(--bg-inset)', borderRadius: 'var(--r-md)' },
  tab: {
    height: 24,
    padding: '0 12px',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-sm)'
  },
  tabOn: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  spacer: { flex: 1 },
  ghost: {
    padding: '5px 12px',
    background: 'var(--btn2-bg)',
    color: 'var(--text-1)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)'
  },
  danger: {
    padding: '5px 12px',
    background: 'transparent',
    color: 'var(--error)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)'
  },
  close: { background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 'var(--fs-lg)' },
  // 记录页整页一条竖向滚动：告警是按时间读的，分栏反而打断阅读顺序
  timeline: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: 12 },
  evRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    background: 'var(--bg-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-xs)'
  },
  evDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  evTime: { width: 150, flexShrink: 0, fontFamily: 'var(--font-mono)', color: 'var(--text-1)' },
  evKind: { width: 34, flexShrink: 0, color: 'var(--text-2)' },
  evTitle: { width: 150, flexShrink: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--text-0)' },
  evSource: { width: 170, flexShrink: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--text-2)' },
  evDetail: { flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--text-1)' },
  evSnap: {
    width: 190,
    flexShrink: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-3)'
  },
  body: { flex: 1, display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 0 },
  left: { display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', minHeight: 0 },
  // 规则表单可能比面板高（字段多、说明长），右栏独立滚动，避免最后一行按钮被切掉
  right: { display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', background: 'var(--bg-0)' },
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px 6px',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-2)'
  },
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
  form: { display: 'flex', flexDirection: 'column', gap: 10, padding: 14 },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-1)', flexWrap: 'wrap' },
  lbl: { width: 68, flexShrink: 0, color: 'var(--text-2)', fontSize: 'var(--fs-sm)' },
  lbl2: { flexShrink: 0, color: 'var(--text-2)', fontSize: 'var(--fs-sm)', marginLeft: 6 },
  note: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  warnNote: { fontSize: 'var(--fs-xs)', color: 'var(--warn)' },
  input: {
    flex: 1,
    minWidth: 180,
    height: 'var(--control-h-sm)',
    padding: '0 8px',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    outline: 'none'
  },
  val: {
    width: 130,
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
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 6,
    borderTop: '1px solid var(--border-subtle)'
  },
  empty: { padding: 16, fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: 1.7 }
}
