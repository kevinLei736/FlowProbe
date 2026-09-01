import { useEffect, useMemo, useRef, useState } from 'react'
import { GUIDE_SECTIONS, blockText, sectionText, type GuideBlock, type GuideSection } from './guideContent'
import { guideToMarkdown } from './guideMarkdown'
import { btnGhost, btnSecondary, field, overlay, surface } from '../../components/ui/tokens'

/**
 * 使用文档面板。
 *
 * 为什么做成应用内面板而不是「打开浏览器看仓库里的 md」：需要查手册的时刻
 * 恰恰是手头正卡着的时刻，跳出应用去找文件会打断当前排查。而且离线可用 ——
 * 现场调设备时经常没有外网。
 *
 * 左目录 + 右正文的两栏结构：手册有十六章，纯滚动列表找章节要靠肉眼扫；
 * 目录常驻能一眼看到「一共讲了哪些东西」，这本身就是文档的一部分。
 */
export function GuidePanel({
  onClose,
  initialSection
}: {
  onClose: () => void
  /** 从别处带着落点打开（例如以后从某个面板的「?」直接跳到对应章节） */
  initialSection?: string
}): JSX.Element {
  const [cur, setCur] = useState(initialSection ?? GUIDE_SECTIONS[0].id)
  const [kw, setKw] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      // Ctrl+F 在这一层拦下来给「文档内搜索」，而不是让它冒泡去开全局报文搜索：
      // 文档开着的时候按 Ctrl+F，想搜的显然是文档
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /** 关键字命中数：目录里直接标出「这一章有几处提到」，省得逐章点开找 */
  const hits = useMemo(() => {
    const q = kw.trim().toLowerCase()
    const m = new Map<string, number>()
    if (!q) return m
    for (const s of GUIDE_SECTIONS) {
      const text = sectionText(s).toLowerCase()
      let n = 0
      let i = text.indexOf(q)
      while (i >= 0) {
        n++
        i = text.indexOf(q, i + q.length)
      }
      if (n > 0) m.set(s.id, n)
    }
    return m
  }, [kw])

  // 搜索后自动跳到第一个命中的章节：搜完还要自己点一下才有反应，等于搜了一半
  useEffect(() => {
    if (hits.size === 0) return
    if (hits.has(cur)) return
    const first = GUIDE_SECTIONS.find((s) => hits.has(s.id))
    if (first) setCur(first.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits])

  // 换章节回到顶部。不重置的话从长章节切到短章节会停在一片空白上
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [cur])

  const section = GUIDE_SECTIONS.find((s) => s.id === cur) ?? GUIDE_SECTIONS[0]
  const q = kw.trim()

  const exportMd = async (): Promise<void> => {
    // 导出整本而不是当前章：拿去存档或发同事时，缺章的手册没有意义
    await window.toolbox.saveTextFile('FlowProbe-使用文档.md', guideToMarkdown())
  }

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={{ ...surface, ...st.panel }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <span style={st.title}>使用文档</span>
          <span style={st.sub}>{GUIDE_SECTIONS.length} 章 · 离线可用</span>
          <span style={st.spacer} />
          <input
            ref={searchRef}
            style={st.search}
            value={kw}
            placeholder='在文档中搜索…  Ctrl+F'
            onChange={(e) => setKw(e.target.value)}
          />
          <button style={st.ghost} onClick={() => void exportMd()}>
            导出 Markdown
          </button>
          <button style={st.close} title='关闭' onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={st.main}>
          <div style={st.toc}>
            {GUIDE_SECTIONS.map((s) => {
              const n = hits.get(s.id)
              const dim = q.length > 0 && n === undefined
              return (
                <button
                  key={s.id}
                  style={{
                    ...st.tocItem,
                    ...(s.id === cur ? st.tocItemOn : {}),
                    ...(dim ? st.tocItemDim : {})
                  }}
                  title={s.summary}
                  onClick={() => setCur(s.id)}
                >
                  <span style={st.tocLabel}>{s.title}</span>
                  {n !== undefined && <span style={st.tocHit}>{n}</span>}
                </button>
              )
            })}
          </div>

          <div style={st.body} ref={bodyRef}>
            <div style={st.h1}>{section.title}</div>
            <div style={st.lead}>{section.summary}</div>
            {section.blocks.map((b, i) => (
              <Block key={i} b={b} q={q} />
            ))}
            <Footer section={section} onGo={setCur} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** 上一章 / 下一章。手册是顺序读物，读完一章接着往下是最常见的动作 */
function Footer({ section, onGo }: { section: GuideSection; onGo: (id: string) => void }): JSX.Element {
  const i = GUIDE_SECTIONS.findIndex((s) => s.id === section.id)
  const prev = i > 0 ? GUIDE_SECTIONS[i - 1] : null
  const next = i < GUIDE_SECTIONS.length - 1 ? GUIDE_SECTIONS[i + 1] : null
  return (
    <div style={st.foot}>
      {prev ? (
        <button style={st.navBtn} onClick={() => onGo(prev.id)}>
          ← {prev.title}
        </button>
      ) : (
        <span />
      )}
      <span style={{ flex: 1 }} />
      {next && (
        <button style={st.navBtn} onClick={() => onGo(next.id)}>
          {next.title} →
        </button>
      )}
    </div>
  )
}

/**
 * 关键字高亮。
 *
 * 用 split 而不是正则替换 + dangerouslySetInnerHTML：文档正文里有 {{}}、
 * <> 这类字符，走 innerHTML 会被当标签解析，而且给了一条注入路径。
 */
function Hl({ text, q }: { text: string; q: string }): JSX.Element {
  if (!q) return <>{text}</>
  const lower = text.toLowerCase()
  const lq = q.toLowerCase()
  const out: JSX.Element[] = []
  let i = 0
  let n = 0
  for (;;) {
    const at = lower.indexOf(lq, i)
    if (at < 0) break
    if (at > i) out.push(<span key={n++}>{text.slice(i, at)}</span>)
    out.push(<mark key={n++}>{text.slice(at, at + q.length)}</mark>)
    i = at + q.length
  }
  if (i === 0) return <>{text}</>
  if (i < text.length) out.push(<span key={n++}>{text.slice(i)}</span>)
  return <>{out}</>
}

function Block({ b, q }: { b: GuideBlock; q: string }): JSX.Element {
  switch (b.t) {
    case 'h':
      return <div style={st.h2}><Hl text={b.text} q={q} /></div>
    case 'p':
      return <p style={st.p}><Hl text={b.text} q={q} /></p>
    case 'note':
      return (
        <div style={st.note}>
          <span style={st.noteMark}>提示</span>
          <span><Hl text={b.text} q={q} /></span>
        </div>
      )
    case 'code':
      return <pre style={st.code}>{b.text}</pre>
    case 'bullets':
      return (
        <ul style={st.ul}>
          {b.items.map((x, i) => (
            <li key={i} style={st.li}><Hl text={x} q={q} /></li>
          ))}
        </ul>
      )
    case 'steps':
      return (
        <ol style={st.ol}>
          {b.items.map((x, i) => (
            <li key={i} style={st.li}><Hl text={x} q={q} /></li>
          ))}
        </ol>
      )
    case 'table':
      return (
        <div style={st.table}>
          <div style={st.trHead}>
            {b.head.map((h, i) => (
              <span key={i} style={{ ...st.th, flex: i === 0 ? '0 0 30%' : 1 }}>{h}</span>
            ))}
          </div>
          {b.rows.map((r, ri) => (
            <div key={ri} style={st.tr}>
              {r.map((c, ci) => (
                <span key={ci} style={{ ...st.td, flex: ci === 0 ? '0 0 30%' : 1, color: ci === 0 ? 'var(--text-0)' : 'var(--text-1)' }}>
                  <Hl text={c} q={q} />
                </span>
              ))}
            </div>
          ))}
        </div>
      )
  }
}

// 未使用 blockText，但保留 import 会被 tsc 判为未用；这里显式引用一次以说明意图
void blockText

const st: Record<string, React.CSSProperties> = {
  panel: {
    width: 'min(1080px, 94vw)',
    height: 'min(760px, 90vh)',
    display: 'flex',
    flexDirection: 'column',
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
  sub: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  spacer: { flex: 1 },
  search: { ...field, width: 240, height: 'var(--control-h-sm)', fontSize: 'var(--fs-sm)' },
  ghost: { ...btnSecondary, height: 'var(--control-h-sm)', fontSize: 'var(--fs-sm)' },
  close: { ...btnGhost, width: 28, padding: 0, fontSize: 'var(--fs-lg)' },
  main: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '236px minmax(0, 1fr)' },
  toc: {
    borderRight: '1px solid var(--border)',
    overflowY: 'auto',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 2
  },
  tocItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 10px',
    background: 'transparent',
    color: 'var(--text-1)',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    textAlign: 'left',
    lineHeight: 1.4
  },
  tocItemOn: { background: 'var(--selected-strong-bg)', color: 'var(--text-0)', fontWeight: 500 },
  // 无命中的章节压暗而不是隐藏：整本的目录结构本身是信息，抽掉一半会让人以为文档变短了
  tocItemDim: { color: 'var(--text-3)' },
  tocLabel: { flex: 1, minWidth: 0 },
  tocHit: {
    flexShrink: 0,
    minWidth: 18,
    textAlign: 'center',
    padding: '1px 5px',
    borderRadius: 'var(--r-pill)',
    background: 'var(--bg-inset)',
    color: 'var(--text-2)',
    fontSize: 'var(--fs-micro)',
    fontFamily: 'var(--font-mono)'
  },
  body: { overflowY: 'auto', padding: '18px 26px 26px', minWidth: 0 },
  h1: { fontSize: 'var(--fs-xl)', fontWeight: 600, color: 'var(--text-0)' },
  lead: { marginTop: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: 'var(--lh-normal)' },
  h2: { marginTop: 20, fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-0)' },
  p: { margin: '12px 0 0', fontSize: 'var(--fs-md)', color: 'var(--text-1)', lineHeight: 1.75 },
  ul: { margin: '10px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 },
  ol: { margin: '10px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 },
  li: { fontSize: 'var(--fs-md)', color: 'var(--text-1)', lineHeight: 1.7 },
  note: {
    display: 'flex',
    gap: 10,
    margin: '14px 0 0',
    padding: '10px 12px',
    background: 'var(--bg-inset)',
    borderRadius: 'var(--r-md)',
    borderLeft: '2px solid var(--border-strong)',
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-1)',
    lineHeight: 1.7
  },
  noteMark: { flexShrink: 0, color: 'var(--text-2)', fontSize: 'var(--fs-xs)', paddingTop: 2 },
  code: {
    margin: '10px 0 0',
    padding: '10px 12px',
    background: 'var(--bg-inset)',
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-1)',
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto'
  },
  table: {
    marginTop: 12,
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-md)',
    overflow: 'hidden'
  },
  trHead: { display: 'flex', gap: 12, padding: '7px 12px', background: 'var(--bg-2)' },
  tr: { display: 'flex', gap: 12, padding: '8px 12px', borderTop: '1px solid var(--border-subtle)' },
  th: { fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--text-2)', minWidth: 0 },
  td: { fontSize: 'var(--fs-sm)', lineHeight: 1.65, minWidth: 0, wordBreak: 'break-word' },
  foot: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 26, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' },
  navBtn: { ...btnGhost, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' }
}
