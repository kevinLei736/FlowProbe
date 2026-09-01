import { useMemo, useState } from 'react'
import { useDiff } from '../../store/useDiff'
import { useProtoTemplates } from '../../store/useProtoTemplates'
import { base64ToBytes, formatTs } from './frameExport'
import { resolveParsed } from './ProtoFieldTable'
import { ascii, diffBytes, hex, type DiffCell } from './byteDiff'

/** 每行显示的字节数。16 是 HEX 编辑器的通用约定，和大多数抓包工具对得上 */
const PER_ROW = 16

/**
 * 报文级对比视图。
 *
 * 布局是「上下两条并排的 HEX 视图 + 逐字节对齐着色」，而不是常见的左右分栏：
 * 报文一行 16 字节已经占掉不少横向空间，左右分栏会让每侧只剩 8 字节一行，
 * 偏移量对不上人的直觉。上下排布则能保持两侧偏移完全对齐，
 * 视线上下扫就能看出哪一位变了。
 *
 * 着色只用明度与字重，不引入彩色：这是全局审美约束，
 * 差异格用加深底色 + 加重字色表达，仅左/仅右额外用括号包住字节。
 */
export function DiffView({ onClose }: { onClose: () => void }): JSX.Element | null {
  const picks = useDiff((s) => s.picks)
  const clear = useDiff((s) => s.clear)
  const templates = useProtoTemplates((s) => s.templates)
  // 默认 HEX：字段视角依赖协议模板，没配模板的会话点进来会是一片空白
  const [view, setView] = useState<'hex' | 'field'>('hex')

  /**
   * 字段视角。
   *
   * 两侧各自按「自动匹配」解析，然后按下标配对。
   * 为什么按下标而不按字段名匹配：同一模板下字段顺序固定，下标即语义；
   * 而不同模板的字段名可能重复（都叫「长度」却在不同偏移），按名字配会张冠李戴。
   */
  const fieldRows = useMemo(() => {
    if (picks.length !== 2) return null
    const a = resolveParsed({ rawBase64: picks[0].rawBase64, direction: picks[0].direction as 'tx' }, templates, 'auto')
    const b = resolveParsed({ rawBase64: picks[1].rawBase64, direction: picks[1].direction as 'tx' }, templates, 'auto')
    if (!a && !b) return { a: null, b: null, rows: [] }
    const n = Math.max(a?.fields.length ?? 0, b?.fields.length ?? 0)
    const rows: Array<{ name: string; la: string; lb: string; ra: string; rb: string; diff: boolean }> = []
    for (let i = 0; i < n; i++) {
      const fa = a?.fields[i]
      const fb = b?.fields[i]
      rows.push({
        name: fa?.name ?? fb?.name ?? '字段 ' + (i + 1),
        la: fa ? String(fa.value) + (fa.unit ? ' ' + fa.unit : '') : '—',
        lb: fb ? String(fb.value) + (fb.unit ? ' ' + fb.unit : '') : '—',
        ra: fa?.raw ?? '',
        rb: fb?.raw ?? '',
        // 比原始字节而不是显示值：显示值可能因缩放系数四舍五入后看起来相同
        diff: (fa?.raw ?? '') !== (fb?.raw ?? '')
      })
    }
    return { a, b, rows }
  }, [picks, templates])

  const result = useMemo(() => {
    if (picks.length !== 2) return null
    const a = base64ToBytes(picks[0].rawBase64)
    const b = base64ToBytes(picks[1].rawBase64)
    return diffBytes(a, b)
  }, [picks])

  if (picks.length !== 2 || !result) return null

  const [L, R] = picks
  const rows: DiffCell[][] = []
  for (let i = 0; i < result.cells.length; i += PER_ROW) {
    rows.push(result.cells.slice(i, i + PER_ROW))
  }

  const identical = result.replaceCount + result.leftOnlyCount + result.rightOnlyCount === 0

  return (
    <div style={st.wrap}>
      <div style={st.head}>
        <span style={st.title}>报文对比</span>
        <span style={st.sub}>
          {L.sessionName} · {formatTs(L.ts)} · {L.size}B
        </span>
        <span style={st.vs}>对</span>
        <span style={st.sub}>
          {R.sessionName} · {formatTs(R.ts)} · {R.size}B
        </span>
        <span style={st.spacer} />
        {identical ? (
          <span style={st.summaryOk}>两条报文完全一致</span>
        ) : (
          <span style={st.summary}>
            相同 {result.sameCount} · 不同 {result.replaceCount} · 仅左 {result.leftOnlyCount} · 仅右{' '}
            {result.rightOnlyCount}
          </span>
        )}
        {result.degraded && (
          <span style={st.degraded} title="报文过长，已退化为逐位置比较；若存在字节插入，插入点之后可能整体错位">
            逐位置比较
          </span>
        )}
        <button style={st.ghost} onClick={clear} title="清空选择，重新挑两条报文">
          重选
        </button>
        <button style={st.ghost} onClick={onClose} aria-label="关闭对比">
          ✕
        </button>
      </div>

      <div style={st.legend}>
        <span style={st.tabs}>
          {(['hex', 'field'] as const).map((v) => (
            <button
              key={v}
              style={{ ...st.tab, ...(view === v ? st.tabOn : {}) }}
              onClick={() => setView(v)}
            >
              {v === 'hex' ? 'HEX' : '字段表'}
            </button>
          ))}
        </span>
        <Legend kind="same" label="相同" />
        <Legend kind="replace" label="不同" />
        <Legend kind="left-only" label="仅上方有" />
        <Legend kind="right-only" label="仅下方有" />
      </div>

      {view === 'field' ? (
        <div style={st.body}>
          {!fieldRows || (!fieldRows.a && !fieldRows.b) ? (
            <div style={st.hintText}>两条报文都没有匹配到协议模板。可在会话工具栏的「模板」里配置后再回来看字段差异。</div>
          ) : (
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>字段</th>
                  <th style={st.th}>上方值</th>
                  <th style={st.th}>下方值</th>
                  <th style={{ ...st.th, width: 150 }}>字节</th>
                </tr>
              </thead>
              <tbody>
                {fieldRows.rows.map((r, i) => (
                  <tr key={r.name + i}>
                    <td style={st.td}>{r.name}</td>
                    <td style={{ ...st.td, ...(r.diff ? st.tdDiff : {}) }}>{r.la}</td>
                    <td style={{ ...st.td, ...(r.diff ? st.tdDiff : {}) }}>{r.lb}</td>
                    <td style={{ ...st.td, color: 'var(--text-2)', wordBreak: 'break-all' }}>
                      {r.ra || '—'} / {r.rb || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
      <div style={st.body}>
        {rows.map((row, ri) => (
          <div key={ri} style={st.rowGroup}>
            <div style={st.offset}>{(ri * PER_ROW).toString(16).toUpperCase().padStart(4, '0')}</div>
            <div style={st.pair}>
              <ByteLine cells={row} side="left" />
              <ByteLine cells={row} side="right" />
            </div>
            <div style={st.pair}>
              <AsciiLine cells={row} side="left" />
              <AsciiLine cells={row} side="right" />
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  )
}

function cellStyle(kind: DiffCell['kind'], present: boolean): React.CSSProperties {
  if (!present) return st.cellAbsent
  if (kind === 'same') return st.cellSame
  if (kind === 'replace') return st.cellDiff
  return st.cellOnly
}

function ByteLine({ cells, side }: { cells: DiffCell[]; side: 'left' | 'right' }): JSX.Element {
  return (
    <div style={st.line}>
      <span style={st.sideTag}>{side === 'left' ? '上' : '下'}</span>
      {cells.map((c, i) => {
        const b = side === 'left' ? c.left : c.right
        return (
          <span key={i} style={cellStyle(c.kind, b !== undefined)}>
            {hex(b)}
          </span>
        )
      })}
    </div>
  )
}

function AsciiLine({ cells, side }: { cells: DiffCell[]; side: 'left' | 'right' }): JSX.Element {
  return (
    <div style={st.lineAscii}>
      <span style={st.sideTag} />
      {cells.map((c, i) => {
        const b = side === 'left' ? c.left : c.right
        return (
          <span key={i} style={{ ...cellStyle(c.kind, b !== undefined), ...st.asciiCell }}>
            {ascii(b)}
          </span>
        )
      })}
    </div>
  )
}

function Legend({ kind, label }: { kind: DiffCell['kind']; label: string }): JSX.Element {
  return (
    <span style={st.legendItem}>
      <span style={{ ...cellStyle(kind, true), ...st.legendSwatch }}>AA</span>
      {label}
    </span>
  )
}

const st: Record<string, React.CSSProperties> = {
  wrap: {
    flexShrink: 0,
    // 高度跟着内容走，最多占 44%。
    //
    // 关键是下面 body 必须用 flex:'0 1 auto' 而不是 '1 1 0'：
    // basis 为 0 时 wrap 会塌成「只有表头那么高」；而固定 height 又会让
    // 三个字节的短报文也占掉小半屏空白。两处配合才能做到「短则紧凑、长则滚动」。
    maxHeight: '44%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-1)'
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    padding: '8px 14px',
    borderBottom: '1px solid var(--border)'
  },
  title: { flexShrink: 0, fontSize: 'var(--fs-sm)', fontWeight: 600 },
  sub: {
    // 分屏后头部只有一半宽度，会话名必须能省略号截断，
    // 否则会把「重选 / 关闭」挤到第二行
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-2)',
    fontFamily: 'var(--font-mono)'
  },
  vs: { fontSize: 'var(--fs-micro)', color: 'var(--text-3)' },
  spacer: { flex: 1 },
  summary: { flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-1)', fontFamily: 'var(--font-mono)' },
  summaryOk: { flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--conn-ok)' },
  degraded: {
    fontSize: 'var(--fs-micro)',
    color: 'var(--conn-warn)',
    border: '1px solid var(--conn-warn)',
    borderRadius: 'var(--r-xs)',
    padding: '0 5px'
  },
  ghost: {
    flexShrink: 0,
    padding: '4px 9px',
    background: 'var(--btn2-bg)',
    color: 'var(--text-1)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-xs)'
  },
  legend: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    flexShrink: 0,
    padding: '5px 14px',
    borderBottom: '1px solid var(--border-subtle)'
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-2)'
  },
  legendSwatch: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', padding: '1px 3px' },
  body: {
    flex: '0 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: '8px 14px 12px'
  },
  rowGroup: {
    display: 'grid',
    gridTemplateColumns: '44px minmax(0, 1fr)',
    gridTemplateRows: 'auto auto',
    columnGap: 8,
    marginBottom: 8
  },
  offset: {
    gridRow: '1 / span 2',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-3)',
    paddingTop: 2
  },
  pair: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  line: { display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' },
  lineAscii: { display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)' },
  sideTag: { width: 12, flexShrink: 0, fontSize: 'var(--fs-micro)', color: 'var(--text-3)' },
  cellSame: { minWidth: 20, textAlign: 'center', color: 'var(--text-2)' },
  // 差异格：加深底色 + 提亮字色 + 加粗，三个通道同时用，避免只靠底色在浅色主题下不明显
  cellDiff: {
    minWidth: 20,
    textAlign: 'center',
    color: 'var(--text-0)',
    fontWeight: 700,
    background: 'var(--selected-strong-bg)',
    borderRadius: 'var(--r-xs)'
  },
  cellOnly: {
    minWidth: 20,
    textAlign: 'center',
    color: 'var(--text-0)',
    background: 'var(--selected-bg)',
    borderRadius: 'var(--r-xs)',
    textDecoration: 'underline'
  },
  cellAbsent: { minWidth: 20, textAlign: 'center', color: 'var(--text-3)' },
  asciiCell: { minWidth: 20, fontWeight: 400 },
  tabs: { display: 'flex', gap: 2, marginRight: 6, background: 'var(--bg-inset)', padding: 2, borderRadius: 'var(--r-sm)' },
  tab: {
    padding: '2px 9px',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-micro)'
  },
  tabOn: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  hintText: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', padding: '10px 0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)' },
  th: { textAlign: 'left', padding: '3px 6px', color: 'var(--text-2)', fontWeight: 500, borderBottom: '1px solid var(--border)' },
  td: { padding: '3px 6px', verticalAlign: 'top', color: 'var(--text-1)' },
  tdDiff: { background: 'var(--selected-strong-bg)', color: 'var(--text-0)', fontWeight: 700 }
}
