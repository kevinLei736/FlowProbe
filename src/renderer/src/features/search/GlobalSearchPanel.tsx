import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GlobalSearchResult, SearchHit } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { KIND_META } from '../../app/meta'
import { Select } from '../../components/ui/Select'

/**
 * 搜索落点：交给 App 决定怎么落地。
 *
 * 两种落法解决的是不同问题：
 * - list：跳历史页并沿用同一关键字，适合「这个串一共出现过多少次、都在哪」；
 * - context：跳到命中行在原会话时间轴上的前后文，适合「这条报文当时发生了什么」。
 *   后者才是排查现场最常要的，但它需要命中行的库内 id 作为锚点。
 */
export interface SearchJump {
  kind: 'frame' | 'http'
  sessionId: string
  keyword: string
  /** 落地方式。默认 list，保持原有 Enter 行为不变 */
  mode?: 'list' | 'context'
  /** 命中行在历史库中的 id，mode='context' 时必需 */
  hitId?: number
}

type Scope = 'recent' | 'all'

/** 最近 5 万条足够覆盖绝大多数排查场景，且能把查询压到个位数毫秒 */
const RECENT_SCAN = 50000
const DEBOUNCE_MS = 260

/**
 * 全局搜索面板。
 *
 * 历史页的关键字筛选要求先知道「在哪个会话、大概哪一天」；
 * 真实排查往往反过来——只记得报文里有个串，不记得会话也不记得时间。
 * 这里一次打穿报文与 HTTP 两张表，按会话聚合命中数，点结果直接落到对应位置。
 */
