import { useState } from 'react'
import type {
  HttpBodyType,
  HttpMethod,
  HttpMockConfig,
  HttpMockRoute,
  HttpMockScenario,
  HttpRouteMode,
  HttpScenarioOverride,
  Session
} from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { defaultHttpMockConfig, emptyRoute, emptyScenario } from './defaults'
import { Select } from '../../components/ui/Select'
import { ResizableTextarea } from '../../components/ui/ResizableTextarea'

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ANY']

export function HttpMockPanel({ session, onClose }: { session: Session; onClose: () => void }): JSX.Element {
  const updateHttpMock = useStore((s) => s.updateHttpMock)
  const initial = (session.config.httpMock as HttpMockConfig) ?? defaultHttpMockConfig()
  const [cfg, setCfg] = useState<HttpMockConfig>(initial)
  const [selId, setSelId] = useState<string | null>(initial.routes[0]?.id ?? null)
  const [renaming, setRenaming] = useState(false)
  // 代码框高度提为状态：原生 resize 在滚动容器里会被回压，拉了没反应
  const [codeH, setCodeH] = useState(180)
  const [ovH, setOvH] = useState(120)

  const commit = (next: HttpMockConfig): void => {
    setCfg(next)
    updateHttpMock(session.id, next)
  }

  const patchRoute = (id: string, patch: Partial<HttpMockRoute>): void => {
    commit({ ...cfg, routes: cfg.routes.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
  }

  const addRoute = (): void => {
    const r = emptyRoute()
    commit({ ...cfg, routes: [...cfg.routes, r] })
    setSelId(r.id)
  }

  const delRoute = (id: string): void => {
    const rest = cfg.routes.filter((r) => r.id !== id)
    commit({ ...cfg, routes: rest })
    if (selId === id) setSelId(rest[0]?.id ?? null)
  }

  const scenarios = cfg.scenarios ?? []
  const activeSc = scenarios.find((s) => s.id === cfg.activeScenarioId) ?? null

  const patchScenario = (id: string, patch: Partial<HttpMockScenario>): void => {
    commit({ ...cfg, scenarios: scenarios.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }

  const addScenario = (): void => {
    const s = emptyScenario()
    commit({ ...cfg, scenarios: [...scenarios, s], activeScenarioId: s.id })
    setRenaming(true)
  }

  const delScenario = (): void => {
    if (!activeSc) return
    commit({
      ...cfg,
      scenarios: scenarios.filter((s) => s.id !== activeSc.id),
      activeScenarioId: undefined
    })
    setRenaming(false)
  }

  /** 修改当前场景对某条路由的覆盖；传 undefined 表示移除该字段的覆盖 */
  const patchOverride = (routeId: string, patch: HttpScenarioOverride): void => {
    if (!activeSc) return
    const prev = activeSc.overrides?.[routeId] ?? {}
    const next: HttpScenarioOverride = { ...prev, ...patch }
    for (const k of Object.keys(next) as (keyof HttpScenarioOverride)[]) {
      if (next[k] === undefined) delete next[k]
    }
    const overrides = { ...(activeSc.overrides ?? {}) }
    if (Object.keys(next).length === 0) delete overrides[routeId]
    else overrides[routeId] = next
    patchScenario(activeSc.id, { overrides })
  }

  const sel = cfg.routes.find((r) => r.id === selId) ?? null
  const ov: HttpScenarioOverride = (sel && activeSc?.overrides?.[sel.id]) || {}
  /** 勾选/取消某字段的覆盖：勾选时以路由当前值为初始覆盖值 */
  const toggleOv = (key: keyof HttpScenarioOverride, on: boolean): void => {
    if (!sel) return
    if (!on) { patchOverride(sel.id, { [key]: undefined } as HttpScenarioOverride); return }
    const seed: HttpScenarioOverride = {}
    if (key === 'enabled') seed.enabled = false
    else if (key === 'respStatus') seed.respStatus = sel.respStatus || 200
    else if (key === 'respBody') { seed.respBody = sel.respBody; seed.bodyType = sel.bodyType }
    else if (key === 'delayMs') seed.delayMs = sel.delayMs || 0
    patchOverride(sel.id, seed)
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>HTTP Mock 路由 · {session.name}</span>
          <button style={styles.close} onClick={onClose}>✕</button>
        </div>

        <div style={styles.topRow}>
          <label style={styles.switch}>
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => commit({ ...cfg, enabled: e.target.checked })} />
            启用 Mock
          </label>
          <label style={styles.switch}>
            <input type="checkbox" checked={cfg.corsEnabled} onChange={(e) => commit({ ...cfg, corsEnabled: e.target.checked })} />
            自动 CORS
          </label>
          <label style={styles.switch}>
            未命中
            <Select
  value={cfg.fallthrough}
  onChange={(v) => commit({ ...cfg, fallthrough: v as 'notFound' | 'proxy' })}
  style={styles.miniSelect}
  options={[{ value: "notFound", label: "返回 404" }, { value: "proxy", label: "代理透传" }]}
/>
          </label>
          {cfg.fallthrough === 'proxy' && (
            <input
              style={styles.proxy}
              value={cfg.proxyTarget ?? ''}
              placeholder="http://127.0.0.1:8000"
              onChange={(e) => commit({ ...cfg, proxyTarget: e.target.value })}
            />
          )}
        </div>

        <div style={styles.scRow}>
          <span style={styles.scLabel}>场景</span>
          <Select
            size="sm"
            style={{ minWidth: 150 }}
            value={cfg.activeScenarioId ?? ''}
            onChange={(v) => { setRenaming(false); commit({ ...cfg, activeScenarioId: v || undefined }) }}
            options={[
              { value: '', label: '默认（无覆盖）' },
              ...scenarios.map((s) => ({ value: s.id, label: s.name, group: '场景' }))
            ]}
          />
          {activeSc && renaming ? (
            <input
              autoFocus
              style={styles.scName}
              value={activeSc.name}
              onChange={(e) => patchScenario(activeSc.id, { name: e.target.value })}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setRenaming(false) }}
            />
          ) : (
            <span style={styles.scNote}>
              {activeSc
                ? activeSc.note || `覆盖 ${Object.keys(activeSc.overrides ?? {}).length} 条路由`
                : '所有路由按原始配置响应'}
            </span>
          )}
          <span style={styles.spacer} />
          <button style={styles.scBtn} onClick={addScenario}>+ 新建</button>
          {activeSc && <button style={styles.scBtn} onClick={() => setRenaming(true)}>重命名</button>}
          {activeSc && <button style={styles.del} onClick={delScenario}>删除场景</button>}
        </div>

        <div style={styles.fault}>
          <label style={styles.switch}>
            <input type="checkbox" checked={cfg.fault.enabled} onChange={(e) => commit({ ...cfg, fault: { ...cfg.fault, enabled: e.target.checked } })} />
            故障注入
          </label>
          {activeSc?.fault && (
            <span style={styles.scBadge}>
              场景「{activeSc.name}」已接管故障注入：{activeSc.fault.enabled ? `${Math.round((activeSc.fault.failRate || 0) * 100)}% → ${activeSc.fault.failStatus}` : '关闭'}
            </span>
          )}
          {cfg.fault.enabled && (
            <>
              <span style={styles.faultLabel}>失败概率</span>
              <input style={styles.faultInput} value={String(cfg.fault.failRate)} onChange={(e) => commit({ ...cfg, fault: { ...cfg.fault, failRate: Number(e.target.value) || 0 } })} placeholder="0~1" />
              <span style={styles.faultLabel}>失败码</span>
              <input style={styles.faultInput} value={String(cfg.fault.failStatus)} onChange={(e) => commit({ ...cfg, fault: { ...cfg.fault, failStatus: Number(e.target.value) || 500 } })} />
              <span style={styles.faultLabel}>额外延迟(ms)</span>
              <input style={styles.faultInput} value={String(cfg.fault.extraDelayMs)} onChange={(e) => commit({ ...cfg, fault: { ...cfg.fault, extraDelayMs: Number(e.target.value) || 0 } })} />
            </>
          )}
        </div>

        <div style={styles.body}>
          <div style={styles.listCol}>
            <button style={styles.addBtn} onClick={addRoute}>+ 添加路由</button>
            <div style={styles.list}>
              {cfg.routes.length === 0 && <div style={styles.empty}>暂无路由</div>}
              {cfg.routes.map((r) => (
                <button
                  key={r.id}
                  style={{ ...styles.listItem, ...(r.id === selId ? styles.listActive : {}) }}
                  onClick={() => setSelId(r.id)}
                >
                  <span style={{ ...styles.method, opacity: r.enabled ? 1 : 0.4 }}>{r.method}</span>
                  <span style={styles.listPath}>{r.pathPattern}</span>
                  {activeSc?.overrides?.[r.id] && <span style={styles.ovDot} title="当前场景已覆盖">●</span>}
                </button>
              ))}
            </div>
          </div>

          <div style={styles.detail}>
            {!sel && <div style={styles.empty}>选择或新建一条路由</div>}
            {sel && (
              <>
                <div style={styles.detailHead}>
                  <label style={styles.switch}>
                    <input type="checkbox" checked={sel.enabled} onChange={(e) => patchRoute(sel.id, { enabled: e.target.checked })} />
                    启用
                  </label>
                  <input style={styles.nameInput} value={sel.name} onChange={(e) => patchRoute(sel.id, { name: e.target.value })} />
                  <span style={styles.spacer} />
                  <button style={styles.del} onClick={() => delRoute(sel.id)}>删除</button>
                </div>

                <div style={styles.line}>
                  <Select
                    size="sm"
                    style={{ width: 96, fontFamily: 'var(--font-mono)' }}
                    value={sel.method}
                    onChange={(v) => patchRoute(sel.id, { method: v as HttpMethod })}
                    options={METHODS.map((m) => ({ value: m, label: m }))}
                  />
                  <input style={styles.pathInput} value={sel.pathPattern} onChange={(e) => patchRoute(sel.id, { pathPattern: e.target.value })} placeholder="/api/users/:id 或 re:^/x" />
                  <input style={styles.prioInput} type="number" value={sel.priority} onChange={(e) => patchRoute(sel.id, { priority: Number(e.target.value) || 0 })} title="优先级(大在前)" />
                </div>

                <div style={styles.line}>
                  <input style={styles.filterInput} value={sel.matchQuery ?? ''} onChange={(e) => patchRoute(sel.id, { matchQuery: e.target.value })} placeholder="匹配 Query 如 status=ok（可空）" />
                  <input style={styles.filterInput} value={sel.matchHeader ?? ''} onChange={(e) => patchRoute(sel.id, { matchHeader: e.target.value })} placeholder="匹配 Header 如 x-token: abc（可空）" />
                </div>

                <div style={styles.line}>
                  <label style={styles.miniLabel}>响应模式</label>
                  <Select
  value={sel.mode}
  onChange={(v) => patchRoute(sel.id, { mode: v as HttpRouteMode })}
  style={styles.miniSelect}
  options={[{ value: "template", label: "模板" }, { value: "script", label: "脚本" }]}
/>
                  {sel.mode === 'template' && (
                    <>
                      <label style={styles.miniLabel}>状态码</label>
                      <input style={styles.statusInput} value={String(sel.respStatus)} onChange={(e) => patchRoute(sel.id, { respStatus: Number(e.target.value) || 200 })} />
                      <label style={styles.miniLabel}>类型</label>
                      <Select
  value={sel.bodyType}
  onChange={(v) => patchRoute(sel.id, { bodyType: v as HttpBodyType })}
  style={styles.miniSelect}
  options={[{ value: "json", label: "JSON" }, { value: "text", label: "Text" }, { value: "xml", label: "XML" }, { value: "base64", label: "Base64" }]}
/>
                    </>
                  )}
                  <label style={styles.miniLabel}>延迟(ms)</label>
                  <input style={styles.statusInput} value={String(sel.delayMs)} onChange={(e) => patchRoute(sel.id, { delayMs: Number(e.target.value) || 0 })} />
                </div>

                {sel.mode === 'template' ? (
                  <>
                    <label style={styles.miniLabel}>响应体（支持 {'{{path.id}} {{query.x}} {{body.f}} {{now}} {{uuid}} {{sequence}}'}）</label>
                    {/* 受控高度：模板与脚本都可能几十行，原生手柄在滚动容器里拉不动 */}
                    <ResizableTextarea value={sel.respBody} onChange={(v) => patchRoute(sel.id, { respBody: v })} height={codeH} onHeightChange={setCodeH} min={110} max={560} />
                  </>
                ) : (
                  <>
                    <label style={styles.miniLabel}>脚本 handler(req, res, state)：可读 req.method/path/params/query/headers/body/json；写 res.status/headers/body</label>
                    <ResizableTextarea
                      value={sel.script ?? ''}
                      onChange={(v) => patchRoute(sel.id, { script: v })}
                      height={codeH}
                      onHeightChange={setCodeH}
                      min={110}
                      max={560}
                      placeholder={"res.status = 200\nres.body = { id: req.params.id, ts: Date.now() }"}
                    />
                  </>
                )}

                {activeSc && (
                  <div style={styles.ovBox}>
                    <div style={styles.ovHead}>
                      <span style={styles.ovTitle}>场景「{activeSc.name}」对本路由的覆盖</span>
                      <span style={styles.spacer} />
                      {Object.keys(ov).length > 0 && (
                        <button style={styles.scBtn} onClick={() => patchOverride(sel.id, { enabled: undefined, respStatus: undefined, respBody: undefined, bodyType: undefined, delayMs: undefined })}>
                          清空覆盖
                        </button>
                      )}
                    </div>

                    <div style={styles.line}>
                      <label style={styles.switch}>
                        <input type="checkbox" checked={ov.enabled !== undefined} onChange={(e) => toggleOv('enabled', e.target.checked)} />
                        覆盖启用状态
                      </label>
                      {ov.enabled !== undefined && (
                        <Select
  value={ov.enabled ? '1' : '0'}
  onChange={(v) => patchOverride(sel.id, { enabled: v === '1' })}
  style={styles.miniSelect}
  options={[{ value: "1", label: "启用" }, { value: "0", label: "禁用（走未命中）" }]}
/>
                      )}
                    </div>

                    <div style={styles.line}>
                      <label style={styles.switch}>
                        <input type="checkbox" checked={ov.respStatus !== undefined} onChange={(e) => toggleOv('respStatus', e.target.checked)} />
                        覆盖状态码
                      </label>
                      {ov.respStatus !== undefined && (
                        <input style={styles.statusInput} value={String(ov.respStatus)} onChange={(e) => patchOverride(sel.id, { respStatus: Number(e.target.value) || 200 })} />
                      )}
                      <label style={styles.switch}>
                        <input type="checkbox" checked={ov.delayMs !== undefined} onChange={(e) => toggleOv('delayMs', e.target.checked)} />
                        覆盖延迟(ms)
                      </label>
                      {ov.delayMs !== undefined && (
                        <input style={styles.statusInput} value={String(ov.delayMs)} onChange={(e) => patchOverride(sel.id, { delayMs: Number(e.target.value) || 0 })} />
                      )}
                    </div>

                    <div style={styles.line}>
                      <label style={styles.switch}>
                        <input type="checkbox" checked={ov.respBody !== undefined} onChange={(e) => toggleOv('respBody', e.target.checked)} />
                        覆盖响应体
                      </label>
                      {ov.respBody !== undefined && (
                        <Select
  value={ov.bodyType ?? sel.bodyType}
  onChange={(v) => patchOverride(sel.id, { bodyType: v as HttpBodyType })}
  style={styles.miniSelect}
  options={[{ value: "json", label: "JSON" }, { value: "text", label: "文本" }, { value: "xml", label: "XML" }, { value: "base64", label: "Base64" }]}
/>
                      )}
                    </div>
                    {ov.respBody !== undefined && (
                      <ResizableTextarea value={ov.respBody} onChange={(v) => patchOverride(sel.id, { respBody: v })} height={ovH} onHeightChange={setOvH} min={80} max={420} />
                    )}

                    <div style={styles.line}>
                      <label style={styles.switch}>
                        <input
                          type="checkbox"
                          checked={activeSc.fault !== undefined}
                          onChange={(e) =>
                            patchScenario(activeSc.id, {
                              fault: e.target.checked
                                ? { enabled: true, failRate: 1, failStatus: 500, extraDelayMs: 0 }
                                : undefined
                            })
                          }
                        />
                        本场景自带故障注入（作用于全部路由）
                      </label>
                    </div>
                    {activeSc.fault && (
                      <div style={styles.line}>
                        <span style={styles.faultLabel}>失败概率</span>
                        <input style={styles.faultInput} value={String(activeSc.fault.failRate)} onChange={(e) => patchScenario(activeSc.id, { fault: { ...activeSc.fault!, failRate: Number(e.target.value) || 0 } })} placeholder="0~1" />
                        <span style={styles.faultLabel}>失败码</span>
                        <input style={styles.faultInput} value={String(activeSc.fault.failStatus)} onChange={(e) => patchScenario(activeSc.id, { fault: { ...activeSc.fault!, failStatus: Number(e.target.value) || 500 } })} />
                        <span style={styles.faultLabel}>额外延迟(ms)</span>
                        <input style={styles.faultInput} value={String(activeSc.fault.extraDelayMs)} onChange={(e) => patchScenario(activeSc.id, { fault: { ...activeSc.fault!, extraDelayMs: Number(e.target.value) || 0 } })} />
                      </div>
                    )}

                    <textarea style={styles.ovNote} value={activeSc.note ?? ''} placeholder="场景备注：这个场景用来验证什么" onChange={(e) => patchScenario(activeSc.id, { note: e.target.value })} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 50 },
  panel: { width: 860, maxWidth: '94vw', height: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontWeight: 600 },
  close: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 16 },
  topRow: { display: 'flex', alignItems: 'center', gap: 14, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },
  switch: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  miniSelect: { background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '3px 6px', fontSize: 'var(--fs-sm)' },
  proxy: { flex: 1, minWidth: 180, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  fault: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },
  faultLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  faultInput: { width: 70, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '3px 6px', fontSize: 'var(--fs-sm)' },
  body: { flex: 1, display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 0 },
  listCol: { display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', minHeight: 0 },
  addBtn: { margin: 10, padding: '7px 10px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)' },
  list: { flex: 1, overflowY: 'auto', padding: '0 8px 8px' },
  listItem: { display: 'flex', gap: 8, width: '100%', alignItems: 'center', padding: '7px 8px', marginBottom: 4, background: 'transparent', color: 'var(--text-0)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', textAlign: 'left' },
  listActive: { background: 'var(--bg-3)', border: '1px solid transparent' },
  method: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--accent)', width: 46, flexShrink: 0 },
  listPath: { fontSize: 'var(--fs-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detail: { display: 'flex', flexDirection: 'column', gap: 8, padding: 14, overflowY: 'auto', minHeight: 0 },
  detailHead: { display: 'flex', alignItems: 'center', gap: 10 },
  nameInput: { flex: 1, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: 'var(--fs-md)' },
  spacer: { flex: 1 },
  del: { background: 'transparent', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 'var(--r-sm)', padding: '4px 10px', fontSize: 'var(--fs-sm)' },
  line: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  methodSel: { background: 'var(--field-bg)', color: 'var(--accent)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 6px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  pathInput: { flex: 1, minWidth: 200, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  prioInput: { width: 60, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 6px', fontSize: 'var(--fs-sm)' },
  filterInput: { flex: 1, minWidth: 200, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  miniLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  statusInput: { width: 66, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)' },
  code: { width: '100%', minHeight: 160, resize: 'vertical', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', outline: 'none' },
  empty: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)', padding: 20, textAlign: 'center' },
  scRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },
  scLabel: { fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  scSelect: { minWidth: 150, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)' },
  scName: { width: 160, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)' },
  scNote: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 },
  scBtn: { background: 'var(--bg-3)', color: 'var(--text-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '4px 10px', fontSize: 'var(--fs-sm)' },
  scBadge: { fontSize: 'var(--fs-xs)', color: 'var(--conn-warn, var(--text-2))' },
  ovDot: { marginLeft: 'auto', fontSize: 'var(--fs-micro)', color: 'var(--conn-warn, var(--text-2))' },
  ovBox: { marginTop: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-2)', border: '1px dashed var(--border)', borderRadius: 'var(--r-md)' },
  ovHead: { display: 'flex', alignItems: 'center', gap: 8 },
  ovTitle: { fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-0)' },
  ovCode: { width: '100%', minHeight: 110, resize: 'vertical', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', outline: 'none' },
  ovNote: { width: '100%', minHeight: 44, resize: 'vertical', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '6px 8px', fontSize: 'var(--fs-sm)', outline: 'none' }
}