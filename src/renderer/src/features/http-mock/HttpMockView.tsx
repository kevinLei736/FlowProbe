import { useMemo, useState } from 'react'
import type { HttpLogEntry, HttpMockConfig, Session } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { useLayout } from '../../store/useLayout'
import { KIND_META, STATUS_META, keyHint } from '../../app/meta'
import { HttpMockPanel } from './HttpMockPanel'
import { RecorderPanel } from './RecorderPanel'
import { CertPanel } from './CertPanel'
import { mockLogsToHarJson } from './harExport'
import { VirtualList } from '../../components/VirtualList'
import { Select } from '../../components/ui/Select'

export function HttpMockView({ session }: { session: Session }): JSX.Element {
  const logs = useStore((s) => s.httpLogsBySession[session.id] ?? [])
  const start = useStore((s) => s.start)
  const stop = useStore((s) => s.stop)
  const remove = useStore((s) => s.remove)
  const clearHttpLogs = useStore((s) => s.clearHttpLogs)
  const updateHttpMock = useStore((s) => s.updateHttpMock)
  const inspectorVisible = useLayout((s) => s.inspectorVisible)
  const toggleInspector = useLayout((s) => s.toggleInspector)

  const [panelOpen, setPanelOpen] = useState(false)
  const [recOpen, setRecOpen] = useState(false)
  const [certOpen, setCertOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [selId, setSelId] = useState<string | null>(null)

  const meta = KIND_META[session.kind]
  const status = STATUS_META[session.status]
  const running = session.status === 'listening'
  const scheme = session.config.https ? 'https' : 'http'
  const base = `${scheme}://127.0.0.1:${session.config.port ?? 3000}`

  const visible = useMemo(() => {
    if (!filter) return logs
    const kw = filter.toLowerCase()
    return logs.filter((l) => (l.path + ' ' + l.method + ' ' + l.status).toLowerCase().includes(kw))
  }, [logs, filter])

  /**
   * 请求日志导出 HAR 1.2。
   *
   * 导的是 visible 而不是 logs：过滤条件是用户刚刚表达的意图（「我要的是这批」），
   * 导出时忽略它、把全部日志一起塞进去，等于让人回去手工删。
   */
  const exportHar = async (): Promise<void> => {
    if (visible.length === 0) return
    const info = await window.toolbox.appInfo()
    const json = mockLogsToHarJson(visible, base, info.version, session.name)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await window.toolbox.saveTextFile(session.name + '-请求-' + stamp + '.har', json)
  }

  const sel = logs.find((l) => l.id === selId) ?? null

  const mockCfg = session.config.httpMock as HttpMockConfig | undefined
  const scenarios = mockCfg?.scenarios ?? []
  const activeScName = scenarios.find((s) => s.id === mockCfg?.activeScenarioId)?.name
  const proxyOn = mockCfg?.fallthrough === 'proxy' && Boolean(mockCfg.proxyTarget)
  // 启用了 HTTPS 但证书或私钥为空——这是「勾了 HTTPS 却起不来」的根因
  const certMissing =
    session.config.https === true &&
    (!String(session.config.tlsCert ?? '').trim() || !String(session.config.tlsKey ?? '').trim())

  return (
    <div style={styles.wrap}>
      <div style={styles.center}>
        <header style={styles.topbar}>
          <span style={{ ...styles.dot, background: status.color }} />
          <span style={styles.title}>{session.name}</span>
          <span style={styles.badge}>{meta.label}</span>
          <span style={styles.status}>{status.label}</span>
          {running && <a style={styles.link} href={base} onClick={(e) => e.preventDefault()}>{base}</a>}
          {activeScName && <span style={styles.scTag}>场景 {activeScName}</span>}
          <span style={styles.spacer} />
          <span style={styles.metric}>请求 {logs.length}</span>
          {running ? (
            <button style={styles.stopBtn} onClick={() => stop(session.id)}>停止</button>
          ) : (
            <button style={styles.startBtn} onClick={() => start(session.id)}>启动</button>
          )}
        </header>

        <div style={styles.toolbar}>
          <button style={{ ...styles.ghost, background: 'var(--selected-bg)', color: 'var(--text-0)' }} onClick={() => setPanelOpen(true)}>路由配置</button>
          <button
            style={{
              ...styles.ghost,
              // 勾了 HTTPS 却没证书时标红：服务一启动必定失败，这是唯一能提前提示的位置
              ...(certMissing ? { color: 'var(--error)', border: '1px solid var(--error)' } : {})
            }}
            title={
              certMissing
                ? '已启用 HTTPS 但未配置证书，服务将无法启动。点击生成自签证书'
                : 'HTTPS 证书：生成自签、导入或粘贴 PEM'
            }
            onClick={() => setCertOpen(true)}
          >
            {certMissing ? '证书缺失' : '证书'}
          </button>
          <button
            style={styles.ghost}
            // 计数直接写在按钮上：录制的价值取决于「录到了多少」，藏在弹窗里用户不会主动去开
            title="把捕获到的真实请求批量转成 Mock 路由（路径中的 id 自动变成参数）"
            onClick={() => setRecOpen(true)}
          >
            录制转路由{logs.length > 0 ? ' (' + logs.length + ')' : ''}
          </button>
          {proxyOn && <span style={styles.proxyTag} title={'未命中的请求转发到 ' + (mockCfg?.proxyTarget ?? '')}>代理透传</span>}
          {scenarios.length > 0 && mockCfg && (
            <Select
              size="sm"
              style={{ maxWidth: 180, minWidth: 130 }}
              title="切换 Mock 场景：一套路由挂多套响应"
              value={mockCfg.activeScenarioId ?? ''}
              onChange={(v) => updateHttpMock(session.id, { ...mockCfg, activeScenarioId: v || undefined })}
              options={[
                { value: '', label: '默认场景' },
                ...scenarios.map((s) => ({ value: s.id, label: s.name, group: '场景' }))
              ]}
            />
          )}
          <input style={styles.filter} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤 路径/方法/状态..." />
          <label style={styles.check}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
          <span style={styles.spacer} />
          <button style={styles.ghost} title={`显示/隐藏详情 (${keyHint('Ctrl+J')})`} onClick={toggleInspector}>{inspectorVisible ? '隐藏详情' : '详情'}</button>
          <button
            style={styles.ghost}
            title="导出为 HAR 1.2：可直接拖进 Chrome 开发者工具 / Postman / Fiddler 复现（按当前过滤结果导出）"
            disabled={visible.length === 0}
            onClick={() => void exportHar()}
          >
            导出 HAR{visible.length > 0 && visible.length !== logs.length ? ' (' + visible.length + ')' : ''}
          </button>
          <button style={styles.ghost} onClick={() => clearHttpLogs(session.id)}>清空日志</button>
          <button style={styles.ghost} onClick={() => remove(session.id)}>删除会话</button>
        </div>

        <div style={{ ...styles.split, gridTemplateColumns: inspectorVisible ? '1fr 360px' : '1fr' }}>
          {visible.length === 0 ? (
            <div style={{ ...styles.logList, ...styles.empty }}>
              暂无请求。启动后用浏览器或接口工具访问 {base}
            </div>
          ) : (
            <VirtualList
              items={visible}
              keyOf={(l) => l.id}
              estimate={26}
              stickToBottom={autoScroll}
              style={styles.logList}
              rowStyle={{ padding: '0 10px' }}
              padTop={6}
              padBottom={6}
            >
              {(l) => (
                <button
                  style={{ ...styles.logRow, ...(l.id === selId ? styles.logActive : {}) }}
                  onClick={() => setSelId(l.id)}
                >
                  <span style={styles.ts}>{fmtTs(l.ts)}</span>
                  <span style={{ ...styles.method, color: methodColor(l.method) }}>{l.method}</span>
                  <span style={{ ...styles.code, color: statusColor(l.status) }}>{l.status}</span>
                  <span style={styles.dur}>{l.durationMs}ms</span>
                  <span style={styles.path}>{l.path}{l.query ? '?' + l.query : ''}</span>
                  {l.matchedRoute && <span style={styles.route}>{l.matchedRoute}</span>}
                  {l.scenario && <span style={styles.scChip}>{l.scenario}</span>}
                </button>
              )}
            </VirtualList>
          )}

          {inspectorVisible && (
            <div style={styles.inspect}>
              {!sel && <div style={styles.empty}>选择左侧请求查看详情</div>}
              {sel && <LogDetail log={sel} />}
            </div>
          )}
        </div>
      </div>

      {panelOpen && <HttpMockPanel session={session} onClose={() => setPanelOpen(false)} />}
      {certOpen && <CertPanel session={session} onClose={() => setCertOpen(false)} />}
      {recOpen && (
        <RecorderPanel
          session={session}
          logs={logs}
          onClose={() => setRecOpen(false)}
          onOpenRoutes={() => { setRecOpen(false); setPanelOpen(true) }}
        />
      )}
    </div>
  )
}

function LogDetail({ log }: { log: HttpLogEntry }): JSX.Element {
  return (
    <div style={detail.wrap}>
      <div style={detail.h}>请求</div>
      <div style={detail.kv}><b>{log.method}</b> {log.path}{log.query ? '?' + log.query : ''}</div>
      <pre style={detail.pre}>{fmtHeaders(log.reqHeaders)}</pre>
      {log.reqBody ? <pre style={detail.pre}>{log.reqBody}</pre> : null}
      <div style={detail.h}>
        响应 · {log.status} · {log.durationMs}ms{log.matchedRoute ? ' · ' + log.matchedRoute : ''}
        {log.scenario ? ' · 场景 ' + log.scenario : ''}
      </div>
      <pre style={detail.pre}>{fmtHeaders(log.respHeaders)}</pre>
      {log.respBody ? <pre style={detail.pre}>{log.respBody}</pre> : null}
    </div>
  )
}

function fmtHeaders(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n') || '(无)'
}
function fmtTs(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0')
}
function methodColor(m: string): string {
  if (m === 'GET') return 'var(--accent)'
  if (m === 'POST') return 'var(--warn)'
  if (m === 'DELETE') return 'var(--error)'
  return 'var(--text-1)'
}
function statusColor(s: number): string {
  if (s >= 500) return 'var(--error)'
  if (s >= 400) return 'var(--warn)'
  if (s >= 200 && s < 300) return 'var(--accent)'
  return 'var(--text-1)'
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden' },
  center: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' },
  topbar: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)' },
  dot: { width: 9, height: 9, borderRadius: 9 },
  title: { fontWeight: 600 },
  badge: { fontSize: 'var(--fs-xs)', color: 'var(--text-1)', background: 'var(--btn2-bg)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', padding: '2px 6px' },
  status: { fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  link: { fontSize: 'var(--fs-sm)', color: 'var(--accent)', fontFamily: 'var(--font-mono)' },
  spacer: { flex: 1 },
  metric: { fontSize: 'var(--fs-sm)', color: 'var(--text-1)', fontFamily: 'var(--font-mono)' },
  startBtn: { padding: '6px 14px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)' },
  stopBtn: { padding: '6px 14px', background: 'transparent', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 'var(--r-md)' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap', padding: '8px 14px', borderBottom: '1px solid var(--border)' },
  filter: { padding: '4px 8px', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)', width: 200, outline: 'none' },
  check: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  ghost: { padding: '5px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  split: { flex: '1 1 0', display: 'grid', gridTemplateColumns: '1fr 360px', gridTemplateRows: 'minmax(0, 1fr)', minHeight: 0, overflow: 'hidden' },
  logList: { minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', borderRight: '1px solid var(--border)' },
  logRow: { display: 'flex', gap: 8, alignItems: 'baseline', width: '100%', textAlign: 'left', background: 'transparent', color: 'var(--text-0)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', padding: '4px 6px' },
  logActive: { background: 'var(--bg-3)', border: '1px solid var(--border-subtle)' },
  ts: { color: 'var(--text-2)', flexShrink: 0 },
  method: { width: 46, flexShrink: 0 },
  code: { width: 34, flexShrink: 0 },
  dur: { color: 'var(--text-2)', width: 56, flexShrink: 0, textAlign: 'right' },
  path: { color: 'var(--text-0)', wordBreak: 'break-all' },
  route: { color: 'var(--warn)', fontSize: 'var(--fs-xs)', marginLeft: 'auto', flexShrink: 0 },
  scChip: { color: 'var(--text-2)', fontSize: 'var(--fs-xs)', flexShrink: 0, border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-xs)', padding: '0 5px' },
  proxyTag: { flexShrink: 0, padding: '2px 8px', background: 'var(--selected-strong-bg)', color: 'var(--text-0)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  scTag: { fontSize: 'var(--fs-xs)', color: 'var(--text-1)', background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '2px 6px' },
  scSelect: { padding: '4px 6px', background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)', maxWidth: 160 },
  inspect: { overflowY: 'auto', overscrollBehavior: 'contain', padding: 12, minHeight: 0, minWidth: 0 },
  empty: { color: 'var(--text-2)', padding: 20, textAlign: 'center', fontSize: 'var(--fs-sm)' }
}

const detail: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  h: { fontSize: 'var(--fs-sm)', color: 'var(--accent)', fontWeight: 600, marginTop: 4 },
  kv: { fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', color: 'var(--text-0)', wordBreak: 'break-all' },
  pre: { margin: 0, padding: '8px 10px', background: 'var(--bg-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
}