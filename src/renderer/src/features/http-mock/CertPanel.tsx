import { useEffect, useMemo, useState } from 'react'
import type { Session, TlsCertInfo } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { ResizableTextarea } from '../../components/ui/ResizableTextarea'
import { Select } from '../../components/ui/Select'

/**
 * 证书面板。
 *
 * 补的是一个已经暴露给用户的死路：新建 HTTP Mock 时勾「启用 HTTPS」的说明写着
 * 「需在设置中提供证书」，但那个设置入口从来没有存在过——勾了之后服务起不来，
 * 而错误信息是 OpenSSL 抛出的英文底层报错，几乎无法自查。
 *
 * 这里给三条路：一键生成自签证书（绝大多数本地调试的答案）、导入现成证书对、
 * 直接粘贴 PEM 正文（从密钥管理系统里拷出来的场景）。
 */
export function CertPanel({
  session,
  onClose
}: {
  session: Session
  onClose: () => void
}): JSX.Element {
  const updateSessionConfig = useStore((s) => s.updateSessionConfig)
  const c = session.config

  const [httpsOn, setHttpsOn] = useState(c.https === true)
  const [certPem, setCertPem] = useState(String(c.tlsCert ?? ''))
  const [keyPem, setKeyPem] = useState(String(c.tlsKey ?? ''))
  const [certPath, setCertPath] = useState(String(c.tlsCertPath ?? ''))
  const [keyPath, setKeyPath] = useState(String(c.tlsKeyPath ?? ''))
  const [info, setInfo] = useState<TlsCertInfo | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [certH, setCertH] = useState(120)
  const [keyH, setKeyH] = useState(96)

  // 生成参数
  const [hosts, setHosts] = useState('localhost, 127.0.0.1')
  const [days, setDays] = useState('825')

  const running = session.status === 'listening'

  /**
   * 证书体检交给主进程。
   *
   * 渲染层没有 node:crypto，要在这里解析 X.509 就得引一个纯 JS ASN.1 库；
   * 而主进程为了「起服务前拦住坏证书」本来就需要这段逻辑，复用它更划算。
   */
  useEffect(() => {
    if (!certPem.trim()) {
      setInfo(null)
      return
    }
    let alive = true
    window.toolbox.tlsInspect(certPem, keyPem).then((r) => {
      if (alive) setInfo(r)
    })
    return () => {
      alive = false
    }
  }, [certPem, keyPem])

  const save = (patch: Record<string, unknown>): void => {
    updateSessionConfig(session.id, { ...session.config, ...patch })
  }

  const generate = async (): Promise<void> => {
    setBusy('gen')
    setMsg('')
    try {
      const list = hosts
        .split(/[,\n;]/)
        .map((x) => x.trim())
        .filter(Boolean)
      const m = await window.toolbox.tlsGenerate({
        hosts: list,
        days: Number(days) || 825,
        name: session.name
      })
      setCertPem(m.certPem)
      setKeyPem(m.keyPem)
      setCertPath(m.certPath)
      setKeyPath(m.keyPath)
      setInfo(m.info)
      save({
        https: true,
        tlsCert: m.certPem,
        tlsKey: m.keyPem,
        tlsCertPath: m.certPath,
        tlsKeyPath: m.keyPath
      })
      setHttpsOn(true)
      setMsg('已生成并保存到证书目录' + (running ? '。重启服务后生效。' : ''))
    } catch (e) {
      setMsg('生成失败：' + (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const importPair = async (): Promise<void> => {
    setBusy('imp')
    setMsg('')
    try {
      const m = await window.toolbox.tlsImport()
      if (!m) {
        setMsg('已取消')
        return
      }
      setCertPem(m.certPem)
      setKeyPem(m.keyPem)
      setCertPath(m.certPath)
      setKeyPath(m.keyPath)
      setInfo(m.info)
      if (m.info.ok) {
        save({
          https: true,
          tlsCert: m.certPem,
          tlsKey: m.keyPem,
          tlsCertPath: m.certPath,
          tlsKeyPath: m.keyPath
        })
        setHttpsOn(true)
        setMsg('已导入' + (running ? '。重启服务后生效。' : ''))
      } else {
        // 校验不过就不写进会话配置：写了等于把一个必定起不来的配置存下来
        setMsg('导入的证书未通过校验，未保存到会话')
      }
    } finally {
      setBusy('')
    }
  }

  const applyPasted = (): void => {
    if (!info?.ok) {
      setMsg('证书未通过校验，无法应用')
      return
    }
    save({ https: true, tlsCert: certPem, tlsKey: keyPem, tlsCertPath: '', tlsKeyPath: '' })
    setCertPath('')
    setKeyPath('')
    setHttpsOn(true)
    setMsg('已应用粘贴的证书' + (running ? '。重启服务后生效。' : ''))
  }

  const clearCert = (): void => {
    setCertPem('')
    setKeyPem('')
    setCertPath('')
    setKeyPath('')
    setInfo(null)
    save({ https: false, tlsCert: '', tlsKey: '', tlsCertPath: '', tlsKeyPath: '' })
    setHttpsOn(false)
    setMsg('已清除证书并切回 HTTP')
  }

  const toggleHttps = (on: boolean): void => {
    setHttpsOn(on)
    // 关 HTTPS 时保留证书正文：用户往往只是临时切回 HTTP 对比行为，删掉等于让他重来一遍
    save({ https: on })
    setMsg(on ? '已切到 HTTPS' + (running ? '，重启服务后生效' : '') : '已切回 HTTP')
  }

  const openDir = async (): Promise<void> => {
    await window.toolbox.tlsCertsDir()
    await window.toolbox.revealPath('userData')
  }

  const exportCert = async (): Promise<void> => {
    if (!certPem.trim()) return
    const name = (session.name || 'mock').replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '_')
    const saved = await window.toolbox.saveTextFile(name + '.crt', certPem)
    if (saved) setMsg('证书已导出：' + saved)
  }

  const daysTag = useMemo(() => {
    if (!info || typeof info.daysLeft !== 'number') return null
    if (info.daysLeft < 0) return { text: '已过期', color: 'var(--error)' }
    if (info.daysLeft <= 14) return { text: info.daysLeft + ' 天后过期', color: 'var(--warn)' }
    return { text: '剩余 ' + info.daysLeft + ' 天', color: 'var(--text-2)' }
  }, [info])

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.panel} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <span style={st.title}>HTTPS 证书 · {session.name}</span>
          <span style={st.hint}>本地调试用自签证书即可</span>
          <button style={st.close} onClick={onClose}>✕</button>
        </div>

        <div style={st.tip}>
          <span>
            HTTPS Mock 需要一张服务器证书。本地联调点「生成自签证书」就够用；浏览器会提示「不安全」，
            把证书导入系统信任库即可消除（自签证书已带 CA 标记，导入后浏览器才会认）。
          </span>
        </div>

        <div style={st.opts}>
          <label style={st.check}>
            <input type="checkbox" checked={httpsOn} onChange={(e) => toggleHttps(e.target.checked)} />
            启用 HTTPS
          </label>
          <span style={st.gap} />
          {running && <span style={st.warnTag}>服务正在运行，改动需重启后生效</span>}
        </div>

        <div style={st.body}>
          <section style={st.card}>
            <div style={st.cardTitle}>生成自签证书</div>
            <div style={st.row}>
              <div style={st.col}>
                <label style={st.label}>主机名与 IP（逗号分隔，会写入 SAN）</label>
                <input style={st.input} value={hosts} onChange={(e) => setHosts(e.target.value)} />
              </div>
              <div style={{ ...st.col, maxWidth: 150 }}>
                <label style={st.label}>有效期</label>
                <Select
                  size="sm"
                  value={days}
                  onChange={setDays}
                  options={[
                    { value: '90', label: '90 天' },
                    { value: '365', label: '1 年' },
                    { value: '825', label: '825 天（推荐）' },
                    { value: '3650', label: '10 年' }
                  ]}
                />
              </div>
            </div>
            <div style={st.note}>
              825 天是 Chrome / Safari 对服务器证书接受的上限档位，填更长反而会被判为无效。
            </div>
            <div style={st.actions}>
              <button style={st.primary} disabled={busy === 'gen'} onClick={generate}>
                {busy === 'gen' ? '生成中…' : '生成自签证书'}
              </button>
              <button style={st.secondary} disabled={busy === 'imp'} onClick={importPair}>
                导入证书文件…
              </button>
            </div>
          </section>

          {info && (
            <section style={{ ...st.card, borderColor: info.ok ? 'var(--border)' : 'var(--error)' }}>
              <div style={st.cardTitle}>
                当前证书
                <span style={{ ...st.stateTag, color: info.ok ? 'var(--text-1)' : 'var(--error)' }}>
                  {info.ok ? '可用' : info.error}
                </span>
              </div>
              <InfoRow k="主题" v={info.subject ?? '-'} />
              <InfoRow k="签发者" v={(info.issuer ?? '-') + (info.selfSigned ? '（自签）' : '')} />
              <InfoRow
                k="有效期"
                v={
                  (info.validFrom ? new Date(info.validFrom).toLocaleDateString() : '?') +
                  ' → ' +
                  (info.validTo ? new Date(info.validTo).toLocaleDateString() : '?')
                }
                tag={daysTag}
              />
              <InfoRow k="适用域名" v={(info.altNames ?? []).join('、') || '未声明 SAN'} />
              <InfoRow
                k="私钥匹配"
                v={info.keyMatch === undefined ? '未提供私钥' : info.keyMatch ? '匹配' : '不匹配'}
                tag={info.keyMatch === false ? { text: '必须修正', color: 'var(--error)' } : null}
              />
              <InfoRow k="指纹" v={info.fingerprint256 ?? '-'} mono />
              {certPath && <InfoRow k="证书文件" v={certPath} mono />}
              {keyPath && <InfoRow k="私钥文件" v={keyPath} mono />}
              <div style={st.actions}>
                <button style={st.secondary} onClick={exportCert}>导出证书…</button>
                <button style={st.secondary} onClick={openDir}>打开数据目录</button>
                <span style={st.gap} />
                <button style={st.danger} onClick={clearCert}>清除证书</button>
              </div>
            </section>
          )}

          <section style={st.card}>
            <div style={st.cardTitle}>粘贴 PEM 正文</div>
            <label style={st.label}>证书（-----BEGIN CERTIFICATE-----）</label>
            <ResizableTextarea
              value={certPem}
              onChange={setCertPem}
              height={certH}
              onHeightChange={setCertH}
              min={80}
              max={320}
              placeholder="-----BEGIN CERTIFICATE-----"
            />
            <label style={st.label}>私钥（-----BEGIN PRIVATE KEY-----）</label>
            <ResizableTextarea
              value={keyPem}
              onChange={setKeyPem}
              height={keyH}
              onHeightChange={setKeyH}
              min={80}
              max={320}
              placeholder="-----BEGIN PRIVATE KEY-----"
            />
            <div style={st.actions}>
              <button style={st.primary} disabled={!info?.ok} onClick={applyPasted}>
                应用到会话
              </button>
              <span style={st.note}>校验通过后才能应用，避免存下一个必定起不来的配置</span>
            </div>
          </section>
        </div>

        <div style={st.footer}>
          <span style={st.msg}>{msg}</span>
          <button style={st.secondary} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

function InfoRow({
  k,
  v,
  mono,
  tag
}: {
  k: string
  v: string
  mono?: boolean
  tag?: { text: string; color: string } | null
}): JSX.Element {
  return (
    <div style={st.infoRow}>
      <span style={st.infoK}>{k}</span>
      <span style={{ ...st.infoV, ...(mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' } : {}) }}>
        {v}
      </span>
      {tag && <span style={{ ...st.infoTag, color: tag.color }}>{tag.text}</span>}
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
    zIndex: 55
  },
  panel: {
    width: 720,
    maxWidth: '94vw',
    height: 640,
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden'
  },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontWeight: 600 },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  close: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 16 },
  tip: {
    padding: '9px 16px',
    background: 'var(--bg-2)',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-1)',
    lineHeight: 'var(--lh-normal)'
  },
  opts: { display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: '1px solid var(--border-subtle)' },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  warnTag: { fontSize: 'var(--fs-xs)', color: 'var(--warn)' },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  card: { border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 },
  cardTitle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 2 },
  stateTag: { fontSize: 'var(--fs-xs)', fontWeight: 400 },
  row: { display: 'flex', gap: 10, alignItems: 'flex-end' },
  col: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  label: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', marginTop: 4 },
  input: {
    height: 'var(--control-h)',
    padding: '0 var(--control-px)',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    outline: 'none'
  },
  note: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', lineHeight: 'var(--lh-normal)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  primary: { height: 'var(--control-h)', padding: '0 14px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)' },
  secondary: { height: 'var(--control-h)', padding: '0 12px', background: 'var(--btn2-bg)', color: 'var(--text-0)', border: '1px solid transparent', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)' },
  danger: { height: 'var(--control-h)', padding: '0 12px', background: 'transparent', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)' },
  gap: { flex: 1 },
  infoRow: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--fs-sm)' },
  infoK: { width: 76, flexShrink: 0, color: 'var(--text-2)', fontSize: 'var(--fs-xs)' },
  infoV: { flex: 1, color: 'var(--text-0)', wordBreak: 'break-all', lineHeight: 'var(--lh-normal)' },
  infoTag: { fontSize: 'var(--fs-xs)', flexShrink: 0 },
  footer: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--border)' },
  msg: { flex: 1, fontSize: 'var(--fs-xs)', color: 'var(--text-1)' }
}
