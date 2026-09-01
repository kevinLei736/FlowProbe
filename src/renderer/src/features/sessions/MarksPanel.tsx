import { useEffect, useMemo, useRef, useState } from 'react'
import type { FrameMark } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { useMarks } from '../../store/useMarks'
import { KIND_META } from '../../app/meta'
import { Select } from '../../components/ui/Select'
import { ResizableTextarea } from '../../components/ui/ResizableTextarea'

/**
 * 报文书签与标注面板。
 *
 * 解决的问题：长时间调试时最常见的动作是「刚才那条不对劲的报文，等下回来细看」。
 * 在此之前唯一的办法是记住时间戳，然后在几万条里滚回去找 —— 而报文缓冲一清屏就没了。
 *
 * 书签存的是自洽快照（时间、方向、字节、HEX 片段、用户写的标注），
 * 所以清屏、重启、甚至删掉原会话之后，这条记录依然读得懂；
 * 原会话还在且报文还在缓冲里时，额外提供「跳回去」。
 */
export function MarksPanel({
  onClose,
  onLocate
}: {
  onClose: () => void
  /** 跳回原会话的实时时间轴。由外层决定怎么切标签与滚动 */
  onLocate?: (sessionId: string, frameId: string) => void
}): JSX.Element {
  const marks = useMarks((s) => s.marks)
  const setNote = useMarks((s) => s.setNote)
  const remove = useMarks((s) => s.remove)
  const clearAll = useMarks((s) => s.clearAll)
  const sessions = useStore((s) => s.sessions)

  const [scope, setScope] = useState('')
  const [kw, setKw] = useState('')

  /**
   * 会话下拉只列「真的有书签的会话」。
   * 列全部会话会让下拉里大半选项点了都是空列表，等于给了一堆死选项。
   */
  const scopeOpts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of marks) if (!seen.has(m.sessionId)) seen.set(m.sessionId, m.sessionName)
    return [{ value: '', label: '全部会话' }, ...[...seen].map(([id, name]) => ({ value: id, label: name }))]
  }, [marks])

  const shown = useMemo(() => {
    let list = marks
    if (scope) list = list.filter((m) => m.sessionId === scope)
    if (kw) {
      const q = kw.toLowerCase()
      list = list.filter(
        (m) =>
          m.note.toLowerCase().includes(q) ||
          m.sessionName.toLowerCase().includes(q) ||
          m.snapshotHex.toLowerCase().includes(q) ||
          (m.snapshotText ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [marks, scope, kw])

  const exportMd = async (): Promise<void> => {
    if (shown.length === 0) return
    /*
      导 Markdown 而不是 CSV：书签的产物是「排查记录」，要贴进工单或聊天里给人看。
      CSV 在这种场景下要先导入表格才能读，反而多一道手续。报文数据的 CSV 导出
      在时间轴那边已经有了。
    */
    const lines: string[] = []
    lines.push('# 报文标注')
    lines.push('')
    lines.push('导出时间：' + new Date().toLocaleString())
    lines.push('')
    let last = ""
    for (const m of [...shown].sort((a, b) => a.ts - b.ts)) {
      if (m.sessionId !== last) {
        lines.push('## ' + m.sessionName + '（' + (KIND_META[m.sessionKind]?.label ?? m.sessionKind) + '）')
        lines.push('')
        last = m.sessionId
      }
      const dir = m.direction === 'tx' ? 'TX' : m.direction === 'rx' ? 'RX' : '--'
      lines.push('- `' + new Date(m.ts).toLocaleString() + '` ' + dir + ' ' + m.size + 'B' + (m.note ? ' — ' + m.note : ''))
      lines.push('  - HEX: `' + m.snapshotHex + '`')
      if (m.snapshotText) lines.push('  - TEXT: `' + m.snapshotText.replace(/`/g, "'") + '`')
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await window.toolbox.saveTextFile('报文标注-' + stamp + '.md', lines.join('\n'))
  }

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.panel} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <span style={st.title}>报文标注与书签</span>
          <span style={st.count}>{shown.length === marks.length ? marks.length + " 条" : shown.length + " / " + marks.length + " 条"}</span>
          <span style={st.spacer} />
          <Select size="sm" style={{ minWidth: 160 }} value={scope} onChange={setScope} options={scopeOpts} />
          <input
            style={st.filter}
            value={kw}
            placeholder="搜标注 / 报文 / 会话…"
            onChange={(e) => setKw(e.target.value)}
          />
          <button style={st.ghost} disabled={shown.length === 0} onClick={() => void exportMd()}>
            导出 Markdown
          </button>
          <button style={st.ghost} disabled={marks.length === 0} onClick={clearAll}>
            全部清除
          </button>
          <button style={st.close} onClick={onClose}>✕</button>
        </div>

        <div style={st.body}>
          {marks.length === 0 && (
            <div style={st.empty}>
              还没有标注。在报文时间轴上把鼠标移到任意一行，点左侧出现的 ☆ 就能加书签，
              再在这里补一句「为什么可疑」。清屏与重启都不会丢。
            </div>
          )}
          {marks.length > 0 && shown.length === 0 && (
            <div style={st.empty}>没有匹配的标注。</div>
          )}
          {shown.map((m) => (
            <MarkRow
              key={m.id}
              mark={m}
              alive={sessions.some((s) => s.id === m.sessionId)}
              onNote={(v) => setNote(m.id, v)}
              onRemove={() => remove(m.id)}
              onLocate={onLocate ? () => onLocate(m.sessionId, m.frameId) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function MarkRow({
  mark,
  alive,
  onNote,
  onRemove,
  onLocate
}: {
  mark: FrameMark
  alive: boolean
  onNote: (v: string) => void
  onRemove: () => void
  onLocate?: () => void
}): JSX.Element {
  /*
    标注用本地 state + 失焦提交，而不是每敲一个字就写 localStorage：
    写入是同步的，逐字符写在长列表下会有可感知的卡顿。

    同时用 ref 跟一份最新值给 onBlur 读：失焦回调里如果直接读 state，拿到的是
    这一轮渲染闭包捕获的旧值。正常打字看不出问题（渲染早就跟上了），但「输入完
    立刻点走」这种连续操作会把最后一次改动丢掉，而丢的恰恰是用户刚写的那句话。
  */
  const [draft, setDraft] = useState(mark.note)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // 书签被外部改动（例如换了筛选条件后复用同一行）时同步回来
  useEffect(() => {
    setDraft(mark.note)
  }, [mark.id, mark.note])
  const dir = mark.direction === 'tx' ? '▶ TX' : mark.direction === 'rx' ? '◀ RX' : '· SYS'
  return (
    <div style={st.row}>
      <div style={st.rowHead}>
        <span style={{ ...st.dir, color: mark.direction === 'tx' ? 'var(--tx)' : 'var(--rx)' }}>{dir}</span>
        <span style={st.time}>{new Date(mark.ts).toLocaleString()}</span>
        <span style={st.size}>{mark.size}B</span>
        <span style={st.session} title={mark.sessionName}>
          {mark.sessionName}
        </span>
        <span style={st.kind}>{KIND_META[mark.sessionKind]?.label ?? mark.sessionKind}</span>
        <span style={st.spacer} />
        {onLocate && alive && (
          <button style={st.linkBtn} title="切到该会话的实时时间轴并定位这条报文" onClick={onLocate}>
            跳回会话
          </button>
        )}
        {!alive && <span style={st.gone} title="原会话已删除，但快照仍可读">会话已删除</span>}
        <button style={st.del} title="删除这条标注" onClick={onRemove}>✕</button>
      </div>
      <div style={st.snap} title={mark.snapshotHex}>{mark.snapshotHex}</div>
      {mark.snapshotText && <div style={st.snapText} title={mark.snapshotText}>{mark.snapshotText}</div>}
      <ResizableTextarea
        value={draft}
        onChange={setDraft}
        onBlur={() => {
          if (draftRef.current !== mark.note) onNote(draftRef.current)
        }}
        placeholder="写下为什么标它：现象、怀疑点、下一步要验证什么…"
        min={44}
        max={260}
        mono={false}
        textareaStyle={{ fontSize: "var(--fs-sm)" }}
      />
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
    width: 'min(1020px, 94vw)',
    height: 'min(700px, 88vh)',
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
  count: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  spacer: { flex: 1 },
  filter: {
    width: 190,
    height: 'var(--control-h-sm)',
    padding: '0 8px',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    outline: 'none'
  },
  ghost: {
    padding: '5px 12px',
    background: 'var(--btn2-bg)',
    color: 'var(--text-1)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)'
  },
  close: { background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 'var(--fs-lg)' },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12
  },
  empty: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: 1.8, padding: '18px 6px' },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 10px',
    background: 'var(--bg-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-md)'
  },
  rowHead: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xs)' },
  dir: { flexShrink: 0, width: 40, fontFamily: 'var(--font-mono)' },
  time: { flexShrink: 0, color: 'var(--text-1)', fontFamily: 'var(--font-mono)' },
  size: { flexShrink: 0, width: 46, textAlign: 'right', color: 'var(--text-2)' },
  session: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 200,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    color: 'var(--text-0)'
  },
  kind: { flexShrink: 0, color: 'var(--text-2)' },
  linkBtn: {
    padding: '2px 8px',
    background: 'var(--btn2-bg)',
    color: 'var(--text-1)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-micro)'
  },
  gone: { color: 'var(--text-3)', fontSize: 'var(--fs-micro)' },
  del: {
    width: 22,
    height: 22,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-xs)'
  },
  snap: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-2)',
    wordBreak: 'break-all',
    lineHeight: 1.6
  },
  snapText: {
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-3)',
    wordBreak: 'break-all',
    lineHeight: 1.6
  }
}
