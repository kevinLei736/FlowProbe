import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Encoding,
  HistoryConfig,
  HistoryFrameRow,
  HistoryHttpQuery,
  HistoryHttpRow,
  HistoryQuery,
  HistoryStats
} from '@shared/protocol'
import { VirtualList } from '../../components/VirtualList'
import { decodeFrame, formatTs } from '../sessions/frameExport'
import { Select } from '../../components/ui/Select'

type Tab = 'frames' | 'http' | 'manage'
type RangeKey = '1h' | '24h' | '7d' | '30d' | 'all'

const RANGES: Array<[RangeKey, string, number]> = [
  ['1h', '近 1 小时', 3600000],
  ['24h', '近 24 小时', 86400000],
  ['7d', '近 7 天', 604800000],
  ['30d', '近 30 天', 2592000000],
  ['all', '全部', 0]
]

const PAGE_SIZE = 200

/**
 * 历史浏览器。
 *
 * 内存里的时间轴关掉应用就没了，看板也只覆盖最近十分钟。
 * 这里对接主进程的 SQLite 库，按会话、时间、方向、关键字、字节数组合检索，
 * 分页拉取而不是一次性拽回全部行——十万行报文搬过 IPC 会把界面卡住。
 */
export function HistoryView({
  onClose,
  initialKeyword = '',
  initialTab = 'frames',
  initialSessionId = ''
}: {
  onClose: () => void
  /** 从全局搜索跳进来时带上关键字，落地即已过滤 */
  initialKeyword?: string
  initialTab?: 'frames' | 'http'
  initialSessionId?: string
}): JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [stats, setStats] = useState<(HistoryStats & { available: boolean; failure: string }) | null>(null)
  const [config, setConfig] = useState<HistoryConfig | null>(null)
  const [sessions, setSessions] = useState<
    Array<{ sessionId: string; sessionName: string; sessionKind: string; count: number }>
  >([])

  // 报文筛选条件
  // 从全局搜索跳进来时放开时间范围：命中可能在几天前，默认 24 小时会把它挡掉
  const [range, setRange] = useState<RangeKey>(initialKeyword ? 'all' : '24h')
  const [sessionId, setSessionId] = useState(initialSessionId)
  const [keyword, setKeyword] = useState(initialKeyword)
  const [dirFilter, setDirFilter] = useState<'all' | 'tx' | 'rx' | 'system'>('all')
  const [connOnly, setConnOnly] = useState(false)
  const [minSize, setMinSize] = useState('')
  const [maxSize, setMaxSize] = useState('')
  const [viewFormat, setViewFormat] = useState<Encoding>('utf8')

  // HTTP 筛选条件
  const [httpMethod, setHttpMethod] = useState('')
  const [httpFamilies, setHttpFamilies] = useState<number[]>([])
  const [minDuration, setMinDuration] = useState('')

  const [frames, setFrames] = useState<HistoryFrameRow[]>([])
  const [frameTotal, setFrameTotal] = useState(0)
  const [httpRows, setHttpRows] = useState<HistoryHttpRow[]>([])
  const [httpTotal, setHttpTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const since = useMemo(() => {
    const r = RANGES.find((x) => x[0] === range)
    return r && r[2] > 0 ? Date.now() - r[2] : undefined
  }, [range])

  const frameQuery = useMemo<HistoryQuery>(
    () => ({
      sessionIds: sessionId ? [sessionId] : undefined,
      from: since,
      directions: dirFilter === 'all' ? undefined : [dirFilter],
      connOnly: connOnly || undefined,
      keyword: keyword.trim() || undefined,
      minSize: minSize.trim() ? Number(minSize) : undefined,
      maxSize: maxSize.trim() ? Number(maxSize) : undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      order: 'desc'
    }),
    [sessionId, since, dirFilter, connOnly, keyword, minSize, maxSize, page]
  )

  const httpQuery = useMemo<HistoryHttpQuery>(
    () => ({
      sessionIds: sessionId ? [sessionId] : undefined,
      from: since,
      statusFamilies: httpFamilies.length > 0 ? httpFamilies : undefined,
      method: httpMethod || undefined,
      keyword: keyword.trim() || undefined,
      minDurationMs: minDuration.trim() ? Number(minDuration) : undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      order: 'desc'
    }),
    [sessionId, since, httpFamilies, httpMethod, keyword, minDuration, page]
  )

  const refreshMeta = useCallback(async (): Promise<void> => {
    const [s, c, list] = await Promise.all([
      window.toolbox.historyStats(),
      window.toolbox.historyConfigGet(),
      window.toolbox.historySessions()
    ])
    setStats(s)
    setConfig(c)
    setSessions(list)
  }, [])

  useEffect(() => {
    void refreshMeta()
  }, [refreshMeta])

  // 条件变化即查询。筛选项改动时回到第一页，否则会停在越界的页码上。
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      setLoading(true)
      try {
        if (tab === 'frames') {
          const res = await window.toolbox.historyQueryFrames(frameQuery)
          if (!cancelled) {
            setFrames(res.rows)
            setFrameTotal(res.total)
          }
        } else if (tab === 'http') {
          const res = await window.toolbox.historyQueryHttp(httpQuery)
          if (!cancelled) {
            setHttpRows(res.rows)
            setHttpTotal(res.total)
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [tab, frameQuery, httpQuery])

  const resetPage = (): void => setPage(0)

  const total = tab === 'frames' ? frameTotal : httpTotal
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  const doExport = async (): Promise<void> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const res =
      tab === 'frames'
        ? await window.toolbox.historyExport('frames', { ...frameQuery, offset: 0 }, '历史报文-' + stamp + '.csv')
        : await window.toolbox.historyExport('http', { ...httpQuery, offset: 0 }, '历史请求-' + stamp + '.csv')
    setNotice(res.path ? '已导出 ' + res.rows + ' 行到 ' + res.path : '已取消导出')
  }

  /**
   * HTTP 请求另存为 HAR。只在 HTTP 页签出现：报文是裸字节流，
   * 套不进 HAR 的请求/响应模型，硬导出会得到一份处处为空的文件。
   */
  const doExportHar = async (): Promise<void> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const res = await window.toolbox.historyExport(
      'http',
      { ...httpQuery, offset: 0 },
      '历史请求-' + stamp + '.har',
      'har'
    )
    setNotice(
      res.path
        ? '已导出 ' + res.rows + ' 条请求到 ' + res.path + '（历史库未存头部，HAR 内 headers 为空）'
        : '已取消导出'
    )
  }

  const toggleRow = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div style={s.wrap}>
      <header style={s.topbar}>
        <span style={s.title}>历史记录</span>
        <div style={s.seg}>
          {(
            [
              ['frames', '报文'],
              ['http', 'HTTP 请求'],
              ['manage', '存储管理']
            ] as Array<[Tab, string]>
          ).map(([v, label]) => (
            <button
              key={v}
              style={{ ...s.segBtn, ...(tab === v ? s.segActive : {}) }}
              onClick={() => {
                setTab(v)
                resetPage()
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={s.spacer} />
        {stats && !stats.available && (
          <span style={s.warn}>历史库不可用：{stats.failure || '未知原因'}</span>
        )}
        {stats && stats.available && (
          <span style={s.badge}>
            库内 {stats.frames.toLocaleString()} 条报文 · {formatBytes(stats.fileBytes)}
          </span>
        )}
        {tab !== 'manage' && (
          <button style={s.ghost} onClick={() => void doExport()}>
            导出 CSV
          </button>
        )}
        {tab === 'http' && (
          <button
            style={s.ghost}
            title="导出为 HAR 1.2，可拖进 Chrome 开发者工具 / Postman / Fiddler。注意历史库未保存请求头与响应头"
            onClick={() => void doExportHar()}
          >
            导出 HAR
          </button>
        )}
        <button style={s.ghost} onClick={onClose}>
          返回会话
        </button>
      </header>

      {tab !== 'manage' && (
        <div style={s.filters}>
          <Select
            size="sm"
            style={{ minWidth: 170, maxWidth: 260 }}
            value={sessionId}
            onChange={(v) => {
              setSessionId(v)
              resetPage()
            }}
            options={[
              { value: '', label: '全部会话' },
              ...sessions.map((x) => ({
                value: x.sessionId,
                label: (x.sessionName || '（已删除会话）') + ' · ' + x.count,
                group: '会话'
              }))
            ]}
          />

          <div style={s.seg}>
            {RANGES.map(([v, label]) => (
              <button
                key={v}
                style={{ ...s.segBtn, ...(range === v ? s.segActive : {}) }}
                onClick={() => {
                  setRange(v)
                  resetPage()
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <input
            style={s.input}
            value={keyword}
            placeholder="关键字"
            onChange={(e) => {
              setKeyword(e.target.value)
              resetPage()
            }}
          />

          {tab === 'frames' ? (
            <>
              <div style={s.seg}>
                {(
                  [
                    ['all', '全部'],
                    ['tx', 'TX'],
                    ['rx', 'RX'],
                    ['system', '系统']
                  ] as Array<[typeof dirFilter, string]>
                ).map(([v, label]) => (
                  <button
                    key={v}
                    style={{ ...s.segBtn, ...(dirFilter === v ? s.segActive : {}) }}
                    onClick={() => {
                      setDirFilter(v)
                      resetPage()
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label style={s.check}>
                <input
                  type="checkbox"
                  checked={connOnly}
                  onChange={(e) => {
                    setConnOnly(e.target.checked)
                    resetPage()
                  }}
                />
                仅连接日志
              </label>
              <input
                style={{ ...s.input, width: 66 }}
                value={minSize}
                placeholder="≥字节"
                onChange={(e) => {
                  setMinSize(e.target.value)
                  resetPage()
                }}
              />
              <input
                style={{ ...s.input, width: 66 }}
                value={maxSize}
                placeholder="≤字节"
                onChange={(e) => {
                  setMaxSize(e.target.value)
                  resetPage()
                }}
              />
              <div style={s.seg}>
                {(
                  [
                    ['utf8', 'TEXT'],
                    ['hex', 'HEX'],
                    ['base64', 'B64']
                  ] as Array<[Encoding, string]>
                ).map(([v, label]) => (
                  <button
                    key={v}
                    style={{ ...s.segBtn, ...(viewFormat === v ? s.segActive : {}) }}
                    onClick={() => setViewFormat(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Select
                size="sm"
                style={{ width: 120 }}
                value={httpMethod}
                onChange={(v) => {
                  setHttpMethod(v)
                  resetPage()
                }}
                options={[
                  { value: '', label: '全部方法' },
                  ...['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].map((m) => ({
                    value: m,
                    label: m
                  }))
                ]}
              />
              <div style={s.seg}>
                {[2, 3, 4, 5].map((f) => {
                  const on = httpFamilies.includes(f)
                  return (
                    <button
                      key={f}
                      style={{ ...s.segBtn, ...(on ? s.segActive : {}) }}
                      onClick={() => {
                        setHttpFamilies((prev) =>
                          prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]
                        )
                        resetPage()
                      }}
                    >
                      {f}xx
                    </button>
                  )
                })}
              </div>
              <input
                style={{ ...s.input, width: 86 }}
                value={minDuration}
                placeholder="≥耗时ms"
                onChange={(e) => {
                  setMinDuration(e.target.value)
                  resetPage()
                }}
              />
            </>
          )}
        </div>
      )}

      {tab === 'frames' && (
        <>
          {frames.length === 0 ? (
            <div style={s.empty}>{loading ? '查询中…' : '没有符合条件的历史报文'}</div>
          ) : (
            <VirtualList
              items={frames}
              keyOf={(r) => String(r.id)}
              estimate={24}
              style={s.list}
              padTop={8}
              padBottom={8}
            >
              {(r) => (
                <HistoryFrameRowView
                  row={r}
                  viewFormat={viewFormat}
                  expanded={expanded.has(r.id)}
                  onToggle={() => toggleRow(r.id)}
                  highlight={keyword}
                />
              )}
            </VirtualList>
          )}
        </>
      )}

      {tab === 'http' && (
        <>
          {httpRows.length === 0 ? (
            <div style={s.empty}>{loading ? '查询中…' : '没有符合条件的历史请求'}</div>
          ) : (
            <VirtualList
              items={httpRows}
              keyOf={(r) => String(r.id)}
              estimate={26}
              style={s.list}
              padTop={8}
              padBottom={8}
            >
              {(r) => (
                <HistoryHttpRowView
                  row={r}
                  expanded={expanded.has(r.id)}
                  onToggle={() => toggleRow(r.id)}
                  highlight={keyword}
                />
              )}
            </VirtualList>
          )}
        </>
      )}

      {tab === 'manage' && (
        <ManagePanel
          stats={stats}
          config={config}
          onConfig={async (patch) => {
            const next = await window.toolbox.historyConfigSet(patch)
            setConfig(next)
            await refreshMeta()
          }}
          onClear={async () => {
            if (!window.confirm('清空全部历史记录？此操作不可恢复。')) return
            await window.toolbox.historyClear()
            setFrames([])
            setHttpRows([])
            setFrameTotal(0)
            setHttpTotal(0)
            await refreshMeta()
            setNotice('历史已清空')
          }}
          onVacuum={async () => {
            await window.toolbox.historyVacuum()
            await refreshMeta()
            setNotice('已压缩数据库文件')
          }}
          onClearSession={async (id) => {
            await window.toolbox.historyClearSession(id)
            await refreshMeta()
            setNotice('已删除该会话的历史')
          }}
        />
      )}

      {tab !== 'manage' && (
        <footer style={s.footer}>
          <span style={s.footText}>
            共 {total.toLocaleString()} 条 · 第 {page + 1} / {maxPage + 1} 页
          </span>
          <span style={s.spacer} />
          <button style={s.ghost} disabled={page === 0} onClick={() => setPage(0)}>
            首页
          </button>
          <button style={s.ghost} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            上一页
          </button>
          <button
            style={s.ghost}
            disabled={page >= maxPage}
            onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
          >
            下一页
          </button>
          <button style={s.ghost} disabled={page >= maxPage} onClick={() => setPage(maxPage)}>
            末页
          </button>
        </footer>
      )}

      {notice && (
        <div style={s.notice}>
          {notice}
          <button style={s.noticeClose} onClick={() => setNotice('')}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 把文本里命中关键字的片段包成高亮。
 *
 * 从全局搜索跳进历史页后，一页 200 条里到底哪几行命中并不明显，
 * 逐行用眼睛找关键字很费劲——这里直接标出来。
 */
function withHighlight(text: string, keyword: string): React.ReactNode {
  const kw = keyword.trim()
  if (kw.length === 0) return text
  const lower = text.toLowerCase()
  const target = kw.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  let n = 0
  // 上限 200 段：极端情况下一条报文里命中上千次，切太多节点会拖慢渲染
  while (n < 200) {
    const at = lower.indexOf(target, from)
    if (at < 0) break
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} style={rs.mark}>
        {text.slice(at, at + kw.length)}
      </mark>
    )
    from = at + kw.length
    n += 1
  }
  if (parts.length === 0) return text
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

function HistoryFrameRowView({
  row,
  viewFormat,
  expanded,
  onToggle,
  highlight
}: {
  row: HistoryFrameRow
  viewFormat: Encoding
  expanded: boolean
  onToggle: () => void
  highlight: string
}): JSX.Element {
  const body = decodeFrame({ rawBase64: row.rawBase64, text: row.text }, viewFormat)
  const isTx = row.direction === 'tx'
  const isSystem = row.direction === 'system'
  const color = isSystem
    ? row.level === 'success'
      ? 'var(--conn-ok)'
      : row.level === 'warn'
        ? 'var(--conn-warn)'
        : row.level === 'error'
          ? 'var(--conn-error)'
          : 'var(--text-2)'
    : isTx
      ? 'var(--tx)'
      : 'var(--rx)'
  return (
    <div style={rs.wrap} onClick={onToggle}>
      <div style={rs.row}>
        <span style={rs.day}>{formatDay(row.ts)}</span>
        <span style={rs.ts}>{formatTs(row.ts)}</span>
        <span style={{ ...rs.arrow, color }}>{isSystem ? '--' : isTx ? '▶ TX' : '◀ RX'}</span>
        <span style={rs.size}>{row.size}B</span>
        <span style={rs.session} title={row.sessionGroup ? row.sessionGroup + ' / ' + row.sessionName : row.sessionName}>
          {row.sessionName || '（已删除）'}
        </span>
        {row.conn && <span style={{ ...rs.tag, color, borderColor: color }}>连接</span>}
        <span style={{ ...rs.content, ...(expanded ? {} : rs.clamp) }}>
          {withHighlight(body, highlight)}
        </span>
      </div>
      {expanded && (
        <div style={rs.detail}>
          <DetailRow k="会话" v={(row.sessionGroup ? row.sessionGroup + ' / ' : '') + row.sessionName + '（' + row.sessionKind + '）'} />
          {row.peerLabel && <DetailRow k="对端" v={row.peerLabel} />}
          <DetailRow k="时间" v={new Date(row.ts).toLocaleString('zh-CN', { hour12: false })} />
          {row.rawBase64 && (
            <DetailRow k="HEX" v={decodeFrame({ rawBase64: row.rawBase64, text: row.text }, 'hex')} />
          )}
        </div>
      )}
    </div>
  )
}

function HistoryHttpRowView({
  row,
  expanded,
  onToggle,
  highlight
}: {
  row: HistoryHttpRow
  expanded: boolean
  onToggle: () => void
  highlight: string
}): JSX.Element {
  const color =
    row.status >= 500
      ? 'var(--conn-error)'
      : row.status >= 400
        ? 'var(--conn-warn)'
        : 'var(--conn-ok)'
  return (
    <div style={rs.wrap} onClick={onToggle}>
      <div style={rs.row}>
        <span style={rs.day}>{formatDay(row.ts)}</span>
        <span style={rs.ts}>{formatTs(row.ts)}</span>
        <span style={rs.method}>{row.method}</span>
        <span style={{ ...rs.status, color }}>{row.status}</span>
        <span style={rs.dur}>{row.durationMs}ms</span>
        <span style={rs.session}>{row.sessionName || '（已删除）'}</span>
        <span style={{ ...rs.content, ...rs.clamp }}>
          {withHighlight(row.path + (row.query ? '?' + row.query : ''), highlight)}
        </span>
        {row.scenario && <span style={rs.scenario}>{row.scenario}</span>}
      </div>
      {expanded && (
        <div style={rs.detail}>
          <DetailRow k="时间" v={new Date(row.ts).toLocaleString('zh-CN', { hour12: false })} />
          {row.matchedRoute && <DetailRow k="命中路由" v={row.matchedRoute} />}
          {row.reqBody && <DetailRow k="请求体" v={row.reqBody} />}
          {row.respBody && <DetailRow k="响应体" v={row.respBody} />}
        </div>
      )}
    </div>
  )
}

function DetailRow({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div style={rs.detailRow}>
      <span style={rs.detailK}>{k}</span>
      <span style={rs.detailV}>{v}</span>
    </div>
  )
}

function ManagePanel({
  stats,
  config,
  onConfig,
  onClear,
  onVacuum,
  onClearSession
}: {
  stats: (HistoryStats & { available: boolean; failure: string }) | null
  config: HistoryConfig | null
  onConfig: (patch: Partial<HistoryConfig>) => Promise<void>
  onClear: () => Promise<void>
  onVacuum: () => Promise<void>
  onClearSession: (id: string) => Promise<void>
}): JSX.Element {
  const [days, setDays] = useState('')
  const [maxRows, setMaxRows] = useState('')

  useEffect(() => {
    if (config) {
      setDays(String(config.retentionDays))
      setMaxRows(String(config.maxFrames))
    }
  }, [config])

  const maxDay = Math.max(1, ...(stats?.byDay ?? []).map((d) => d.count))

  return (
    <div style={s.manage}>
      <section style={s.card}>
        <div style={s.cardTitle}>落库开关</div>
        <label style={s.check}>
          <input
            type="checkbox"
            checked={config?.enabled === true}
            onChange={(e) => void onConfig({ enabled: e.target.checked })}
          />
          记录报文与请求到本地数据库
        </label>
        <label style={s.check}>
          <input
            type="checkbox"
            checked={config?.storePayload === true}
            onChange={(e) => void onConfig({ storePayload: e.target.checked })}
          />
          同时保存原始字节（关闭后只存文本摘要，库体积明显更小）
        </label>
        <div style={s.hint}>
          关闭开关后已有数据保留，只是不再写入新记录。回放注入的报文不会入库。
        </div>
      </section>

      <section style={s.card}>
        <div style={s.cardTitle}>容量上限</div>
        <div style={s.formRow}>
          <span style={s.formLabel}>保留天数</span>
          <input style={{ ...s.input, width: 90 }} value={days} onChange={(e) => setDays(e.target.value)} />
          <span style={s.hint}>0 = 不按时间清理</span>
        </div>
        <div style={s.formRow}>
          <span style={s.formLabel}>报文条数上限</span>
          <input style={{ ...s.input, width: 120 }} value={maxRows} onChange={(e) => setMaxRows(e.target.value)} />
          <span style={s.hint}>0 = 不限，超出删除最旧</span>
        </div>
        <button
          style={s.primary}
          onClick={() =>
            void onConfig({
              retentionDays: Math.max(0, Number(days) || 0),
              maxFrames: Math.max(0, Number(maxRows) || 0)
            })
          }
        >
          保存并立即清理
        </button>
      </section>

      <section style={s.card}>
        <div style={s.cardTitle}>库概况</div>
        <div style={s.statGrid}>
          <Stat k="报文" v={(stats?.frames ?? 0).toLocaleString()} />
          <Stat k="HTTP 请求" v={(stats?.httpLogs ?? 0).toLocaleString()} />
          <Stat k="会话数" v={String(stats?.sessions ?? 0)} />
          <Stat k="文件大小" v={formatBytes(stats?.fileBytes ?? 0)} />
          <Stat k="最早记录" v={stats?.oldestTs ? formatDay(stats.oldestTs) : '—'} />
          <Stat k="最新记录" v={stats?.newestTs ? formatDay(stats.newestTs) : '—'} />
        </div>
        {(stats?.byDay ?? []).length > 0 && (
          <>
            <div style={s.subTitle}>每日条数（近 14 天）</div>
            <div style={s.dayBars}>
              {(stats?.byDay ?? []).map((d) => (
                <div key={d.day} style={s.dayCol} title={d.day + '：' + d.count + ' 条'}>
                  <span style={{ ...s.dayBar, height: Math.max(2, (d.count / maxDay) * 60) }} />
                  <span style={s.dayLabel}>{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {stats?.path && <div style={s.path}>{stats.path}</div>}
      </section>

      {(stats?.bySession ?? []).length > 0 && (
        <section style={s.card}>
          <div style={s.cardTitle}>按会话占用</div>
          {(stats?.bySession ?? []).map((x) => (
            <div key={x.sessionId} style={s.sessRow}>
              <span style={s.sessName}>{x.sessionName || '（已删除会话）'}</span>
              <span style={s.sessCount}>{x.count.toLocaleString()} 条</span>
              <button style={s.danger} onClick={() => void onClearSession(x.sessionId)}>
                删除该会话历史
              </button>
            </div>
          ))}
        </section>
      )}

      <section style={s.card}>
        <div style={s.cardTitle}>维护</div>
        <div style={s.btnRow}>
          <button style={s.ghost} onClick={() => void onVacuum()}>
            压缩数据库
          </button>
          <button style={s.danger} onClick={() => void onClear()}>
            清空全部历史
          </button>
        </div>
        <div style={s.hint}>
          删除大量记录后文件不会自动缩小，执行压缩可回收磁盘空间。
        </div>
      </section>
    </div>
  )
}

function Stat({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div style={s.stat}>
      <span style={s.statK}>{k}</span>
      <span style={s.statV}>{v}</span>
    </div>
  )
}

function formatDay(ts: number): string {
  const d = new Date(ts)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

const s: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' },
  topbar: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)' },
  title: { fontWeight: 600 },
  badge: { fontSize: 'var(--fs-xs)', color: 'var(--text-1)', background: 'var(--btn2-bg)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', padding: '2px 6px', fontFamily: 'var(--font-mono)' },
  warn: { fontSize: 'var(--fs-xs)', color: 'var(--conn-error)' },
  spacer: { flex: 1 },
  seg: { display: 'flex', background: 'var(--bg-inset)', padding: 2, gap: 2, borderRadius: 'var(--r-sm)', overflow: 'hidden', flexShrink: 0 },
  segBtn: { padding: '4px 10px', background: 'transparent', color: 'var(--text-2)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 'var(--fs-xs)' },
  segActive: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  ghost: { padding: '5px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  primary: { alignSelf: 'flex-start', padding: '6px 14px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  danger: { padding: '4px 10px', background: 'var(--btn2-bg)', color: 'var(--conn-error)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  filters: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid var(--border)' },
  select: { background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)', maxWidth: 220 },
  input: { width: 130, background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', outline: 'none' },
  check: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  list: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', padding: '0 14px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', lineHeight: 1.7 },
  empty: { flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-2)', fontSize: 'var(--fs-sm)' },
  footer: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, padding: '8px 14px', borderTop: '1px solid var(--border)' },
  footText: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  notice: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, padding: '6px 14px', fontSize: 'var(--fs-xs)', color: 'var(--text-1)', borderTop: '1px solid var(--border)', background: 'var(--bg-1)' },
  noticeClose: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-sm)' },
  manage: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  card: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-1)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-lg)' },
  cardTitle: { fontSize: 'var(--fs-sm)', fontWeight: 600 },
  subTitle: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', marginTop: 4 },
  hint: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  formRow: { display: 'flex', alignItems: 'center', gap: 8 },
  formLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-1)', width: 96 },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 },
  stat: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 'var(--r-md)' },
  statK: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  statV: { fontSize: 'var(--fs-lg)', fontFamily: 'var(--font-mono)', color: 'var(--text-0)' },
  dayBars: { display: 'flex', alignItems: 'flex-end', gap: 6, height: 80 },
  dayCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 },
  dayBar: { width: '100%', maxWidth: 26, background: 'var(--text-2)', borderRadius: 'var(--r-xs)', opacity: 0.7 },
  dayLabel: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  path: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--text-2)', wordBreak: 'break-all' },
  sessRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xs)' },
  sessName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sessCount: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-2)', flexShrink: 0 },
  btnRow: { display: 'flex', gap: 8 }
}

const rs: Record<string, React.CSSProperties> = {
  mark: { background: 'var(--hl-bg)', color: 'var(--hl-fg)', borderRadius: 2, padding: '0 1px' },
  wrap: { cursor: 'pointer' },
  row: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 },
  day: { color: 'var(--text-2)', flexShrink: 0, fontSize: 'var(--fs-xs)' },
  ts: { color: 'var(--text-2)', flexShrink: 0 },
  arrow: { flexShrink: 0, width: 34 },
  size: { color: 'var(--text-2)', flexShrink: 0, width: 44, textAlign: 'right' },
  session: { color: 'var(--text-2)', flexShrink: 0, maxWidth: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-xs)' },
  tag: { flexShrink: 0, fontSize: 'var(--fs-micro)', lineHeight: '14px', padding: '0 4px', border: '1px solid', borderRadius: 'var(--r-xs)' },
  content: { color: 'var(--text-0)', minWidth: 0, flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  clamp: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  method: { flexShrink: 0, width: 46, color: 'var(--text-1)' },
  status: { flexShrink: 0, width: 30 },
  dur: { flexShrink: 0, width: 56, textAlign: 'right', color: 'var(--text-2)' },
  scenario: { flexShrink: 0, fontSize: 'var(--fs-micro)', padding: '0 4px', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 'var(--r-xs)' },
  detail: { display: 'flex', flexDirection: 'column', gap: 2, margin: '4px 0 8px 42px', padding: 8, background: 'var(--bg-1)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)' },
  detailRow: { display: 'flex', gap: 8, fontSize: 'var(--fs-xs)', minWidth: 0 },
  detailK: { color: 'var(--text-2)', width: 56, flexShrink: 0 },
  detailV: { color: 'var(--text-0)', minWidth: 0, flex: 1, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }
}
