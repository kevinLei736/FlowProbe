import { useMemo, useState } from 'react'
import type { MqttConfig, MqttSubscription, Session } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  checkRow,
  field,
  fieldSm,
  label as labelStyle,
  overlay,
  surface
} from '../../components/ui/tokens'
import { Select } from '../../components/ui/Select'

function newSub(): MqttSubscription {
  return {
    id: Math.random().toString(36).slice(2),
    filter: '',
    qos: 0,
    enabled: true
  }
}

/**
 * MQTT 订阅与连接参数面板。
 *
 * 订阅表和连接参数分开提交：改订阅走增量订阅/退订（不断线），
 * 改连接参数必须重建连接。把两者放在一个面板但用不同按钮，
 * 是为了让用户清楚哪些改动会打断链路。
 */
export function MqttPanel({
  session,
  onClose
}: {
  session: Session
  onClose: () => void
}): JSX.Element {
  const updateSubs = useStore((s) => s.updateMqttSubs)
  const updateConfig = useStore((s) => s.updateSessionConfig)
  const cfg = (session.config.mqtt ?? {}) as MqttConfig

  const [subs, setSubs] = useState<MqttSubscription[]>(cfg.subscriptions ?? [])
  const [draft, setDraft] = useState<MqttConfig>({ ...cfg })
  const isV5 = draft.protocolVersion === 5

  const dirtyConn = useMemo(
    () => JSON.stringify({ ...draft, subscriptions: [] }) !== JSON.stringify({ ...cfg, subscriptions: [] }),
    [draft, cfg]
  )

  const commitSubs = (next: MqttSubscription[]): void => {
    setSubs(next)
    updateSubs(session.id, next)
  }

  const patchSub = (id: string, patch: Partial<MqttSubscription>): void => {
    commitSubs(subs.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const applyConn = (): void => {
    updateConfig(session.id, { mqtt: { ...draft, subscriptions: subs } })
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>MQTT 设置 · {session.name}</span>
          <button style={styles.close} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.sectionTitle}>订阅</div>
          <div style={styles.hint}>
            主题过滤器支持 <code style={styles.code}>+</code> 单层通配与{' '}
            <code style={styles.code}>#</code> 多层通配。改动即时生效，只做增量订阅与退订，不会断开连接。
          </div>
          {subs.length === 0 && <div style={styles.empty}>暂无订阅，添加一条即可开始收消息</div>}
          {subs.map((s) => (
            <div key={s.id} style={styles.subRow}>
              <input
                type="checkbox"
                checked={s.enabled}
                title="启用该订阅"
                onChange={(e) => patchSub(s.id, { enabled: e.target.checked })}
              />
              <input
                style={{ ...fieldSm, flex: 1, fontFamily: 'var(--font-mono)' }}
                value={s.filter}
                placeholder="sensor/+/temperature"
                onChange={(e) => patchSub(s.id, { filter: e.target.value })}
              />
              <Select
                size="sm"
                style={{ width: 88 }}
                value={String(s.qos)}
                title="订阅 QoS"
                searchable={false}
                onChange={(v) => patchSub(s.id, { qos: Number(v) as 0 | 1 | 2 })}
                options={[
                  { value: '0', label: 'QoS 0' },
                  { value: '1', label: 'QoS 1' },
                  { value: '2', label: 'QoS 2' }
                ]}
              />
              {isV5 && (
                <label style={{ ...checkRow, fontSize: 'var(--fs-xs)' }} title="No Local：不接收自己发布的消息">
                  <input
                    type="checkbox"
                    checked={Boolean(s.noLocal)}
                    onChange={(e) => patchSub(s.id, { noLocal: e.target.checked })}
                  />
                  NL
                </label>
              )}
              <button
                style={styles.iconDel}
                title="删除订阅"
                onClick={() => commitSubs(subs.filter((x) => x.id !== s.id))}
              >
                ✕
              </button>
            </div>
          ))}
          <button style={{ ...btnSecondary, alignSelf: 'flex-start' }} onClick={() => commitSubs([...subs, newSub()])}>
            + 添加订阅
          </button>

          <div style={{ ...styles.sectionTitle, marginTop: 18 }}>连接参数</div>
          <div style={styles.hint}>以下参数只在建立连接时生效，修改后需要「应用并重连」。</div>

          <Field label="Broker 地址">
            <input
              style={{ ...field, fontFamily: 'var(--font-mono)' }}
              value={draft.url ?? ''}
              placeholder="mqtt://127.0.0.1:1883"
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </Field>

          <div style={styles.grid3}>
            <Field label="协议版本">
              <Select
                style={{ width: '100%' }}
                value={String(draft.protocolVersion ?? 4)}
                searchable={false}
                onChange={(v) => setDraft({ ...draft, protocolVersion: Number(v) as 4 | 5 })}
                options={[
                  { value: '4', label: 'MQTT 3.1.1' },
                  { value: '5', label: 'MQTT 5.0' }
                ]}
              />
            </Field>
            <Field label="Keep-Alive(秒)">
              <input
                style={field}
                value={String(draft.keepalive ?? 60)}
                onChange={(e) => setDraft({ ...draft, keepalive: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="连接超时(ms)">
              <input
                style={field}
                value={String(draft.connectTimeoutMs ?? 10000)}
                onChange={(e) =>
                  setDraft({ ...draft, connectTimeoutMs: Number(e.target.value) || 10000 })
                }
              />
            </Field>
          </div>

          <Field label="Client ID">
            <input
              style={{ ...field, fontFamily: 'var(--font-mono)' }}
              value={draft.clientId ?? ''}
              onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
            />
          </Field>

          <div style={styles.grid2}>
            <Field label="用户名">
              <input
                style={field}
                value={draft.username ?? ''}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              />
            </Field>
            <Field label="密码">
              <input
                style={field}
                type="password"
                value={draft.password ?? ''}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              />
            </Field>
          </div>

          <label style={{ ...checkRow, marginTop: 4 }}>
            <input
              type="checkbox"
              checked={draft.cleanStart !== false}
              onChange={(e) => setDraft({ ...draft, cleanStart: e.target.checked })}
            />
            {isV5 ? 'Clean Start（不恢复已有会话）' : 'Clean Session（不恢复已有会话）'}
          </label>
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={draft.rejectUnauthorized !== false}
              onChange={(e) => setDraft({ ...draft, rejectUnauthorized: e.target.checked })}
            />
            校验服务端证书（仅 mqtts / wss 生效）
          </label>

          <div style={{ ...styles.sectionTitle, marginTop: 18 }}>遗嘱消息（Will）</div>
          <div style={styles.hint}>客户端异常掉线时由 Broker 代为发布，用于让下游及时感知设备离线。</div>
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={Boolean(draft.will?.enabled)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  will: {
                    enabled: e.target.checked,
                    topic: draft.will?.topic ?? '',
                    payload: draft.will?.payload ?? 'offline',
                    encoding: draft.will?.encoding ?? 'utf8',
                    qos: draft.will?.qos ?? 0,
                    retain: draft.will?.retain ?? false
                  }
                })
              }
            />
            启用遗嘱消息
          </label>
          {draft.will?.enabled && (
            <>
              <div style={styles.grid2}>
                <Field label="遗嘱主题">
                  <input
                    style={{ ...field, fontFamily: 'var(--font-mono)' }}
                    value={draft.will.topic}
                    placeholder="device/1/status"
                    onChange={(e) =>
                      setDraft({ ...draft, will: { ...draft.will!, topic: e.target.value } })
                    }
                  />
                </Field>
                <Field label="QoS / Retain">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Select
                      style={{ width: 104 }}
                      value={String(draft.will.qos)}
                      searchable={false}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          will: { ...draft.will!, qos: Number(v) as 0 | 1 | 2 }
                        })
                      }
                      options={[
                        { value: '0', label: 'QoS 0' },
                        { value: '1', label: 'QoS 1' },
                        { value: '2', label: 'QoS 2' }
                      ]}
                    />
                    <label style={checkRow}>
                      <input
                        type="checkbox"
                        checked={draft.will.retain}
                        onChange={(e) =>
                          setDraft({ ...draft, will: { ...draft.will!, retain: e.target.checked } })
                        }
                      />
                      Retain
                    </label>
                  </div>
                </Field>
              </div>
              <Field label="遗嘱载荷">
                <input
                  style={{ ...field, fontFamily: 'var(--font-mono)' }}
                  value={draft.will.payload}
                  onChange={(e) =>
                    setDraft({ ...draft, will: { ...draft.will!, payload: e.target.value } })
                  }
                />
              </Field>
            </>
          )}
        </div>

        <div style={styles.footer}>
          {dirtyConn && <span style={styles.dirty}>连接参数已修改，应用后会重建连接</span>}
          <span style={{ flex: 1 }} />
          <button style={btnSecondary} onClick={onClose}>
            关闭
          </button>
          <button style={btnPrimary} disabled={!dirtyConn} onClick={applyConn}>
            应用并重连
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={styles.fieldWrap}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    ...surface,
    width: 620,
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
  body: {
    overflowY: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  },
  sectionTitle: { fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-0)' },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', lineHeight: 1.6 },
  code: {
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-inset)',
    borderRadius: 3,
    padding: '1px 4px'
  },
  empty: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', padding: '10px 0' },
  subRow: { display: 'flex', alignItems: 'center', gap: 8 },
  iconDel: {
    width: 24,
    height: 24,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-xs)'
  },
  fieldWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid var(--border)'
  },
  dirty: { fontSize: 'var(--fs-xs)', color: 'var(--warn)' }
}
