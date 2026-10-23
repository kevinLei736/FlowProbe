import { useEffect, useMemo, useState } from 'react'
import type {
  HttpAssertion,
  HttpAuth,
  HttpExtractRule,
  HttpHeaderKV,
  HttpTestBodyType,
  HttpTestRequest,
  HttpTestResponse,
  SavedHttpRequest
} from '@shared/protocol'
import {
  useApiClient,
  resolveRequest,
  runAssertions,
  runExtracts,
  type AssertResult
} from './useApiClient'
import { CollectionRunner } from './CollectionRunner'
import { historyToHarJson } from './harExport'
import { exportOpenApi, exportPostman, importCollection } from '@shared/collection'
import { Select } from '../../components/ui/Select'
import { ResizableTextarea } from '../../components/ui/ResizableTextarea'

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']

function uid(): string {
  return Math.random().toString(36).slice(2)
}

function blankRequest(): HttpTestRequest {
  return {
    method: 'GET',
    url: 'https://httpbin.org/get',
    query: [],
    headers: [],
    bodyType: 'none',
    body: '',
    auth: { type: 'none' },
    timeoutMs: 30000,
    followRedirects: true,
    rejectUnauthorized: true
  }
}

export function ApiClientPanel({
  onClose,
  onOpenMonitor
}: {
  onClose: () => void
  onOpenMonitor: () => void
}): JSX.Element {
  const {
    collections,
    environments,
    activeEnvId,
    history,
    load,
    saveRequest,
    importRequests,
    removeRequest,
    addEnvironment,
    updateEnvironment,
    removeEnvironment,
    setActiveEnv,
    pushHistory,
    clearHistory
  } = useApiClient()

  const [req, setReq] = useState<HttpTestRequest>(blankRequest())
  const [assertions, setAssertions] = useState<HttpAssertion[]>([])
  const [extracts, setExtracts] = useState<HttpExtractRule[]>([])
  const [extracted, setExtracted] = useState<Record<string, string>>({})
  const [runnerOpen, setRunnerOpen] = useState(false)
  const [res, setRes] = useState<HttpTestResponse | null>(null)
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState<'params' | 'headers' | 'body' | 'auth' | 'tests'>('params')
  // 请求体高度：受控才能真的拉动（原生 resize 会被外层滚动容器与 flex 布局回压）
  const [bodyH, setBodyH] = useState(150)
  const [resTab, setResTab] = useState<'body' | 'headers' | 'tests'>('body')
  const [respView, setRespView] = useState<'pretty' | 'raw'>('pretty')
  const [assertResults, setAssertResults] = useState<AssertResult[]>([])
  const [curName, setCurName] = useState('未命名请求')
  /**
   * 当前编辑的是集合里的哪一条。
   *
   * 原来保存一律 `uid()` 新建，从集合里打开一条请求、改完再保存会变成第二条，
   * 反复调参就会堆出一串同名副本。记住 id 后「保存」是更新，「新建」才换 id。
   */
  const [editingId, setEditingId] = useState<string | null>(null)
  // 导出结果提示。用面板内提示条而不是弹窗：导出是低风险动作，弹窗还要多点一次确认
  const [notice, setNotice] = useState('')

  /**
   * 集合互通。
   *
   * 导入只往当前集合里追加，同名接口不覆盖 —— 用户点「导入」通常是想把别人的
   * 接口并进来对照，静默替换掉自己调好的那份（可能带着断言和变量）损失太大。
   */
  const importCollectionFile = async (): Promise<void> => {
    const file = await window.toolbox.openTextFile('导入接口集合', ['json'])
    if (!file) return
    try {
      const result = importCollection(file.content)
      importRequests(result.requests)
      const tip = result.warnings.length ? `，${result.warnings.length} 条提示` : ''
      setNotice(`已从「${result.name}」导入 ${result.requests.length} 个请求${tip}`)
    } catch (e) {
      setNotice('导入失败：' + String((e as Error)?.message ?? e))
    }
  }

  const exportCollection = async (format: 'postman' | 'openapi'): Promise<void> => {
    if (collections.length === 0) {
      setNotice('当前集合为空，先保存几个请求再导出')
      return
    }
    const activeEnv = environments.find((e) => e.id === activeEnvId) ?? null
    const baseName = activeEnv?.name?.trim() || 'FlowProbe Collection'
    const content =
      format === 'postman'
        ? exportPostman(baseName, collections, activeEnv)
        : exportOpenApi(baseName, collections, activeEnv)
    const suffix = format === 'postman' ? 'postman_collection' : 'openapi'
    const path = await window.toolbox.saveTextFile(`${baseName}.${suffix}.json`, content)
    if (path) {
      setNotice(`已导出 ${collections.length} 个请求（${format === 'postman' ? 'Postman v2.1' : 'OpenAPI 3.0'}）`)
    }
  }

  useEffect(() => {
    load()
  }, [load])

  const activeEnv = environments.find((e) => e.id === activeEnvId) ?? null
  const vars = activeEnv?.variables ?? []

  const patch = (p: Partial<HttpTestRequest>): void => setReq((r) => ({ ...r, ...p }))
  const patchAuth = (p: Partial<HttpAuth>): void => setReq((r) => ({ ...r, auth: { ...r.auth, ...p } }))

  const send = async (): Promise<void> => {
    // 快捷键可能连按两次；请求还没回来时再发一次只会产生重复历史
    if (sending) return
    setSending(true)
    setRes(null)
    setAssertResults([])
    try {
      const resolved = resolveRequest(req, vars)
      const response = await window.toolbox.sendHttpTest(resolved)
      setRes(response)
      setAssertResults(runAssertions(response, assertions))
      // 提取到的值写回当前环境变量，便于后续请求直接引用
      const picked = runExtracts(response, extracts)
      setExtracted(picked)
      if (activeEnv && Object.keys(picked).length > 0) {
        const next = [...activeEnv.variables]
        for (const [key, value] of Object.entries(picked)) {
          const idx = next.findIndex((v) => v.key.trim() === key)
          if (idx >= 0) next[idx] = { ...next[idx], value }
          else next.push({ key, value, enabled: true })
        }
        updateEnvironment(activeEnv.id, { variables: next })
      }
      setResTab(assertions.some((a) => a.enabled) ? 'tests' : 'body')
      pushHistory({
        id: uid(),
        ts: Date.now(),
        method: req.method,
        url: resolved.url,
        status: response.status,
        durationMs: response.durationMs,
        request: req,
        // 存响应摘要是为了导出 HAR：没有响应的 HAR 在 DevTools 里只是一行空请求
        statusText: response.statusText,
        respHeaders: response.headers,
        respBody: response.bodyText,
        respSize: response.sizeBytes
      })
    } finally {
      setSending(false)
    }
  }

  const loadRequest = (item: SavedHttpRequest): void => {
    setReq(item.request)
    setAssertions(item.assertions ?? [])
    setExtracts(item.extracts ?? [])
    setCurName(item.name)
    setEditingId(item.id)
    setRes(null)
    setAssertResults([])
  }

  const newRequest = (): void => {
    setReq(blankRequest())
    setAssertions([])
    setExtracts([])
    setCurName('未命名请求')
    setEditingId(null)
    setRes(null)
    setAssertResults([])
    setExtracted({})
    setNotice('')
  }

  const doSave = (): void => {
    const id = editingId ?? uid()
    const name = curName.trim() || '未命名请求'
    saveRequest({ id, name, request: req, assertions, extracts })
    setEditingId(id)
    setCurName(name)
    setNotice('已保存到集合')
  }

  const importCurl = (): void => {
    const text = window.prompt('粘贴 cURL 命令：')
    if (text) {
      const parsed = parseCurl(text)
      if (parsed) {
        setReq(parsed)
        setRes(null)
        // 导入 cURL 视为一条新请求，保存时不应覆盖之前选中的那条
        setEditingId(null)
      }
    }
  }

  const exportCurl = (): void => {
    const resolved = resolveRequest(req, vars)
    window.prompt('复制 cURL：', toCurl(resolved))
  }

  /**
   * 历史导出为 HAR。
   *
   * 为什么导 HAR 而不是自家格式：HAR 1.2 是 Chrome DevTools、Postman、Fiddler、
   * Charles 都认的格式。把文件发给同事，对方拖进浏览器就能看到完整请求与响应，
   * 不需要先装这个工具 —— 自定义格式等于把协作成本转嫁给对方。
   */
  const exportHar = async (): Promise<void> => {
    if (history.length === 0) return
    const info = await window.toolbox.appInfo()
    const json = historyToHarJson(history, vars, info.version, activeEnv?.name)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const path = await window.toolbox.saveTextFile('接口测试-' + stamp + '.har', json)
    if (path) setNotice(history.length + ' 条请求已导出到 ' + path)
  }

  const prettyBody = useMemo(() => {
    if (!res) return ''
    if (respView === 'raw') return res.bodyText
    try {
      return JSON.stringify(JSON.parse(res.bodyText), null, 2)
    } catch {
      return res.bodyText
    }
  }, [res, respView])

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div
        style={styles.panel}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onClose()
            return
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void send()
          }
        }}
      >
        <div style={styles.header}>
          <span style={styles.title}>HTTP 接口测试</span>
          <span style={styles.spacer} />
          <label style={styles.envLabel}>环境</label>
          <Select
            size="sm"
            style={{ minWidth: 120, flex: 1 }}
            value={activeEnvId ?? ''}
            onChange={(v) => setActiveEnv(v || null)}
            options={[
              { value: '', label: '无' },
              ...environments.map((env) => ({ value: env.id, label: env.name, group: '环境' }))
            ]}
          />
          <button style={styles.ghost} onClick={() => addEnvironment({ id: uid(), name: `环境${environments.length + 1}`, variables: [] })}>+环境</button>
          <button style={styles.ghost} onClick={() => setRunnerOpen(true)} title="按顺序批量运行集合并生成报告">批量运行</button>
          <button style={styles.ghost} onClick={onOpenMonitor} title="按周期自动跑集合，断言失败即通知">定时巡检</button>
          <button style={styles.close} onClick={onClose}>✕</button>
        </div>

        {notice && (
          <div style={styles.notice} onClick={() => setNotice('')} title="点击关闭">
            {notice}
          </div>
        )}

        <div style={styles.body}>
          <div style={styles.left}>
            <div style={styles.sideTitleRow}>
              <span style={styles.sideTitle}>集合</span>
              <span style={{ flex: 1 }} />
              <button
                style={styles.miniAction}
                title="导入 Postman Collection v2.1 或 OpenAPI 3.x（JSON）"
                onClick={() => void importCollectionFile()}
              >
                导入
              </button>
              <button
                style={styles.miniAction}
                title="导出为 Postman Collection v2.1"
                onClick={() => void exportCollection('postman')}
              >
                Postman
              </button>
              <button
                style={styles.miniAction}
                title="导出为 OpenAPI 3.0 文档"
                onClick={() => void exportCollection('openapi')}
              >
                OpenAPI
              </button>
            </div>
            <div style={styles.sideList}>
              {collections.length === 0 && <div style={styles.sideEmpty}>暂无保存的请求</div>}
              {collections.map((c) => (
                <div
                  key={c.id}
                  style={{
                    ...styles.savedRow,
                    ...(c.id === editingId ? styles.savedRowActive : {})
                  }}
                >
                  <button style={styles.savedBtn} onClick={() => loadRequest(c)} title={c.request.url}>
                    <span style={styles.savedMethod}>{c.request.method}</span>
                    <span style={styles.savedName}>{c.name}</span>
                  </button>
                  <button style={styles.miniDel} onClick={() => removeRequest(c.id)}>✕</button>
                </div>
              ))}
            </div>

            <div style={styles.sideTitle}>历史</div>
            <div style={styles.sideList}>
              {history.length === 0 && <div style={styles.sideEmpty}>暂无历史</div>}
              {history.slice(0, 30).map((h) => (
                <button key={h.id} style={styles.histRow} onClick={() => { setReq(h.request); setRes(null) }}>
                  <span style={{ ...styles.savedMethod, color: statusColor(h.status) }}>{h.method}</span>
                  <span style={styles.histUrl}>{h.url}</span>
                  <span style={styles.histStatus}>{h.status || '—'}</span>
                </button>
              ))}
            </div>
            {history.length > 0 && (
              <div style={styles.histActions}>
                <button
                  style={{ ...styles.clearHist, ...styles.histAct }}
                  title="导出为 HAR 1.2：可直接拖进 Chrome 开发者工具 / Postman / Fiddler 复现"
                  onClick={() => void exportHar()}
                >
                  导出 HAR
                </button>
                <button style={{ ...styles.clearHist, ...styles.histAct }} onClick={clearHistory}>清空历史</button>
              </div>
            )}

            {activeEnv && (
              <>
                <div style={styles.sideTitle}>变量 · {activeEnv.name}</div>
                <KVEditor
                  rows={activeEnv.variables}
                  onChange={(rows) => updateEnvironment(activeEnv.id, { variables: rows })}
                  keyPh="变量名"
                  valPh="值"
                  compact
                />
                <button style={styles.clearHist} onClick={() => removeEnvironment(activeEnv.id)}>删除该环境</button>
              </>
            )}
          </div>

          <div style={styles.main}>
            <div style={styles.urlBar}>
              <Select
                style={{ width: 104, fontFamily: 'var(--font-mono)' }}
                value={req.method}
                onChange={(v) => patch({ method: v })}
                options={METHODS.map((m) => ({ value: m, label: m }))}
              />
              <input
                style={styles.url}
                value={req.url}
                onChange={(e) => patch({ url: e.target.value })}
                onKeyDown={(e) => {
                  // 与浏览器地址栏一致：在 URL 里回车直接发送
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder="https://api.example.com/path 或 {{baseUrl}}/path"
              />
              <button style={styles.send} disabled={sending} onClick={send}>{sending ? '发送中…' : '发送'}</button>
            </div>

            <div style={styles.nameBar}>
              <input style={styles.nameInput} value={curName} onChange={(e) => setCurName(e.target.value)} />
              <button style={styles.ghost} onClick={newRequest} title="清空当前表单，开始一条新请求">新建</button>
              <button style={styles.ghost} onClick={doSave}>{editingId ? '保存修改' : '保存到集合'}</button>
              <button style={styles.ghost} onClick={importCurl}>导入 cURL</button>
              <button style={styles.ghost} onClick={exportCurl}>导出 cURL</button>
            </div>

            <div style={styles.tabs}>
              {(['params', 'headers', 'body', 'auth', 'tests'] as const).map((t) => (
                <button key={t} style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }} onClick={() => setTab(t)}>
                  {tabLabel(t)}
                </button>
              ))}
            </div>

            <div style={styles.tabBody}>
              {tab === 'params' && (
                <KVEditor rows={req.query} onChange={(rows) => patch({ query: rows })} keyPh="参数名" valPh="值" />
              )}
              {tab === 'headers' && (
                <KVEditor rows={req.headers} onChange={(rows) => patch({ headers: rows })} keyPh="Header" valPh="值" suggest={HEADER_SUGGEST} />
              )}
              {tab === 'body' && (
                <div style={styles.bodyWrap}>
                  <div style={styles.bodyTypes}>
                    {(['none', 'json', 'text', 'xml', 'form', 'binary'] as HttpTestBodyType[]).map((bt) => (
                      <label key={bt} style={styles.radio}>
                        <input type="radio" checked={req.bodyType === bt} onChange={() => patch({ bodyType: bt })} />
                        {bt}
                      </label>
                    ))}
                    {req.bodyType === 'json' && (
                      <button style={styles.ghost} onClick={() => { try { patch({ body: JSON.stringify(JSON.parse(req.body), null, 2) }) } catch { /* ignore */ } }}>格式化</button>
                    )}
                  </div>
                  {req.bodyType !== 'none' && (
                    // 请求体常常几十行 JSON，原生 resize 在这个可滚动容器里拉不动，改成受控高度
                    <ResizableTextarea
                      value={req.body}
                      onChange={(v) => patch({ body: v })}
                      height={bodyH}
                      onHeightChange={setBodyH}
                      min={90}
                      max={520}
                      placeholder={req.bodyType === 'form' ? '每行 key=value' : req.bodyType === 'binary' ? 'base64 内容' : '请求体...'}
                    />
                  )}
                </div>
              )}
              {tab === 'auth' && (
                <div style={styles.authWrap}>
                  <Select
  value={req.auth.type}
  onChange={(v) => patchAuth({ type: v as HttpAuth['type'] })}
  style={styles.authSel}
  options={[{ value: "none", label: "无认证" }, { value: "basic", label: "Basic" }, { value: "bearer", label: "Bearer Token" }, { value: "apikey", label: "API Key" }]}
/>
                  {req.auth.type === 'basic' && (
                    <div style={styles.line}>
                      <input style={styles.authInput} value={req.auth.username ?? ''} onChange={(e) => patchAuth({ username: e.target.value })} placeholder="用户名" />
                      <input style={styles.authInput} value={req.auth.password ?? ''} onChange={(e) => patchAuth({ password: e.target.value })} placeholder="密码" />
                    </div>
                  )}
                  {req.auth.type === 'bearer' && (
                    <input style={styles.authInput} value={req.auth.token ?? ''} onChange={(e) => patchAuth({ token: e.target.value })} placeholder="Token（支持 {{token}}）" />
                  )}
                  {req.auth.type === 'apikey' && (
                    <div style={styles.line}>
                      <input style={styles.authInput} value={req.auth.apiKeyName ?? ''} onChange={(e) => patchAuth({ apiKeyName: e.target.value })} placeholder="Key 名" />
                      <input style={styles.authInput} value={req.auth.apiKeyValue ?? ''} onChange={(e) => patchAuth({ apiKeyValue: e.target.value })} placeholder="Key 值" />
                      <Select
  value={req.auth.apiKeyIn ?? 'header'}
  onChange={(v) => patchAuth({ apiKeyIn: v as 'header' | 'query' })}
  style={styles.authSel}
  options={[{ value: "header", label: "Header" }, { value: "query", label: "Query" }]}
/>
                    </div>
                  )}
                </div>
              )}
              {tab === 'tests' && (
                <div style={styles.testsWrap}>
                  <AssertionEditor rows={assertions} onChange={setAssertions} results={assertResults} />
                  <div style={styles.subTitle}>变量提取（写入当前环境，供后续请求引用）</div>
                  <ExtractEditor rows={extracts} onChange={setExtracts} results={extracted} />
                </div>
              )}
            </div>

            <div style={styles.respArea}>
              {!res && <div style={styles.respEmpty}>{sending ? '请求中…' : '发送请求后在此查看响应'}</div>}
              {res && (
                <>
                  <div style={styles.respBar}>
                    <span style={{ ...styles.respStatus, color: statusColor(res.status) }}>
                      {res.status ? `${res.status} ${res.statusText}` : '请求失败'}
                    </span>
                    <span style={styles.respMeta}>{res.durationMs}ms</span>
                    <span style={styles.respMeta}>{res.sizeBytes}B</span>
                    {res.redirects > 0 && <span style={styles.respMeta}>{res.redirects}次重定向</span>}
                    {res.error && <span style={{ color: 'var(--error)' }}>{res.error}</span>}
                    <span style={styles.spacer} />
                    {(['body', 'headers', 'tests'] as const).map((t) => (
                      <button key={t} style={{ ...styles.respTab, ...(resTab === t ? styles.tabActive : {}) }} onClick={() => setResTab(t)}>
                        {t === 'body' ? '响应体' : t === 'headers' ? '响应头' : `断言(${assertResults.filter((a) => a.passed).length}/${assertResults.length})`}
                      </button>
                    ))}
                  </div>
                  {resTab === 'body' && (
                    <>
                      <div style={styles.viewToggle}>
                        <button style={{ ...styles.miniTab, ...(respView === 'pretty' ? styles.tabActive : {}) }} onClick={() => setRespView('pretty')}>美化</button>
                        <button style={{ ...styles.miniTab, ...(respView === 'raw' ? styles.tabActive : {}) }} onClick={() => setRespView('raw')}>原始</button>
                      </div>
                      <pre style={styles.respBody}>{prettyBody}</pre>
                    </>
                  )}
                  {resTab === 'headers' && (
                    <pre style={styles.respBody}>{Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
                  )}
                  {resTab === 'tests' && (
                    <div style={styles.assertResults}>
                      {assertResults.length === 0 && <div style={styles.respEmpty}>未配置断言</div>}
                      {assertResults.map((a) => (
                        <div key={a.id} style={styles.assertRow}>
                          <span style={{ color: a.passed ? 'var(--accent)' : 'var(--error)' }}>{a.passed ? '✓' : '✕'}</span>
                          <span>{a.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {runnerOpen && <CollectionRunner onClose={() => setRunnerOpen(false)} />}
    </div>
  )
}

const HEADER_SUGGEST = ['Content-Type', 'Authorization', 'Accept', 'User-Agent', 'X-Requested-With', 'Cookie']

function tabLabel(t: string): string {
  return { params: 'Params', headers: 'Headers', body: 'Body', auth: 'Auth', tests: 'Tests' }[t] ?? t
}

function KVEditor({
  rows,
  onChange,
  keyPh,
  valPh,
  suggest,
  compact
}: {
  rows: HttpHeaderKV[]
  onChange: (rows: HttpHeaderKV[]) => void
  keyPh: string
  valPh: string
  suggest?: string[]
  /** 窄容器（如左侧栏）里改为上下堆叠，避免值输入框被挤没 */
  compact?: boolean
}): JSX.Element {
  const update = (i: number, patch: Partial<HttpHeaderKV>): void => {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  const add = (): void => onChange([...rows, { key: '', value: '', enabled: true }])
  const del = (i: number): void => onChange(rows.filter((_, idx) => idx !== i))
  return (
    <div style={styles.kv}>
      {rows.map((r, i) =>
        compact ? (
          <div key={i} style={styles.kvStack}>
            <div style={styles.kvStackHead}>
              <input
                type="checkbox"
                checked={r.enabled !== false}
                onChange={(e) => update(i, { enabled: e.target.checked })}
              />
              <input
                style={styles.kvStackKey}
                value={r.key}
                onChange={(e) => update(i, { key: e.target.value })}
                placeholder={keyPh}
              />
              <button style={styles.miniDel} onClick={() => del(i)}>✕</button>
            </div>
            <input
              style={styles.kvStackVal}
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={valPh}
              title={r.value}
            />
          </div>
        ) : (
          <div key={i} style={styles.kvRow}>
            <input type="checkbox" checked={r.enabled !== false} onChange={(e) => update(i, { enabled: e.target.checked })} />
            <input style={styles.kvKey} value={r.key} onChange={(e) => update(i, { key: e.target.value })} placeholder={keyPh} list={suggest ? 'hdr-suggest' : undefined} />
            <input style={styles.kvVal} value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder={valPh} />
            <button style={styles.miniDel} onClick={() => del(i)}>✕</button>
          </div>
        )
      )}
      {suggest && (
        <datalist id="hdr-suggest">
          {suggest.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
      <button style={styles.addRow} onClick={add}>+ 添加</button>
    </div>
  )
}

function AssertionEditor({
  rows,
  onChange,
  results
}: {
  rows: HttpAssertion[]
  onChange: (rows: HttpAssertion[]) => void
  results: AssertResult[]
}): JSX.Element {
  const update = (id: string, patch: Partial<HttpAssertion>): void => {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  const add = (): void => onChange([...rows, { id: uid(), enabled: true, target: 'status', op: 'eq', expected: '200' }])
  const del = (id: string): void => onChange(rows.filter((r) => r.id !== id))
  return (
    <div style={styles.kv}>
      {rows.length === 0 && <div style={styles.sideEmpty}>添加断言以校验响应（状态码/耗时/JSON字段/文本/正则）</div>}
      {rows.map((a) => {
        const res = results.find((r) => r.id === a.id)
        return (
          <div key={a.id} style={styles.assertEdit}>
            <input type="checkbox" checked={a.enabled} onChange={(e) => update(a.id, { enabled: e.target.checked })} />
            <Select
  value={a.target}
  onChange={(v) => update(a.id, { target: v as HttpAssertion['target'] })}
  style={styles.assertSel}
  options={[{ value: "status", label: "状态码" }, { value: "time", label: "耗时(ms)" }, { value: "jsonPath", label: "JSON字段" }, { value: "text", label: "文本包含" }, { value: "regex", label: "正则" }]}
/>
            {a.target === 'jsonPath' && (
              <input style={styles.assertPath} value={a.path ?? ''} onChange={(e) => update(a.id, { path: e.target.value })} placeholder="data.id" />
            )}
            <Select
  value={a.op}
  onChange={(v) => update(a.id, { op: v as HttpAssertion['op'] })}
  style={styles.assertSel}
  options={[{ value: "eq", label: "=" }, { value: "neq", label: "≠" }, { value: "contains", label: "包含" }, { value: "match", label: "匹配" }, { value: "lt", label: "&lt;" }, { value: "gt", label: "&gt;" }, { value: "exists", label: "存在" }]}
/>
            {a.op !== 'exists' && (
              <input style={styles.assertVal} value={a.expected} onChange={(e) => update(a.id, { expected: e.target.value })} placeholder="期望值" />
            )}
            {res && <span style={{ color: res.passed ? 'var(--accent)' : 'var(--error)' }}>{res.passed ? '✓' : '✕'}</span>}
            <button style={styles.miniDel} onClick={() => del(a.id)}>✕</button>
          </div>
        )
      })}
      <button style={styles.addRow} onClick={add}>+ 添加断言</button>
    </div>
  )
}

function ExtractEditor({
  rows,
  onChange,
  results
}: {
  rows: HttpExtractRule[]
  onChange: (rows: HttpExtractRule[]) => void
  results: Record<string, string>
}): JSX.Element {
  const update = (id: string, patch: Partial<HttpExtractRule>): void => {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  const add = (): void =>
    onChange([...rows, { id: uid(), enabled: true, source: 'body', path: '', varName: '' }])
  const del = (id: string): void => onChange(rows.filter((r) => r.id !== id))
  return (
    <div style={styles.kv}>
      {rows.length === 0 && (
        <div style={styles.sideEmpty}>
          例：从登录响应取 data.token 存为 token，后续请求用 {'{{token}}'} 引用
        </div>
      )}
      {rows.map((r) => (
        <div key={r.id} style={styles.assertEdit}>
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => update(r.id, { enabled: e.target.checked })}
          />
          <Select
  value={r.source}
  onChange={(v) => update(r.id, { source: v as HttpExtractRule['source'] })}
  style={styles.assertSel}
  options={[{ value: "body", label: "响应体 JSON" }, { value: "header", label: "响应头" }, { value: "status", label: "状态码" }]}
/>
          {r.source !== 'status' && (
            <input
              style={styles.assertPath}
              value={r.path ?? ''}
              onChange={(e) => update(r.id, { path: e.target.value })}
              placeholder={r.source === 'header' ? 'set-cookie' : 'data.token'}
            />
          )}
          <span style={styles.arrow}>→</span>
          <input
            style={styles.assertVal}
            value={r.varName}
            onChange={(e) => update(r.id, { varName: e.target.value })}
            placeholder="变量名"
          />
          {results[r.varName] !== undefined && (
            <span style={styles.extractVal} title={results[r.varName]}>
              = {results[r.varName]}
            </span>
          )}
          <button style={styles.miniDel} onClick={() => del(r.id)}>✕</button>
        </div>
      ))}
      <button style={styles.addRow} onClick={add}>+ 添加提取</button>
    </div>
  )
}

function statusColor(s: number): string {
  if (!s) return 'var(--error)'
  if (s >= 500) return 'var(--error)'
  if (s >= 400) return 'var(--warn)'
  if (s >= 200 && s < 300) return 'var(--accent)'
  return 'var(--text-1)'
}

// —— cURL 解析/生成 ——
function parseCurl(text: string): HttpTestRequest | null {
  const req = blankRequest()
  req.query = []
  const clean = text.replace(/\\\r?\n/g, ' ').trim()
  const tokens = clean.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  let i = 0
  if (tokens[0] === 'curl') i = 1
  const unq = (s: string): string => s.replace(/^['"]|['"]$/g, '')
  let method = ''
  const headers: HttpHeaderKV[] = []
  for (; i < tokens.length; i++) {
    const tk = tokens[i]
    if (tk === '-X' || tk === '--request') { method = unq(tokens[++i] ?? 'GET') }
    else if (tk === '-H' || tk === '--header') {
      const h = unq(tokens[++i] ?? '')
      const idx = h.indexOf(':')
      if (idx > 0) headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim(), enabled: true })
    }
    else if (tk === '-d' || tk === '--data' || tk === '--data-raw') {
      req.body = unq(tokens[++i] ?? '')
      req.bodyType = 'json'
      if (!method) method = 'POST'
    }
    else if (tk === '-u' || tk === '--user') {
      const cred = unq(tokens[++i] ?? '')
      const idx = cred.indexOf(':')
      req.auth = { type: 'basic', username: cred.slice(0, idx), password: cred.slice(idx + 1) }
    }
    else if (!tk.startsWith('-')) {
      req.url = unq(tk)
    }
  }
  req.method = method || 'GET'
  req.headers = headers
  return req
}

function toCurl(req: HttpTestRequest): string {
  const parts = [`curl -X ${req.method}`]
  const u = new URL(req.url)
  for (const q of req.query) if (q.enabled !== false && q.key) u.searchParams.append(q.key, q.value)
  parts.push(`'${u.toString()}'`)
  for (const h of req.headers) if (h.enabled !== false && h.key) parts.push(`-H '${h.key}: ${h.value}'`)
  if (req.auth.type === 'bearer') parts.push(`-H 'Authorization: Bearer ${req.auth.token ?? ''}'`)
  if (req.bodyType !== 'none' && req.body) parts.push(`-d '${req.body.replace(/\n/g, '')}'`)
  return parts.join(' ')
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 50 },
  panel: { width: 1120, maxWidth: '96vw', height: 720, maxHeight: '94vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontWeight: 600 },
  spacer: { flex: 1 },
  envLabel: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)' },
  envSelect: { background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)' },
  close: { background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 16 },
  body: { flex: 1, display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 0 },
  left: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', padding: 8, gap: 4 },
  sideTitle: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 6px 2px' },
  sideTitleRow: { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 6px 2px' },
  miniAction: {
    padding: '2px 6px',
    background: 'transparent',
    color: 'var(--text-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-micro)',
    lineHeight: 1.5
  },
  sideList: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  sideEmpty: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', padding: '4px 6px' },
  savedRow: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 },
  savedRowActive: {
    background: 'var(--selected-bg)',
    borderRadius: 'var(--r-sm)'
  },
  savedBtn: { flex: 1, minWidth: 0, display: 'flex', gap: 6, alignItems: 'center', background: 'transparent', color: 'var(--text-0)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', padding: '5px 6px', textAlign: 'left' },
  savedMethod: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--accent)', width: 40, flexShrink: 0 },
  savedName: { fontSize: 'var(--fs-sm)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  histRow: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, background: 'transparent', color: 'var(--text-1)', border: 'none', padding: '4px 6px', textAlign: 'left', width: '100%' },
  histUrl: { fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  histStatus: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  histActions: { display: 'flex', gap: 4 },
  // 并排两颗按钮各占一半。flex 写在这里而不是 clearHist 上：
  // clearHist 还被「删除该环境」复用，那颗在纵向 flex 列里，给 flex:1 会被拉成一整块
  histAct: { flex: 1, margin: '4px 0' },
  notice: { padding: '6px 12px', fontSize: 'var(--fs-xs)', color: 'var(--text-1)', background: 'var(--btn2-bg)', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer' },
  clearHist: { margin: '4px 6px', padding: '4px 0', background: 'var(--btn2-bg)', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  miniDel: { background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-sm)', flexShrink: 0 },
  main: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
  urlBar: { display: 'flex', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' },
  method: { background: 'var(--field-bg)', color: 'var(--accent)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' },
  url: { flex: 1, background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 'var(--fs-md)', fontFamily: 'var(--font-mono)', outline: 'none' },
  send: { padding: '6px 20px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)' },
  nameBar: { display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', alignItems: 'center' },
  nameInput: { flex: 1, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)' },
  ghost: { padding: '4px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  tabs: { display: 'flex', gap: 2, padding: '6px 12px 0', borderBottom: '1px solid var(--border-subtle)' },
  tab: { padding: '6px 12px', background: 'transparent', color: 'var(--text-1)', border: 'none', borderBottom: '2px solid transparent', fontSize: 'var(--fs-sm)' },
  tabActive: { color: 'var(--accent)', borderBottom: '2px solid var(--accent)' },
  // maxHeight 从固定 220 放宽到视口比例：请求体被拉高后原来会被父容器截断，
  // 用户以为「拉了没用」，其实是外层限死了
  tabBody: { padding: 12, borderBottom: '1px solid var(--border)', maxHeight: '52vh', overflowY: 'auto' },
  kv: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  kvRow: { display: 'flex', gap: 6, alignItems: 'center' },
  kvStack: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, padding: '4px 6px', background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)' },
  kvStackHead: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  kvStackKey: { flex: 1, minWidth: 0, background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '3px 6px', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', outline: 'none' },
  kvStackVal: { width: '100%', minWidth: 0, background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '3px 6px', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', outline: 'none' },
  kvKey: { width: 200, minWidth: 0, flexShrink: 1, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  kvVal: { flex: 1, minWidth: 0, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  addRow: { alignSelf: 'flex-start', padding: '4px 10px', background: 'var(--bg-2)', color: 'var(--text-1)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  bodyWrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  bodyTypes: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  radio: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  code: { width: '100%', minHeight: 120, resize: 'vertical', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', outline: 'none' },
  authWrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  authSel: { background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: 'var(--fs-sm)', alignSelf: 'flex-start' },
  authInput: { flex: 1, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  line: { display: 'flex', gap: 8 },
  respArea: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  respEmpty: { color: 'var(--text-2)', padding: 20, textAlign: 'center', fontSize: 'var(--fs-sm)' },
  respBar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  respStatus: { fontWeight: 600, fontSize: 'var(--fs-md)' },
  respMeta: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  respTab: { padding: '4px 10px', background: 'transparent', color: 'var(--text-1)', border: 'none', borderBottom: '2px solid transparent', fontSize: 'var(--fs-sm)' },
  viewToggle: { display: 'flex', gap: 2, padding: '6px 12px 0' },
  miniTab: { padding: '3px 10px', background: 'transparent', color: 'var(--text-1)', border: 'none', borderBottom: '2px solid transparent', fontSize: 'var(--fs-xs)' },
  respBody: { flex: 1, margin: 0, padding: '10px 14px', overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--text-0)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  assertResults: { padding: 12, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' },
  assertRow: { display: 'flex', gap: 8, fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  assertEdit: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  assertSel: { background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)' },
  assertPath: { width: 120, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  assertVal: { flex: 1, minWidth: 100, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  testsWrap: { display: 'flex', flexDirection: 'column', gap: 10 },
  subTitle: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', borderTop: '1px solid var(--border)', paddingTop: 8 },
  arrow: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)' },
  extractVal: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
}
