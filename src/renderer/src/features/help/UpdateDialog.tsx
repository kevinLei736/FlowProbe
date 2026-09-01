import { useEffect, useState } from 'react'
import type { UpdatePhase, UpdateSettings, UpdateState } from '@shared/protocol'
import { btnGhost, btnPrimary, btnSecondary, checkRow, overlay, surface } from '../../components/ui/tokens'

/**
 * 应用更新面板。
 *
 * 界面只反映主进程给的一个 phase，不在渲染层自己推状态：更新是跨进程的长流程
 * （检查 → 下载 → 重启安装），两边各存一份状态迟早对不上，而对不上的表现是
 * 「按钮该亮的时候是灰的」这类无法自证的问题。
 *
 * 这里没有任何地址输入框。更新地址由打包时决定、随安装包固定下来 ——
 * 让每个使用者自己填服务器地址与下载代理，等于把发布方该做一次的决定
 * 摊给所有人，而填错的表现都是同一个 404，用户无从自查。
 * 面板因此只保留两个由用户决定的开关：要不要自动查、要不要自动下。
 */

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '尚未检查',
  unconfigured: '暂不可用',
  checking: '正在检查…',
  available: '有新版本',
  downloading: '正在下载…',
  downloaded: '已下载，等待重启',
  'up-to-date': '已是最新版本',
  error: '检查失败'
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]
}

export function UpdateDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [cfg, setCfg] = useState<UpdateSettings | null>(null)

  useEffect(() => {
    void window.toolbox.updateGetState().then(setState)
    void window.toolbox.updateSettingsGet().then(setCfg)
    // 状态由主进程推送。下载进度每秒多次，轮询要么迟钝要么白烧 IPC
    return window.toolbox.onUpdateState(setState)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patchCfg = async (p: Partial<UpdateSettings>): Promise<void> => {
    setCfg(await window.toolbox.updateSettingsSet(p))
  }

  const phase = state?.phase ?? 'idle'
  const busy = phase === 'checking' || phase === 'downloading'

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={{ ...surface, ...st.card }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={st.head}>
          <span style={st.title}>检查更新</span>
          <span style={st.phase}>{PHASE_TEXT[phase]}</span>
          <span style={{ flex: 1 }} />
          <button style={st.close} title='关闭' onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={st.rows}>
          <Row k='当前版本' v={state ? 'v' + state.currentVersion : '…'} />
          {state?.newVersion && phase !== 'up-to-date' && <Row k='新版本' v={'v' + state.newVersion} strong />}
          {state?.checkedAt && <Row
            k='上次检查'
            v={new Date(state.checkedAt).toLocaleString()}
          />}
        </div>

        {phase === 'downloading' && (
          <div style={st.progWrap}>
            <div style={st.progBar}>
              <div style={{ ...st.progFill, width: (state?.percent ?? 0) + '%' }} />
            </div>
            <div style={st.progText}>
              {(state?.percent ?? 0) + '%'} · {fmtBytes(state?.transferred)} / {fmtBytes(state?.total)}
              {state?.bytesPerSecond ? ' · ' + fmtBytes(state.bytesPerSecond) + '/s' : ''}
            </div>
          </div>
        )}

        {state?.releaseNotes && (phase === 'available' || phase === 'downloaded') && (
          <div style={st.notes}>
            <div style={st.notesTitle}>更新说明</div>
            {/* 发布说明可能是 HTML，这里当纯文本渲染：外部内容不该有机会往界面里插标签 */}
            <div style={st.notesBody}>{state.releaseNotes}</div>
          </div>
        )}

        {phase === 'error' && state?.error && <div style={st.err}>{state.error}</div>}
        {phase === 'unconfigured' && <div style={st.hint}>{state?.error ?? '更新暂不可用'}</div>}

        <div style={st.settings}>
          <label style={checkRow}>
            <input
              type='checkbox'
              checked={cfg?.autoCheck ?? true}
              onChange={(e) => void patchCfg({ autoCheck: e.target.checked })}
            />
            启动后自动检查一次
          </label>
          <label style={checkRow}>
            <input
              type='checkbox'
              checked={cfg?.autoDownload ?? false}
              onChange={(e) => void patchCfg({ autoDownload: e.target.checked })}
            />
            发现新版本后自动下载（安装仍需你确认）
          </label>
        </div>

        <div style={st.foot}>
          <span style={{ flex: 1 }} />
          {phase !== 'downloaded' && (
            <button style={btnSecondary} disabled={busy} onClick={() => void window.toolbox.updateCheck()}>
              {phase === 'checking' ? '检查中…' : '检查更新'}
            </button>
          )}
          {phase === 'available' && (
            <button style={btnPrimary} onClick={() => void window.toolbox.updateDownload()}>
              下载新版本
            </button>
          )}
          {phase === 'downloaded' && <InstallButton />}
        </div>

        {phase === 'downloaded' && (
          <div style={st.warn}>
            重启会断开所有正在运行的连接与监听端口。有正在跑的会话时，建议先停掉再安装。
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 安装按钮单独抽出来只为一件事：点下之后要立刻变成不可再点的「正在重启…」。
 * 重启前进程还活着，按钮若保持可点，连点两下会触发两次安装流程。
 */
function InstallButton(): JSX.Element {
  const [installing, setInstalling] = useState(false)
  return (
    <button
      style={btnPrimary}
      disabled={installing}
      onClick={() => {
        setInstalling(true)
        void window.toolbox.updateInstall()
      }}
    >
      {installing ? '正在重启…' : '重启并安装'}
    </button>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }): JSX.Element {
  return (
    <div style={st.row}>
      <span style={st.k}>{k}</span>
      <span style={{ ...st.v, ...(strong ? { color: 'var(--text-0)', fontWeight: 600 } : {}) }}>{v}</span>
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  card: { width: 480, maxWidth: '92vw', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 },
  head: { display: 'flex', alignItems: 'center', gap: 10 },
  title: { fontSize: 'var(--fs-lg)', fontWeight: 600 },
  phase: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  close: { ...btnGhost, width: 28, padding: 0, fontSize: 'var(--fs-lg)' },
  rows: { display: 'flex', flexDirection: 'column', gap: 7 },
  row: { display: 'flex', gap: 14, alignItems: 'baseline' },
  k: { width: 66, flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  v: { flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-1)', wordBreak: 'break-all' },
  progWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
  progBar: {
    height: 6,
    background: 'var(--bg-inset)',
    borderRadius: 'var(--r-pill)',
    overflow: 'hidden'
  },
  // 进度条用中性色而不是强调色：它是过程指示，不是需要人立刻反应的信号
  progFill: { height: '100%', background: 'var(--text-2)', transition: 'width var(--dur) var(--ease)' },
  progText: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  notes: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 12px',
    background: 'var(--bg-inset)',
    borderRadius: 'var(--r-md)'
  },
  notesTitle: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  notesBody: {
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-1)',
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    maxHeight: 160,
    overflowY: 'auto'
  },
  err: {
    padding: '9px 12px',
    background: 'color-mix(in srgb, var(--error) 12%, transparent)',
    border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)',
    borderRadius: 'var(--r-md)',
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-0)',
    lineHeight: 1.65
  },
  hint: {
    padding: '9px 12px',
    background: 'var(--bg-inset)',
    borderRadius: 'var(--r-md)',
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-1)',
    lineHeight: 1.65
  },
  settings: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingTop: 12,
    borderTop: '1px solid var(--border-subtle)'
  },
  foot: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 },
  warn: {
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-2)',
    lineHeight: 1.65
  }
}
