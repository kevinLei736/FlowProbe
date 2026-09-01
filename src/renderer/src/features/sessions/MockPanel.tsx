import { useState } from 'react'
import type {
  Encoding,
  MatchType,
  MockConfig,
  MockRule,
  ResponseType,
  Session
} from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { KIND_CAPS, KIND_META } from '../../app/meta'
import { Select } from '../../components/ui/Select'
import { ResizableTextarea } from '../../components/ui/ResizableTextarea'

function emptyRule(): MockRule {
  return {
    id: Math.random().toString(36).slice(2),
    name: '新规则',
    enabled: true,
    matchType: 'contains',
    matchEncoding: 'utf8',
    pattern: '',
    responseType: 'static',
    responseEncoding: 'utf8',
    responseBody: '',
    delayMs: 0,
    appendTerminator: ''
  }
}

function defaultConfig(): MockConfig {
  return {
    enabled: false,
    rules: [],
    fault: { enabled: false, dropRate: 0, extraDelayMs: 0 },
    fallthrough: false
  }
}

export function MockPanel({ session, onClose }: { session: Session; onClose: () => void }): JSX.Element {
  const updateMock = useStore((s) => s.updateMock)
  const initial = (session.config.mock as MockConfig) ?? defaultConfig()
  // 结束符只对以换行分帧的流式协议成立，WebSocket 自带消息边界，露出来只会误导
  const caps = KIND_CAPS[session.kind]
  const [cfg, setCfg] = useState<MockConfig>(initial)

  const commit = (next: MockConfig): void => {
    setCfg(next)
    updateMock(session.id, next)
  }

  const patchRule = (id: string, patch: Partial<MockRule>): void => {
    commit({ ...cfg, rules: cfg.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>报文规则应答 · {session.name}</span>
          {/* 明确它是「按裸报文匹配」的模拟，跟 HTTP Mock 服务是两回事 */}
          <span style={styles.sub}>{KIND_META[session.kind].label} · 按收到的报文匹配并自动回包</span>
          <button style={styles.close} onClick={onClose}>✕</button>
        </div>

        <div style={styles.topRow}>
          <label style={styles.switch}>
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => commit({ ...cfg, enabled: e.target.checked })}
            />
            启用 Mock
          </label>
          <label style={styles.switch}>
            <input
              type="checkbox"
              checked={cfg.fallthrough}
              onChange={(e) => commit({ ...cfg, fallthrough: e.target.checked })}
            />
            未命中时透传（不拦截）
          </label>
          <span style={styles.spacer} />
          <button style={styles.addBtn} onClick={() => commit({ ...cfg, rules: [...cfg.rules, emptyRule()] })}>
            + 添加规则
          </button>
        </div>

        <div style={styles.fault}>
          <label style={styles.switch}>
            <input
              type="checkbox"
              checked={cfg.fault.enabled}
              onChange={(e) => commit({ ...cfg, fault: { ...cfg.fault, enabled: e.target.checked } })}
            />
            故障注入
          </label>
          {cfg.fault.enabled && (
            <>
              <span style={styles.faultLabel}>丢包率</span>
              <input
                style={styles.faultInput}
                value={String(cfg.fault.dropRate)}
                onChange={(e) => commit({ ...cfg, fault: { ...cfg.fault, dropRate: Number(e.target.value) || 0 } })}
                placeholder="0~1"
              />
              <span style={styles.faultLabel}>额外延迟(ms)</span>
              <input
                style={styles.faultInput}
                value={String(cfg.fault.extraDelayMs)}
                onChange={(e) => commit({ ...cfg, fault: { ...cfg.fault, extraDelayMs: Number(e.target.value) || 0 } })}
              />
            </>
          )}
        </div>

        <div style={styles.rules}>
          {cfg.rules.length === 0 && <div style={styles.empty}>暂无规则，点击「添加规则」创建自动应答</div>}
          {cfg.rules.map((r) => (
            <div key={r.id} style={styles.rule}>
              <div style={styles.ruleHead}>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => patchRule(r.id, { enabled: e.target.checked })}
                />
                <input
                  style={styles.ruleName}
                  value={r.name}
                  onChange={(e) => patchRule(r.id, { name: e.target.value })}
                />
                <span style={styles.spacer} />
                <button style={styles.del} onClick={() => commit({ ...cfg, rules: cfg.rules.filter((x) => x.id !== r.id) })}>
                  删除
                </button>
              </div>

              <div style={styles.grid}>
                <Field label="匹配方式">
                  <Select
  value={r.matchType}
  onChange={(v) => patchRule(r.id, { matchType: v as MatchType })}
  style={styles.input}
  options={[{ value: "any", label: "任意" }, { value: "contains", label: "包含" }, { value: "equals", label: "完全等于" }, { value: "startsWith", label: "前缀" }, { value: "regex", label: "正则" }, { value: "hex", label: "HEX包含" }]}
/>
                </Field>
                <Field label="匹配编码">
                  <Select
  value={r.matchEncoding}
  onChange={(v) => patchRule(r.id, { matchEncoding: v as Encoding })}
  style={styles.input}
  options={[{ value: "utf8", label: "TEXT" }, { value: "hex", label: "HEX" }]}
/>
                </Field>
                <Field label="延迟(ms)">
                  <input style={styles.input} value={String(r.delayMs)} onChange={(e) => patchRule(r.id, { delayMs: Number(e.target.value) || 0 })} />
                </Field>
              </div>

              {r.matchType !== 'any' && (
                <Field label="匹配内容">
                  <input style={styles.input} value={r.pattern} onChange={(e) => patchRule(r.id, { pattern: e.target.value })} placeholder={r.matchEncoding === 'hex' ? 'AA 01' : '关键字 / 正则'} />
                </Field>
              )}

              <div style={styles.grid}>
                <Field label="应答类型">
                  <Select
  value={r.responseType}
  onChange={(v) => patchRule(r.id, { responseType: v as ResponseType })}
  style={styles.input}
  options={[{ value: "static", label: "静态" }, { value: "template", label: "模板" }, { value: "script", label: "脚本" }]}
/>
                </Field>
                <Field label="应答编码">
                  <Select
  value={r.responseEncoding}
  onChange={(v) => patchRule(r.id, { responseEncoding: v as Encoding })}
  style={styles.input}
  options={[{ value: "utf8", label: "TEXT" }, { value: "hex", label: "HEX" }, { value: "base64", label: "B64" }]}
/>
                </Field>
                {caps.terminator && (
                <Field label="结束符">
                  <Select
  value={r.appendTerminator ?? ''}
  onChange={(v) => patchRule(r.id, { appendTerminator: v as MockRule['appendTerminator'] })}
  style={styles.input}
  options={[{ value: "", label: "无" }, { value: "cr", label: "CR" }, { value: "lf", label: "LF" }, { value: "crlf", label: "CRLF" }]}
/>
                </Field>
                )}
              </div>

              <Field label={responseHint(r.responseType)}>
                <ResizableTextarea
                  value={r.responseBody}
                  onChange={(v) => patchRule(r.id, { responseBody: v })}
                  min={56}
                  max={360}
                  placeholder={responsePlaceholder(r.responseType)}
                />
              </Field>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function responseHint(t: ResponseType): string {
  if (t === 'template') return '应答模板（支持 {{echo}} {{seq}} {{ts}} {{now}} {{rand}} {{len}} {{echoHex}}）'
  if (t === 'script') return '应答脚本（JS，变量 data/text/hex，返回值或赋给 result）'
  return '应答内容'
}

function responsePlaceholder(t: ResponseType): string {
  if (t === 'template') return '收到:{{echo}} 序号:{{seq}}'
  if (t === 'script') return "return 'ACK:' + text.trim()"
  return 'OK'
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 60 },
  panel: {
    width: 640,
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden'
  },
  header: { display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontWeight: 600 },
  sub: { marginLeft: 10, fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  close: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 'var(--fs-lg)' },
  topRow: { display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px', borderBottom: '1px solid var(--border)' },
  switch: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  spacer: { flex: 1 },
  addBtn: { padding: '6px 12px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  fault: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: '1px solid var(--border)' },
  faultLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  faultInput: { width: 70, padding: '4px 8px', background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)' },
  rules: { overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  empty: { color: 'var(--text-2)', textAlign: 'center', padding: 24, fontSize: 'var(--fs-sm)' },
  rule: { border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: 12, background: 'var(--bg-0)' },
  ruleHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  ruleName: { flex: 'none', width: 180, padding: '4px 8px', background: 'var(--bg-2)', color: 'var(--text-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-md)' },
  del: { padding: '3px 10px', background: 'transparent', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 6 },
  field: { display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 },
  fieldLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  input: { padding: '6px 8px', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)', outline: 'none' },
  textarea: { minHeight: 60, resize: 'vertical', padding: '6px 8px', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', outline: 'none' }
}