export function GlobalSearchPanel({
  onClose,
  onJump
}: {
  onClose: () => void
  onJump: (j: SearchJump) => void
}): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const [keyword, setKeyword] = useState('')
  const [scope, setScope] = useState<Scope>('recent')
  const [sessionId, setSessionId] = useState('')
  const [result, setResult] = useState<GlobalSearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 输入防抖：每敲一个字符都打一次全表 LIKE 会让长关键字的中间态白跑好几次
  useEffect(() => {
    const kw = keyword.trim()
    if (kw.length === 0) {
      setResult(null)
      setBusy(false)
      return
    }
    setBusy(true)
    const mine = ++seq.current
    const t = setTimeout(() => {
      void window.toolbox
        .historySearch({
          keyword: kw,
          scanLimit: scope === 'recent' ? RECENT_SCAN : 0,
          perKind: 60,
          sessionIds: sessionId ? [sessionId] : undefined
        })
        .then((r) => {
          // 丢弃过期请求的结果，否则慢的那次会盖掉新的
          if (mine !== seq.current) return
          setResult(r)
          setCursor(0)
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [keyword, scope, sessionId])

  const hits = useMemo<SearchHit[]>(() => {
    if (!result) return []
    // 两类结果按时间倒序交织，最近发生的排前面
    return [...result.frames, ...result.https].sort((a, b) => b.ts - a.ts)
  }, [result])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-cursor="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor, hits])

  const accept = useCallback(
    (i: number, mode: 'list' | 'context' = 'list'): void => {
      const h = hits[i]
      if (!h) return
      onClose()
      onJump({
        kind: h.kind,
        sessionId: h.sessionId,
        keyword: keyword.trim(),
        mode,
        hitId: h.id
      })
    },
    [hits, keyword, onClose, onJump]
  )

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (hits.length ? (c + 1) % hits.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (hits.length ? (c - 1 + hits.length) % hits.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Shift+Enter 看前后文，Enter 仍是原来的「跳历史页续查」，
      // 这样老习惯不被打断，新能力也在同一个手势附近
      accept(cursor, e.shiftKey ? 'context' : 'list')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const total = (result?.frameTotal ?? 0) + (result?.httpTotal ?? 0)
  const shown = hits.length

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div style={styles.head}>
          <input
            ref={inputRef}
            style={styles.input}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="在全部历史报文与请求中搜索…"
          />
        </div>
        <div style={styles.bar}>
          <div style={styles.seg}>
            <button
              style={{ ...styles.segBtn, ...(scope === 'recent' ? styles.segOn : {}) }}
              onClick={() => setScope('recent')}
              title="只搜最近 5 万条，速度最快"
            >
              最近 5 万条
            </button>
            <button
              style={{ ...styles.segBtn, ...(scope === 'all' ? styles.segOn : {}) }}
              onClick={() => setScope('all')}
              title="搜索整个历史库，大库上会慢一些"
            >
              全部历史
            </button>
          </div>
          <Select
            size="sm"
            style={{ maxWidth: 200, minWidth: 130 }}
            value={sessionId}
            onChange={setSessionId}
            options={[
              { value: '', label: '全部会话' },
              ...sessions.map((s) => ({ value: s.id, label: s.name, group: '会话' }))
            ]}
          />
          <div style={styles.stat}>
            {busy
              ? '搜索中…'
              : result
                ? '命中 ' + total + ' 条 · 显示 ' + shown + ' · 扫描 ' + result.scanned.toLocaleString() + ' 行 · ' + result.elapsedMs + 'ms'
                : '输入关键字开始搜索'}
          </div>
        </div>
        {result && result.bySession.length > 1 && (
          <div style={styles.chips}>
            {result.bySession.map((b) => (
              <button
                key={b.sessionId}
                style={{ ...styles.chip, ...(sessionId === b.sessionId ? styles.chipOn : {}) }}
                onClick={() => setSessionId(sessionId === b.sessionId ? '' : b.sessionId)}
              >
                {b.sessionName || '（已删除）'} <span style={styles.chipNum}>{b.count}</span>
              </button>
            ))}
          </div>
        )}
        <div style={styles.list} ref={listRef}>
          {!result && !busy && (
            <div style={styles.empty}>
              搜索范围是本地历史库里的报文正文，以及 HTTP 请求的路径、查询串、请求体与响应体。
            </div>
          )}
          {result && hits.length === 0 && !busy && (
            <div style={styles.empty}>
              没有命中。
              {result.truncated && ' 当前只搜了最近 5 万条，可切到「全部历史」再试。'}
            </div>
          )}
          {hits.map((h, i) => (
            <div
              key={h.kind + ':' + h.id}
              data-cursor={i === cursor ? '1' : '0'}
              style={{ ...styles.row, ...(i === cursor ? styles.rowOn : {}) }}
              onMouseEnter={() => setCursor(i)}
              onClick={(e) => accept(i, e.shiftKey ? 'context' : 'list')}
            >
              <div style={styles.rowTop}>
                <span style={styles.time}>{fmtTs(h.ts)}</span>
                <span style={styles.badge}>{h.kind === 'frame' ? dirLabel(h) : h.method}</span>
                {h.kind === 'http' && (
                  <span style={{ ...styles.status, color: statusColor(h.status ?? 0) }}>
                    {h.status}
                  </span>
                )}
                <span style={styles.sess}>{h.sessionName || '（已删除）'}</span>
                <span style={styles.kind}>{kindLabel(h.sessionKind)}</span>
                <button
                  style={styles.ctxBtn}
                  title="查看这条记录在原会话时间轴上的前后文"
                  onClick={(e) => {
                    e.stopPropagation()
                    accept(i, 'context')
                  }}
                >
                  前后文
                </button>
              </div>
              <div style={styles.snippet}>{highlight(h)}</div>
            </div>
          ))}
          {result && total > shown && (
            <div style={styles.more}>
              还有 {total - shown} 条命中未显示，回车跳到历史页可用同一关键字继续翻页。
            </div>
          )}
        </div>
        <div style={styles.foot}>
          ↑↓ 选择 · Enter 跳历史页续查 · Shift+Enter 看命中行前后文 · Esc 关闭
        </div>
      </div>
    </div>
  )
}

/** 把关键字命中处高亮。matchAt 由主进程算好，界面不再重复找一遍 */
function highlight(h: SearchHit): JSX.Element {
  if (h.matchAt < 0) return <>{h.snippet}</>
  const a = h.snippet.slice(0, h.matchAt)
  const b = h.snippet.slice(h.matchAt, h.matchAt + h.matchLen)
  const c = h.snippet.slice(h.matchAt + h.matchLen)
  return (
    <>
      {a}
      <mark style={styles.mark}>{b}</mark>
      {c}
    </>
  )
}

function dirLabel(h: SearchHit): string {
  if (h.direction === 'tx') return 'TX'
  if (h.direction === 'rx') return 'RX'
  return '系统'
}

function kindLabel(kind: string): string {
  const meta = (KIND_META as Record<string, { label?: string } | undefined>)[kind]
  return meta?.label ?? kind
}

function statusColor(status: number): string {
  if (status >= 500) return 'var(--error)'
  if (status >= 400) return 'var(--warn)'
  return 'var(--text-1)'
}

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '9vh', zIndex: 90 },
  panel: { width: 'min(760px, 94vw)', maxHeight: '74vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  head: { display: 'flex', borderBottom: '1px solid var(--border-subtle)' },
  input: { flex: 1, padding: '13px 16px', background: 'transparent', color: 'var(--field-fg)', border: 'none', fontSize: 'var(--fs-lg)', outline: 'none', fontFamily: 'inherit' },
  bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)' },
  seg: { display: 'flex', gap: 2, background: 'var(--bg-inset)', borderRadius: 'var(--r-sm)', padding: 2 },
  segBtn: { padding: '3px 10px', background: 'transparent', color: 'var(--text-2)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 'var(--fs-xs)' },
  segOn: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  select: { padding: '4px 8px', background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)', maxWidth: 180 },
  stat: { marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 999, fontSize: 'var(--fs-xs)' },
  chipOn: { background: 'var(--selected-bg)', color: 'var(--text-0)' },
  chipNum: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  list: { flex: 1, overflowY: 'auto', padding: '4px 0', minHeight: 120 },
  row: { padding: '7px 16px', cursor: 'pointer', borderLeft: '2px solid transparent' },
  rowOn: { background: 'var(--selected-bg)', borderLeftColor: 'var(--text-1)' },
  rowTop: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  time: { flexShrink: 0 },
  badge: { flexShrink: 0, color: 'var(--text-1)' },
  status: { flexShrink: 0 },
  sess: { color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 },
  kind: { marginLeft: 'auto', flexShrink: 0 },
  ctxBtn: { flexShrink: 0, padding: '1px 7px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: 'none', borderRadius: 'var(--r-pill)', fontSize: 'var(--fs-micro)', fontFamily: 'var(--font-sans)' },
  snippet: { marginTop: 3, fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', color: 'var(--text-0)', wordBreak: 'break-all', lineHeight: 1.5, maxHeight: 54, overflow: 'hidden' },
  mark: { background: 'var(--hl-bg)', color: 'var(--hl-fg)', borderRadius: 2, padding: '0 1px' },
  more: { padding: '10px 16px', fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  empty: { padding: '18px 16px', fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: 1.6 },
  foot: { padding: '7px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }
}
