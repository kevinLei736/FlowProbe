import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryContextResult, HistoryFrameRow, HistoryHttpRow, Encoding } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { KIND_META } from '../../app/meta'
import { decodeFrame, formatTs } from '../sessions/frameExport'
import { Select } from '../../components/ui/Select'
import { btnSecondary, btnSm, iconBtnSm, overlay, surface } from '../../components/ui/tokens'

/** 一次「继续加载」补多少条。50 是一屏多一点，够看清前后因果又不至于一次拉太多 */
const STEP = 50

export interface ContextTarget {
  kind: 'frame' | 'http'
  id: number
  keyword: string
}

/**
 * 历史上下文视图。
 *
 * 解决的问题：全局搜索命中一条报文后，只知道「这条长什么样」，
 * 不知道它前后发生了什么——而排查时真正有用的恰恰是前后文。
 * 之前只能跳到历史页用同一关键字翻页，但翻页结果里全是命中行，
 * 命中行之间的非命中报文（往往是关键的握手、心跳、错误响应）反而看不到。
 *
 * 这里以命中行为锚点向前后各取若干条，锚点高亮并滚动居中。
 *
 * 为什么不用 VirtualList：上下文是有界的（默认 101 条，上限 1001），
 * 直接渲染即可，而虚拟列表要滚到任意一行需要额外的命令式 API。
 * 用真实 DOM 反而能直接 scrollIntoView 把锚点摆到视口中间。
 */
export function HistoryContextView({
  target,
  onClose,
  onLocateSession
}: {
  target: ContextTarget
  onClose: () => void
  /** 原会话仍存在时，跳回实时时间轴 */
  onLocateSession: (sessionId: string) => void
}): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const [data, setData] = useState<HistoryContextResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [before, setBefore] = useState(STEP)
  const [after, setAfter] = useState(STEP)
  const [viewFormat, setViewFormat] = useState<Encoding>('utf8')
  const anchorRef = useRef<HTMLDivElement | null>(null)
  // 首次定位后不再自动居中，否则用户点「继续加载」时视口会被拽回去
  const centered = useRef(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.toolbox
      .historyContext({ kind: target.kind, id: target.id, before, after })
      .then((r) => {
        if (alive) setData(r)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [target.kind, target.id, before, after])

  useEffect(() => {
    if (!data || centered.current) return
    const el = anchorRef.current
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    centered.current = true
  }, [data])

  const rows = useMemo(
    () => (data ? (data.kind === 'http' ? data.https : data.frames) : []),
    [data]
  )
  const liveSession = data ? sessions.find((s) => s.id === data.sessionId) : undefined

  // 为什么用 window 捕获阶段而不是面板上的 onKeyDown：面板只有 tabIndex=-1、
  // 并没有夺取焦点（焦点通常还在搜索框里），键盘事件不会冒泡到它身上。
  // 捕获阶段 + stopPropagation 还能保证 Esc 只关掉最上层的本浮层，
  // 不会连带把底下的搜索面板一起关掉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const recenter = (): void => {
    anchorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.panel} onClick={(e) => e.stopPropagation()} tabIndex={-1}>
        <div style={st.head}>
          <div style={st.title}>历史上下文</div>
          <div style={st.sub}>
            {data
              ? (data.sessionName || '（会话已删除）') +
                ' · ' +
                kindLabel(data.sessionKind) +
                ' · 该会话共 ' +
                data.sessionTotal.toLocaleString() +
                ' 条'
              : '加载中…'}
          </div>
          <span style={st.spacer} />
          {data?.kind === 'frame' && (
            <Select
              size="sm"
              style={{ width: 96 }}
              value={viewFormat}
              searchable={false}
              onChange={(v) => setViewFormat(v as Encoding)}
              options={[
                { value: 'utf8', label: 'TEXT' },
                { value: 'hex', label: 'HEX' },
                { value: 'base64', label: 'B64' }
              ]}
            />
          )}
          <button style={st.act} onClick={recenter} title="回到命中行">
            回到命中
          </button>
          {liveSession && (
            <button
              style={st.act}
              onClick={() => {
                onLocateSession(liveSession.id)
                onClose()
              }}
              title="切到该会话的实时时间轴"
            >
              打开实时会话
            </button>
          )}
          <button style={iconBtnSm} onClick={onClose} aria-label="关闭" title="关闭 (Esc)">
            ✕
          </button>
        </div>

        <div style={st.list}>
          {data?.hasBefore && (
            <button style={st.loadMore} disabled={loading} onClick={() => setBefore((v) => v + STEP)}>
              {loading ? '加载中…' : '↑ 再往前 ' + STEP + ' 条'}
            </button>
          )}
          {!data?.hasBefore && data && (
            <div style={st.edge}>—— 这是该会话在历史库中最早的记录 ——</div>
          )}

          {rows.length === 0 && !loading && (
            <div style={st.empty}>
              这条记录已被历史保留策略清理，找不到它的上下文了。
            </div>
          )}

          {rows.map((r, i) => {
            const isAnchor = r.id === data?.focusId
            return (
              <div
                key={r.id}
                ref={isAnchor ? anchorRef : undefined}
                style={{ ...st.row, ...(isAnchor ? st.rowAnchor : {}) }}
              >
                {isAnchor && <span style={st.anchorTag}>命中</span>}
                {data?.kind === 'http'
                  ? renderHttp(r as HistoryHttpRow, target.keyword, isAnchor)
                  : renderFrame(r as HistoryFrameRow, viewFormat, target.keyword, isAnchor)}
                <span style={st.seq}>{i + 1}</span>
              </div>
            )
          })}

          {data?.hasAfter && (
            <button style={st.loadMore} disabled={loading} onClick={() => setAfter((v) => v + STEP)}>
              {loading ? '加载中…' : '↓ 再往后 ' + STEP + ' 条'}
            </button>
          )}
          {!data?.hasAfter && data && rows.length > 0 && (
            <div style={st.edge}>—— 这是该会话在历史库中最新的记录 ——</div>
          )}
        </div>

        <div style={st.foot}>
          共显示 {rows.length} 条（命中行前 {data ? data.focusIndex : 0} 条 / 后{' '}
          {data ? Math.max(0, rows.length - data.focusIndex - 1) : 0} 条） · Esc 关闭
        </div>
      </div>
    </div>
  )
}

