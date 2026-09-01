import { useState } from 'react'
import { ResizableTextarea } from '../../components/ui/ResizableTextarea'
import { computeChecksums, convertAll, timestampInfo } from './codec'

type Tab = 'checksum' | 'convert' | 'time'

export function ToolsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('checksum')

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>编解码 / 校验工具</span>
          <button style={styles.close} onClick={onClose}>✕</button>
        </div>
        <div style={styles.tabs}>
          <Tab id="checksum" cur={tab} set={setTab} label="校验和" />
          <Tab id="convert" cur={tab} set={setTab} label="进制转换" />
          <Tab id="time" cur={tab} set={setTab} label="时间戳" />
        </div>
        <div style={styles.body}>
          {tab === 'checksum' && <ChecksumTool />}
          {tab === 'convert' && <ConvertTool />}
          {tab === 'time' && <TimeTool />}
        </div>
      </div>
    </div>
  )
}

function Tab({ id, cur, set, label }: { id: Tab; cur: Tab; set: (t: Tab) => void; label: string }): JSX.Element {
  return (
    <button style={{ ...styles.tab, ...(id === cur ? styles.tabActive : {}) }} onClick={() => set(id)}>
      {label}
    </button>
  )
}

function ChecksumTool(): JSX.Element {
  const [input, setInput] = useState('AA 01 02 03')
  const [mode, setMode] = useState<'text' | 'hex'>('hex')
  const rows = computeChecksums(input, mode)
  return (
    <>
      <div style={styles.segRow}>
        <ModeSeg mode={mode} set={setMode} options={[['hex', 'HEX'], ['text', 'TEXT']]} />
      </div>
      <ResizableTextarea value={input} onChange={setInput} min={64} max={320} />
      <div style={styles.table}>
        {rows.map((r) => (
          <div key={r.name} style={styles.trow}>
            <span style={styles.tk}>{r.name}</span>
            <span style={styles.tv}>{r.value}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function ConvertTool(): JSX.Element {
  const [input, setInput] = useState('Hello')
  const [mode, setMode] = useState<'text' | 'hex' | 'base64'>('text')
  const r = convertAll(input, mode)
  return (
    <>
      <div style={styles.segRow}>
        <ModeSeg mode={mode} set={setMode} options={[['text', 'TEXT'], ['hex', 'HEX'], ['base64', 'B64']]} />
      </div>
      <ResizableTextarea value={input} onChange={setInput} min={64} max={320} />
      <div style={styles.table}>
        <Out k="字节数" v={String(r.bytes)} />
        <Out k="HEX" v={r.hex} />
        <Out k="TEXT" v={r.text} />
        <Out k="Base64" v={r.base64} />
        <Out k="十进制" v={r.decimal} />
      </div>
    </>
  )
}

function TimeTool(): JSX.Element {
  const [input, setInput] = useState(String(Date.now()))
  const r = timestampInfo(input)
  return (
    <>
      <div style={styles.segRow}>
        <button style={styles.miniBtn} onClick={() => setInput(String(Date.now()))}>当前毫秒</button>
        <button style={styles.miniBtn} onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>当前秒</button>
      </div>
      <ResizableTextarea value={input} onChange={setInput} min={44} max={200} />
      <div style={styles.table}>
        <Out k="Unix 秒" v={r.unixSec} />
        <Out k="Unix 毫秒" v={r.unixMs} />
        <Out k="ISO" v={r.iso} />
        <Out k="本地时间" v={r.local} />
      </div>
    </>
  )
}

function Out({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div style={styles.trow}>
      <span style={styles.tk}>{k}</span>
      <span style={styles.tv}>{v}</span>
    </div>
  )
}

function ModeSeg<T extends string>({
  mode,
  set,
  options
}: {
  mode: T
  set: (v: T) => void
  options: [T, string][]
}): JSX.Element {
  return (
    <div style={styles.seg}>
      {options.map(([v, label]) => (
        <button key={v} style={{ ...styles.segBtn, ...(v === mode ? styles.segActive : {}) }} onClick={() => set(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 60 },
  panel: { width: 460, maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontWeight: 600 },
  close: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 'var(--fs-lg)' },
  tabs: { display: 'flex', gap: 6, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' },
  tab: { padding: '6px 14px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  // 选中态用「浮起」而非主按钮色：tab 是导航不是提交动作，
  // 浅色下深底白字的 tab 会比页面里真正的确认按钮还醒目，层级就反了
  tabActive: { background: 'var(--bg-0)', color: 'var(--text-0)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', fontWeight: 500 },
  body: { padding: 16, overflowY: 'auto' },
  segRow: { display: 'flex', gap: 8, marginBottom: 8 },
  textarea: { width: '100%', height: 80, resize: 'vertical', padding: 10, background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', outline: 'none' },
  table: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 2 },
  trow: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 8px', background: 'var(--bg-0)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  tk: { color: 'var(--text-2)', flexShrink: 0 },
  tv: { color: 'var(--accent)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', textAlign: 'right' },
  seg: { display: 'flex', background: 'var(--bg-inset)', padding: 2, gap: 2, borderRadius: 'var(--r-sm)', overflow: 'hidden' },
  segBtn: { padding: '4px 12px', background: 'transparent', color: 'var(--text-2)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)' },
  segActive: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  miniBtn: { padding: '4px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' }
}
