import { useEffect, useState } from 'react'
import type { Session } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { Select } from '../../components/ui/Select'
import {
  btnPrimary,
  btnSecondary,
  checkRow,
  field,
  label as labelStyle,
  overlay,
  surface
} from '../../components/ui/tokens'

/**
 * HTTP Mock 监听设置。
 *
 * 端口以前只能在新建会话时填一次，建完就没有入口 —— 想换端口只能删掉重建，
 * 会话里的路由、场景、录制结果跟着一起没了。这里把「监听地址 / 端口 / 协议」
 * 单独做成一个面板：它属于链路参数，和「路由配置」是两件事，混在一起会让
 * 人以为改端口会影响路由。
 */
export function ListenPanel({
  session,
  onClose
}: {
  session: Session
  onClose: () => void
}): JSX.Element {
  const updateConfig = useStore((s) => s.updateSessionConfig)
  const currentHost = String(session.config.host ?? '0.0.0.0')
  const currentPort = String(session.config.port ?? 3000)
  const currentHttps = session.config.https === true

  const [host, setHost] = useState(currentHost)
  const [port, setPort] = useState(currentPort)
  const [https, setHttps] = useState(currentHttps)
  const [lanIps, setLanIps] = useState<string[]>([])

  useEffect(() => {
    void window.toolbox
      .appInfo()
      .then((info) => setLanIps(info.lanIps ?? []))
      .catch(() => setLanIps([]))
  }, [])

  const portNum = Number(port)
  const portOk = Number.isInteger(portNum) && portNum > 0 && portNum < 65536
  const dirty = host !== currentHost || port !== currentPort || https !== currentHttps
  const scheme = https ? 'https' : 'http'
  const certMissing =
    https && (!String(session.config.tlsCert ?? '').trim() || !String(session.config.tlsKey ?? '').trim())
  const openToLan = host === '0.0.0.0' || host === '::'

  const apply = (): void => {
    if (!portOk) return
    updateConfig(session.id, { host, port: portNum, https })
    onClose()
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>监听设置 · {session.name}</span>
          <button style={styles.close} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.fieldWrap}>
            <label style={labelStyle}>监听地址</label>
            <Select
              value={host}
              searchable={false}
              onChange={setHost}
              options={[
                { value: '0.0.0.0', label: '0.0.0.0（本机 + 局域网）' },
                { value: '127.0.0.1', label: '127.0.0.1（仅本机）' }
              ]}
            />
          </div>

          <div style={styles.fieldWrap}>
            <label style={labelStyle}>端口</label>
            <input
              style={{ ...field, fontFamily: 'var(--font-mono)' }}
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') apply()
              }}
            />
            {!portOk && <span style={styles.err}>端口需为 1–65535 的整数</span>}
          </div>

          <label style={checkRow}>
            <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} />
            启用 HTTPS
          </label>
          {https && (
            <div style={certMissing ? styles.warnBox : styles.hint}>
              {certMissing
                ? '当前没有可用证书，服务将无法启动。先在「证书」面板生成自签证书或导入。'
                : '证书已配置。换协议后需要重启服务，正在运行时会自动重启。'}
            </div>
          )}

          <div style={styles.section}>访问地址</div>
          <div style={styles.hint}>
            本机：<span style={styles.mono}>{`${scheme}://127.0.0.1:${portOk ? portNum : '端口'}`}</span>
          </div>
          {openToLan &&
            lanIps.map((ip) => (
              <div key={ip} style={styles.hint}>
                局域网：<span style={styles.mono}>{`${scheme}://${ip}:${portOk ? portNum : '端口'}`}</span>
              </div>
            ))}
          {openToLan && lanIps.length === 0 && (
            <div style={styles.hint}>未检测到局域网 IPv4 地址，确认已连上网络。</div>
          )}
          {openToLan && (
            <div style={styles.hint}>
              远程仍然打不开时，先检查系统防火墙是否放行该端口；Windows 首次监听会弹授权框，需要选「允许」。
            </div>
          )}
        </div>

        <div style={styles.footer}>
          {dirty && <span style={styles.dirty}>应用后会按新参数重启服务</span>}
          <span style={{ flex: 1 }} />
          <button style={btnSecondary} onClick={onClose}>
            取消
          </button>
          <button style={btnPrimary} disabled={!portOk || !dirty} onClick={apply}>
            应用
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    ...surface,
    width: 460,
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)'
  },
  title: { fontWeight: 600 },
  close: {
    marginLeft: 'auto',
    background: 'transparent',
    color: 'var(--text-1)',
    border: 'none',
    fontSize: 'var(--fs-lg)'
  },
  body: { padding: 16, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' },
  fieldWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  section: { marginTop: 8, fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-0)' },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', lineHeight: 1.7 },
  mono: { fontFamily: 'var(--font-mono)', color: 'var(--text-1)' },
  err: { fontSize: 'var(--fs-xs)', color: 'var(--error)' },
  warnBox: {
    fontSize: 'var(--fs-xs)',
    color: 'var(--error)',
    lineHeight: 1.7,
    padding: '6px 8px',
    border: '1px solid var(--error)',
    borderRadius: 'var(--r-sm)'
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid var(--border)'
  },
  dirty: { fontSize: 'var(--fs-xs)', color: 'var(--warn)' }
}