function renderFrame(
  r: HistoryFrameRow,
  viewFormat: Encoding,
  keyword: string,
  isAnchor: boolean
): JSX.Element {
  const body = decodeFrame({ rawBase64: r.rawBase64, text: r.text }, viewFormat)
  const isTx = r.direction === 'tx'
  const isSystem = r.direction === 'system'
  const color = isSystem
    ? r.level === 'success'
      ? 'var(--conn-ok)'
      : r.level === 'warn'
        ? 'var(--conn-warn)'
        : r.level === 'error'
          ? 'var(--conn-error)'
          : 'var(--text-2)'
    : isTx
      ? 'var(--tx)'
      : 'var(--rx)'
  return (
    <>
      <span style={st.ts}>{formatTs(r.ts)}</span>
      <span style={{ ...st.dir, color }}>{isSystem ? '--' : isTx ? '▶ TX' : '◀ RX'}</span>
      <span style={st.size}>{r.size}B</span>
      {r.peerLabel && <span style={st.peer}>{r.peerLabel}</span>}
      <span style={{ ...st.body, ...(isAnchor ? st.bodyAnchor : {}) }}>
        {mark(body, keyword)}
      </span>
    </>
  )
}

function renderHttp(r: HistoryHttpRow, keyword: string, isAnchor: boolean): JSX.Element {
  const color =
    r.status >= 500 ? 'var(--conn-error)' : r.status >= 400 ? 'var(--conn-warn)' : 'var(--conn-ok)'
  return (
    <>
      <span style={st.ts}>{formatTs(r.ts)}</span>
      <span style={st.method}>{r.method}</span>
      <span style={{ ...st.status, color }}>{r.status}</span>
      <span style={st.size}>{r.durationMs}ms</span>
      <span style={{ ...st.body, ...(isAnchor ? st.bodyAnchor : {}) }}>
        {mark(r.path + (r.query ? '?' + r.query : ''), keyword)}
      </span>
    </>
  )
}

