import { useMemo, useState } from 'react'
import type {
  HttpLogEntry,
  HttpMockConfig,
  HttpMockRoute,
  HttpMockScenario,
  Session
} from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { Select } from '../../components/ui/Select'
import { defaultHttpMockConfig } from './defaults'
import {
  draftsFromLogs,
  draftToRoute,
  findExisting,
  snapshotName,
  type RouteDraft
} from './logToRoute'

/**
 * 录制转路由面板。
 *
 * 工作流是「先放真实流量过去，再把它固化成 Mock」：
 * 开代理透传 → 让前端照常跑一遍 → 打开这个面板勾选要留下的接口 → 一键生成路由。
 * 比手写路由省的不只是打字，更重要的是响应体来自真实后端，字段不会漏也不会猜错。
 */
export function RecorderPanel({
  session,
  logs,
  onClose,
  onOpenRoutes
}: {
  session: Session
  logs: HttpLogEntry[]
  onClose: () => void
  onOpenRoutes: () => void
}): JSX.Element {
  const updateHttpMock = useStore((s) => s.updateHttpMock)
  const cfg = (session.config.httpMock as HttpMockConfig) ?? defaultHttpMockConfig()

  const [onlyUnmatched, setOnlyUnmatched] = useState(true)
  const [skipErrors, setSkipErrors] = useState(true)
  const [dupMode, setDupMode] = useState<'skip' | 'overwrite'>('skip')
  const [asScenario, setAsScenario] = useState(false)
  const [scName, setScName] = useState(snapshotName())
  // 排除集而不是选中集：默认全选，用户通常只想剔掉少数几条
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [done, setDone] = useState('')

  const drafts = useMemo(
    () => draftsFromLogs(logs, { onlyUnmatched, skipErrors }),
    [logs, onlyUnmatched, skipErrors]
  )

  const picked = drafts.filter((d) => !excluded.has(d.key))
  const existingCount = picked.filter((d) => findExisting(cfg.routes, d)).length

  const toggle = (key: string): void => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const generate = (): void => {
    if (picked.length === 0) return
    let routes = [...cfg.routes]
    const touched: Array<{ draft: RouteDraft; routeId: string }> = []
    let added = 0
    let updated = 0
    let skipped = 0

    for (const d of picked) {
      const hit = findExisting(routes, d)
      if (hit) {
        if (dupMode === 'skip') {
          skipped += 1
          // 即使跳过也记进 touched：存快照场景时这条路由仍应被快照覆盖，
          // 否则「保留现有路由 + 想看真实响应」这个组合就实现不了
          touched.push({ draft: d, routeId: hit.id })
          continue
        }
        const next = draftToRoute(d, hit.id)
        routes = routes.map((r) => (r.id === hit.id ? { ...next, name: hit.name } : r))
        updated += 1
        touched.push({ draft: d, routeId: hit.id })
        continue
      }
      const created = draftToRoute(d)
      routes.push(created)
      added += 1
      touched.push({ draft: d, routeId: created.id })
    }

    let scenarios: HttpMockScenario[] = cfg.scenarios ?? []
    let activeScenarioId = cfg.activeScenarioId
    if (asScenario && touched.length > 0) {
      const overrides: HttpMockScenario['overrides'] = {}
      for (const { draft, routeId } of touched) {
        overrides[routeId] = {
          enabled: true,
          respStatus: draft.status,
          bodyType: draft.bodyType,
          respBody: draft.body,
          respHeaders: draft.respHeaders,
          mode: 'template'
        }
      }
      const sc: HttpMockScenario = {
        id: Math.random().toString(36).slice(2),
        name: scName.trim() || snapshotName(),
        note: '由 ' + touched.length + ' 条真实请求录制生成',
        overrides
      }
      scenarios = [...scenarios, sc]
      activeScenarioId = sc.id
    }

    updateHttpMock(session.id, { ...cfg, routes, scenarios, activeScenarioId })
    const parts = [
      added > 0 ? '新增 ' + added + ' 条' : '',
      updated > 0 ? '覆盖 ' + updated + ' 条' : '',
      skipped > 0 ? '跳过已有 ' + skipped + ' 条' : '',
      asScenario ? '并存为场景「' + (scName.trim() || snapshotName()) + '」' : ''
    ].filter(Boolean)
    setDone(parts.join(' · ') || '没有变化')
  }

  const proxyOn = cfg.fallthrough === 'proxy' && Boolean(cfg.proxyTarget)

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.panel} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <span style={st.title}>录制转路由</span>
          <span style={st.hint}>把真实请求整理成 Mock 路由，路径中的 id 自动变成参数</span>
          <button style={st.close} onClick={onClose}>✕</button>
        </div>

        {!proxyOn && (
          <div style={st.tip}>
            当前未开启代理透传。只有开启后未命中的请求才会转发到真实后端并留下响应，
            否则这里能录到的只有 404。可在「路由配置 → 未命中处理」里改成代理透传并填上游地址。
            <button style={st.tipBtn} onClick={onOpenRoutes}>去设置</button>
          </div>
        )}

        <div style={st.opts}>
          <label style={st.check}>
            <input type="checkbox" checked={onlyUnmatched} onChange={(e) => setOnlyUnmatched(e.target.checked)} />
            只转未命中路由的请求
          </label>
          <label style={st.check}>
            <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} />
            忽略 4xx / 5xx
          </label>
          <span style={st.gap} />
          <span style={st.lbl}>已有同路径</span>
          <Select
            size="sm"
            style={{ width: 116 }}
            value={dupMode}
            onChange={(v) => setDupMode(v as 'skip' | 'overwrite')}
            options={[
              { value: 'skip', label: '跳过' },
              { value: 'overwrite', label: '覆盖' }
            ]}
          />
        </div>

        <div style={st.opts}>
          <label style={st.check}>
            <input type="checkbox" checked={asScenario} onChange={(e) => setAsScenario(e.target.checked)} />
            同时存为场景
          </label>
          {asScenario && (
            <input
              style={st.scInput}
              value={scName}
              onChange={(e) => setScName(e.target.value)}
              placeholder="场景名"
            />
          )}
          <span style={st.gap} />
          <span style={st.lbl}>
            {drafts.length === 0
              ? '没有可转换的请求'
              : '共 ' + drafts.length + ' 条，已选 ' + picked.length +
                (existingCount > 0 ? ' · 其中 ' + existingCount + ' 条已存在' : '')}
          </span>
        </div>

        <div style={st.list}>
          {drafts.length === 0 && (
            <div style={st.empty}>
              还没有可用的请求日志。启动 Mock 服务、开代理透传，让前端或接口工具跑一遍即可。
            </div>
          )}
          {drafts.map((d) => {
            const off = excluded.has(d.key)
            const hit = findExisting(cfg.routes, d)
            return (
              <div key={d.key} style={{ ...st.row, ...(off ? st.rowOff : {}) }}>
                <input type="checkbox" checked={!off} onChange={() => toggle(d.key)} />
                <span style={st.method}>{d.method}</span>
                <span style={st.pattern} title={'示例：' + d.samplePath}>{d.pattern}</span>
                <span style={st.status}>{d.status}</span>
                <span style={st.count}>×{d.count}</span>
                {d.params.length > 0 && <span style={st.chip}>{d.params.map((p) => ':' + p).join(' ')}</span>}
                {d.varied && (
                  <span style={st.warn} title="同一路径出现过不同响应体，转成静态路由只能回放其中一份；需要动态可改用脚本模式">
                    响应不一致
                  </span>
                )}
                {hit && <span style={st.dup} title={'已有路由：' + hit.name}>已存在</span>}
                <span style={st.bodyPeek} title={d.body}>{peek(d.body)}</span>
              </div>
            )
          })}
        </div>

        <div style={st.footer}>
          {done && <span style={st.doneMsg}>{done}</span>}
          <span style={st.gap} />
          <button style={st.ghost} onClick={() => setExcluded(new Set(drafts.map((d) => d.key)))}>全不选</button>
          <button style={st.ghost} onClick={() => setExcluded(new Set())}>全选</button>
          <button style={st.primary} disabled={picked.length === 0} onClick={generate}>
            生成 {picked.length} 条路由
          </button>
        </div>
      </div>
    </div>
  )
}