/** 关键字高亮。上限 60 段，避免一条报文里命中上百次时切出过多节点 */
function mark(text: string, keyword: string): React.ReactNode {
  const kw = keyword.trim()
  if (kw.length === 0) return text
  const lower = text.toLowerCase()
  const target = kw.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  let n = 0
  while (n < 60) {
    const at = lower.indexOf(target, from)
    if (at < 0) break
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} style={st.hl}>
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

function kindLabel(kind: string): string {
  const meta = (KIND_META as Record<string, { label?: string } | undefined>)[kind]
  return meta?.label ?? kind
}

const st: Record<string, React.CSSProperties> = {
  // 这层浮在全局搜索之上（搜索面板 zIndex 90），所以不能直接用 overlay 令牌的 60
  overlay: { ...overlay, zIndex: 96 },
  act: { ...btnSecondary, ...btnSm },
  panel: {
    ...surface,
    width: 'min(1000px, 95vw)',
    height: '82vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    outline: 'none'
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-subtle)'
  },
  title: { fontWeight: 600, fontSize: 'var(--fs-lg)' },
  sub: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  spacer: { flex: 1 },
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: '8px 0',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-sm)',
    lineHeight: 1.7
  },
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '2px 46px 2px 16px',
    borderLeft: '2px solid transparent'
  },
  // 锚点行三通道表达：底色 + 左侧色条 + 加重字色，弱对比屏上也能定位
  rowAnchor: {
    background: 'var(--selected-strong-bg)',
    borderLeftColor: 'var(--text-0)',
    // 右侧留出「命中」标签的位置，避免长报文正文压到标签底下
    padding: '6px 96px 6px 16px'
  },
  // 标签贴在行内右侧（序号左边）。早先放在行左上角是负偏移，会溢出到卡片圆角外面
  anchorTag: {
    position: 'absolute',
    right: 34,
    top: '50%',
    transform: 'translateY(-50%)',
    padding: '1px 6px',
    background: 'var(--btn-bg)',
    color: 'var(--btn-fg)',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-micro)',
    fontFamily: 'var(--font-sans)'
  },
  ts: { flexShrink: 0, color: 'var(--text-2)' },
  dir: { flexShrink: 0 },
  method: { flexShrink: 0, color: 'var(--text-1)', minWidth: 46 },
  status: { flexShrink: 0 },
  size: { flexShrink: 0, color: 'var(--text-2)' },
  peer: { flexShrink: 0, color: 'var(--text-2)' },
  body: { flex: 1, minWidth: 0, wordBreak: 'break-all', color: 'var(--text-1)' },
  bodyAnchor: { color: 'var(--text-0)' },
  seq: {
    position: 'absolute',
    right: 12,
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-3)'
  },
  hl: { background: 'var(--hl-bg)', color: 'var(--hl-fg)', borderRadius: 2, padding: '0 1px' },
  loadMore: {
    display: 'block',
    width: 'calc(100% - 32px)',
    margin: '6px 16px',
    padding: '6px 0',
    background: 'var(--btn2-bg)',
    color: 'var(--text-1)',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-xs)',
    fontFamily: 'var(--font-sans)'
  },
  edge: {
    padding: '8px 16px',
    textAlign: 'center',
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-3)',
    fontFamily: 'var(--font-sans)'
  },
  empty: {
    padding: '32px 16px',
    textAlign: 'center',
    color: 'var(--text-2)',
    fontFamily: 'var(--font-sans)'
  },
  foot: {
    flexShrink: 0,
    padding: '8px 16px',
    borderTop: '1px solid var(--border-subtle)',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-2)'
  }
}