/** 响应体预览：只取首行并截断，列表里不适合铺开 JSON */
function peek(body: string): string {
  const first = body.split('\n')[0] ?? ''
  return first.length > 46 ? first.slice(0, 46) + '…' : first
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
    zIndex: 55
  },
  panel: {
    width: 880,
    maxWidth: '94vw',
    height: 620,
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden'
  },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontWeight: 600 },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  close: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 16 },
  tip: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 16px',
    background: 'var(--bg-2)',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-1)',
    lineHeight: 'var(--lh-normal)'
  },
  tipBtn: { flexShrink: 0, padding: '3px 10px', background: 'var(--btn2-bg)', color: 'var(--text-0)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  opts: { display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  lbl: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  gap: { flex: 1 },
  scInput: {
    width: 200,
    height: 'var(--control-h)',
    padding: '0 var(--control-px)',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    outline: 'none'
  },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px' },
  empty: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)', textAlign: 'center', padding: 28, lineHeight: 'var(--lh-normal)' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    marginBottom: 3,
    background: 'var(--bg-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)'
  },
  // 未选中只降透明度，不换底色：换底色在深色主题下容易读成「禁用」
  rowOff: { opacity: 0.45 },
  method: { width: 52, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  pattern: { flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: 'var(--font-mono)' },
  status: { width: 34, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  count: { width: 34, flexShrink: 0, fontSize: 'var(--fs-micro)', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' },
  chip: { flexShrink: 0, padding: '1px 7px', background: 'var(--selected-strong-bg)', color: 'var(--text-0)', borderRadius: 10, fontSize: 'var(--fs-micro)', fontFamily: 'var(--font-mono)' },
  warn: { flexShrink: 0, padding: '1px 7px', border: '1px solid var(--warn)', color: 'var(--warn)', borderRadius: 10, fontSize: 'var(--fs-micro)' },
  dup: { flexShrink: 0, padding: '1px 7px', background: 'var(--bg-inset)', color: 'var(--text-2)', borderRadius: 10, fontSize: 'var(--fs-micro)' },
  bodyPeek: { width: 210, flexShrink: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--text-3)', fontSize: 'var(--fs-micro)', fontFamily: 'var(--font-mono)' },
  footer: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: '1px solid var(--border)' },
  doneMsg: { fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  ghost: { padding: '5px 12px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  primary: { padding: '6px 16px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)' }
}
