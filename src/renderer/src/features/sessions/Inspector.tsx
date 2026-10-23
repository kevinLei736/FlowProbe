import { useMemo, useState } from 'react'
import type { Peer, Session } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { KIND_META, keyHint } from '../../app/meta'
import { collectGroups, useSessionOrg } from '../../store/useSessionOrg'
import { Select } from '../../components/ui/Select'

type ParamFieldType = 'text' | 'number' | 'lines' | 'csv' | 'bool' | 'select'

interface ParamField {
  key: string
  label: string
  type?: ParamFieldType
  options?: { value: string; label: string }[]
}

export function Inspector({ session }: { session: Session }): JSX.Element {
  const peers = useStore((s) => s.peersBySession[session.id] ?? [])
  const kickPeer = useStore((s) => s.kickPeer)
  const renameSession = useStore((s) => s.renameSession)
  const setAutoStart = useStore((s) => s.setAutoStart)
  const updateSessionConfig = useStore((s) => s.updateSessionConfig)
  const duplicateSession = useStore((s) => s.duplicateSession)
  const setSessionMeta = useStore((s) => s.setSessionMeta)
  const allSessions = useStore((s) => s.sessions)
  const tagFilter = useSessionOrg((s) => s.tagFilter)
  const toggleTag = useSessionOrg((s) => s.toggleTag)
  const knownGroups = useMemo(() => collectGroups(allSessions), [allSessions])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)
  const [paramOpen, setParamOpen] = useState(false)
  const [wsPath, setWsPath] = useState('')
  const [histCount, setHistCount] = useState<number | null>(null)
  const [histBusy, setHistBusy] = useState(false)
  const c = session.config
  // UDP 服务端也有对端列表（按来源地址派生），所以一起走「服务端」那套展示
  // 从站模拟同样是被连的一方（主站连进来），要显示对端列表
  const isServer =
    session.kind === 'tcp-server' ||
    session.kind === 'ws-server' ||
    session.kind === 'udp-server' ||
    session.kind === 'modbus-slave'

  const rows: [string, string][] = []
  if (session.kind === 'tcp-client' || session.kind === 'tcp-server') {
    rows.push(['地址', String(c.host ?? '-')])
    rows.push(['端口', String(c.port ?? '-')])
  } else if (session.kind === 'ws-client') {
    rows.push(['URL', String(c.url ?? '-')])
    if (Array.isArray(c.subProtocols) && c.subProtocols.length) rows.push(['子协议', c.subProtocols.join(',')])
    if (Number(c.pingIntervalMs) > 0) rows.push(['Ping间隔', String(c.pingIntervalMs) + 'ms'])
  } else if (session.kind === 'ws-server') {
    rows.push(['端口', String(c.port ?? '-')])
    rows.push(['路径', String(c.path ?? '/')])
    if (Array.isArray(c.subProtocols) && c.subProtocols.length) rows.push(['子协议', c.subProtocols.join(',')])
  } else if (session.kind === 'udp-client') {
    rows.push(['默认目标', String(c.host ?? '-') + ':' + String(c.port ?? '-')])
    rows.push(['本地绑定', String(c.udpBindHost ?? '0.0.0.0') + ':' + String(c.udpBindPort ?? 0)])
    if (c.udpBroadcast) rows.push(['广播', '开'])
    if (String(c.udpMulticastGroup ?? '')) {
      rows.push(['组播组', String(c.udpMulticastGroup)])
      rows.push(['TTL', String(c.udpTtl ?? 1)])
    }
    if (c.heartbeatEnabled) rows.push(['心跳', '开'])
  } else if (session.kind === 'udp-server') {
    rows.push(['监听', String(c.udpBindHost ?? '0.0.0.0') + ':' + String(c.udpBindPort ?? c.port ?? '-')])
    if (c.udpBroadcast) rows.push(['广播', '开'])
    if (String(c.udpMulticastGroup ?? '')) {
      rows.push(['组播组', String(c.udpMulticastGroup)])
      rows.push(['TTL', String(c.udpTtl ?? 1)])
    }
    rows.push(['对端淘汰', Number(c.udpPeerIdleMs ?? 60000) > 0 ? String(c.udpPeerIdleMs ?? 60000) + 'ms' : '不淘汰'])
  } else if (session.kind === 'modbus-slave') {
    const sl = c.modbusSlave
    rows.push(['传输', sl?.transport === 'rtu' ? '串口 RTU' : sl?.transport === 'rtu-over-tcp' ? 'RTU over TCP' : 'Modbus TCP'])
    if (sl?.transport === 'rtu') rows.push(['串口', String(c.serialPath ?? '-')])
    else rows.push(['监听', String(sl?.host ?? '0.0.0.0') + ':' + String(sl?.port ?? '-')])
    rows.push(['从站地址', sl?.acceptAnyUnit ? '任意' : String(sl?.unitId ?? 1)])
    rows.push(['数据区', String((sl?.regions ?? []).filter((r) => r.enabled).length) + ' 个'])
    if (Number(sl?.responseDelayMs ?? 0) > 0) rows.push(['应答延迟', String(sl?.responseDelayMs) + 'ms'])
    if (Number(sl?.dropRate ?? 0) > 0) rows.push(['丢包率', Math.round(Number(sl?.dropRate) * 100) + '%'])
    if (sl?.exception?.enabled) rows.push(['强制异常', '0x' + Number(sl.exception.code).toString(16)])
  } else if (session.kind === 'serial') {
    rows.push(['串口', String(c.serialPath ?? '-')])
    rows.push(['波特率', String(c.baudRate ?? '-')])
    rows.push(['数据位', String(c.dataBits ?? 8)])
    rows.push(['停止位', String(c.stopBits ?? 1)])
    rows.push(['校验位', String(c.parity ?? 'none')])
  }
  // UDP 没有分帧概念，即使旧配置里残留 framing 也不展示，免得误导
  const showsFraming =
    session.kind !== 'udp-client' &&
    session.kind !== 'udp-server' &&
    session.kind !== 'modbus-slave'
  if (showsFraming && c.framing && typeof c.framing === 'object') {
    rows.push(['分帧', String((c.framing as { mode?: string }).mode ?? 'none')])
  }
  const canReconnect =
    session.kind === 'tcp-client' || session.kind === 'ws-client' || session.kind === 'serial'
  if (canReconnect && c.autoReconnect) {
    const base = Number(c.reconnectIntervalMs ?? 1000)
    const max = Number(c.reconnectMaxIntervalMs ?? 30000)
    const attempts = Number(c.reconnectMaxAttempts ?? 0)
    rows.push(['自动重连', '开'])
    rows.push(['退避', base + 'ms→' + max + 'ms'])
    rows.push(['重连上限', attempts > 0 ? attempts + ' 次' : '不限'])
  }
  if (session.kind === 'tcp-client' && c.heartbeatEnabled) rows.push(['心跳', '开'])

  /**
   * 可就地修改的主要连接参数。
   *
   * 原来是一串嵌套三元表达式，每加一种连接类型就多一层缩进；改成查表后
   * 新协议只需加一行，也避免了漏写分支时静默落到空数组。
   */
  const EDITABLE: Partial<Record<Session['kind'], ParamField[]>> = {
    'tcp-client': [
      { key: 'host', label: '地址' },
      { key: 'port', label: '端口', type: 'number' },
      { key: 'autoReconnect', label: '断线自动重连', type: 'bool' }
    ],
    'tcp-server': [
      { key: 'host', label: '监听地址' },
      { key: 'port', label: '端口', type: 'number' }
    ],
    'http-mock': [
      { key: 'host', label: '监听地址' },
      { key: 'port', label: '端口', type: 'number' }
    ],
    'ws-client': [
      { key: 'url', label: 'URL' },
      { key: 'headers', label: 'Header（每行 Key: Value）', type: 'lines' },
      { key: 'subProtocols', label: '子协议（逗号分隔）', type: 'csv' },
      { key: 'pingIntervalMs', label: 'Ping 间隔(ms)', type: 'number' },
      { key: 'autoReconnect', label: '断线自动重连', type: 'bool' }
    ],
    'ws-server': [
      { key: 'port', label: '端口', type: 'number' },
      { key: 'path', label: '路径' }
    ],
    'udp-client': [
      { key: 'host', label: '默认目标地址' },
      { key: 'port', label: '目标端口', type: 'number' },
      { key: 'udpBindPort', label: '本地绑定端口', type: 'number' },
      { key: 'udpBroadcast', label: '允许广播', type: 'bool' }
    ],
    'udp-server': [
      { key: 'udpBindHost', label: '监听地址' },
      { key: 'udpBindPort', label: '监听端口', type: 'number' }
    ],
    // 从站的端口在 modbusSlave.port 里，热改要走「数据区」面板的链路页；
    // 这里只放顶层镜像字段会造成两处不一致，故不开放
    'modbus-slave': [],
    serial: [
      { key: 'serialPath', label: '串口' },
      { key: 'baudRate', label: '波特率', type: 'number' },
      { key: 'dataBits', label: '数据位', type: 'number' },
      { key: 'stopBits', label: '停止位', type: 'number' },
      {
        key: 'parity',
        label: '校验位',
        type: 'select',
        options: [
          { value: 'none', label: 'none' },
          { value: 'even', label: 'even' },
          { value: 'odd', label: 'odd' },
          { value: 'mark', label: 'mark' },
          { value: 'space', label: 'space' }
        ]
      }
    ]
  }
  const editableFields = EDITABLE[session.kind] ?? []

  return (
    <aside style={styles.aside}>
      <div style={styles.section}>检查器</div>

      <Group title="会话">
        {editing ? (
          <div style={styles.nameEdit}>
            <input
              style={styles.nameInput}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  renameSession(session.id, draft)
                  setEditing(false)
                } else if (e.key === 'Escape') {
                  setDraft(session.name)
                  setEditing(false)
                }
              }}
            />
            <button
              style={styles.nameOk}
              onClick={() => {
                renameSession(session.id, draft)
                setEditing(false)
              }}
            >
              保存
            </button>
          </div>
        ) : (
          <div style={styles.nameRow}>
            <span style={styles.nameText}>{session.name}</span>
            <button
              style={styles.nameEditBtn}
              title="重命名"
              onClick={() => {
                setDraft(session.name)
                setEditing(true)
              }}
            >
              改名
            </button>
          </div>
        )}
        <label style={styles.autoStart}>
          <input
            type="checkbox"
            checked={session.autoStart === true}
            onChange={(e) => setAutoStart(session.id, e.target.checked)}
          />
          下次打开应用时自动连接
        </label>
        <div style={styles.btnRow}>
          <button style={styles.ghostBtn} onClick={() => void duplicateSession(session.id)}>
            复制会话
          </button>
          {editableFields.length > 0 && (
            <button style={styles.ghostBtn} onClick={() => setParamOpen((v) => !v)}>
              {paramOpen ? '收起参数' : '改参数'}
            </button>
          )}
        </div>
        {paramOpen && (
          <ParamEditor
            fields={editableFields}
            config={c}
            onSave={(patch) => {
              updateSessionConfig(session.id, patch)
              setParamOpen(false)
            }}
          />
        )}
      </Group>

      <Group title="分组与标签">
        <OrgEditor
          key={session.id}
          group={session.group ?? ''}
          tags={session.tags ?? []}
          knownGroups={knownGroups}
          activeTags={tagFilter}
          onGroup={(g) => setSessionMeta(session.id, { group: g })}
          onTags={(t) => setSessionMeta(session.id, { tags: t })}
          onFilterTag={toggleTag}
        />
      </Group>

      <Group title="基础信息">
        <Row k="类型" v={KIND_META[session.kind].label} />
        {rows.map(([k, v]) => (
          <Row key={k} k={k} v={v} />
        ))}
      </Group>

      {isServer && (
        <Group title={`${session.kind === 'udp-server' ? '对端' : '客户端'} (${peers.length})`}>
          {peers.length === 0 && <div style={styles.hint}>暂无连接</div>}
          {peers.map((p: Peer) => (
            <div key={p.id} style={styles.peer}>
              <span style={styles.peerLabel}>{p.label}</span>
              <button style={styles.kick} onClick={() => kickPeer(session.id, p.id)}>
                踢出
              </button>
            </div>
          ))}
        </Group>
      )}

      <Group title="工作区">
        <div style={styles.hint}>
          会话配置自动保存，重启应用后恢复；报文与统计不落盘。
        </div>
        <div style={styles.btnRow}>
          <button
            style={styles.ghostBtn}
            onClick={() => {
              void window.toolbox.workspaceInfo().then((i) => setWsPath(i.path))
            }}
          >
            查看存储位置
          </button>
          <button
            style={styles.dangerBtn}
            onClick={() => {
              if (window.confirm('清空已保存的会话配置？当前窗口中的会话不受影响，但下次启动不再恢复。')) {
                void window.toolbox.clearWorkspace()
              }
            }}
          >
            清空存档
          </button>
        </div>
        {wsPath && <div style={styles.pathText}>{wsPath}</div>}
      </Group>

      <Group title="报文历史">
        <div style={styles.hint}>
          {`报文与请求日志按会话落在本地 SQLite 库，${keyHint('Ctrl+H')} 打开历史记录检索。`}
        </div>
        <div style={styles.btnRow}>
          <button
            style={styles.ghostBtn}
            disabled={histBusy}
            onClick={() => {
              setHistBusy(true)
              void window.toolbox
                .historyQueryFrames({ sessionIds: [session.id], limit: 1, offset: 0 })
                .then((p) => setHistCount(p.total))
                .catch(() => setHistCount(null))
                .finally(() => setHistBusy(false))
            }}
          >
            统计本会话条数
          </button>
          <button
            style={styles.dangerBtn}
            disabled={histBusy}
            onClick={() => {
              if (!window.confirm('删除该会话在历史库中的全部报文与请求日志？该操作不可撤销。')) return
              setHistBusy(true)
              void window.toolbox
                .historyClearSession(session.id)
                .then(() => setHistCount(0))
                .finally(() => setHistBusy(false))
            }}
          >
            删除本会话历史
          </button>
        </div>
        {histCount !== null && <div style={styles.pathText}>历史库中 {histCount} 条</div>}
      </Group>

      <Group title="统计">
        <Row k="发送帧" v={String(session.metrics.txFrames)} />
        <Row k="接收帧" v={String(session.metrics.rxFrames)} />
        <Row k="发送字节" v={String(session.metrics.txBytes)} />
        <Row k="接收字节" v={String(session.metrics.rxBytes)} />
        {isServer && (
          <Row
            k={session.kind === 'udp-server' ? '活跃对端' : '在线连接'}
            v={String(session.metrics.peers)}
          />
        )}
      </Group>
    </aside>
  )
}

/**
 * 分组与标签编辑器。分组用「输入 + 已有分组快捷选择」的组合：
 * 直接打字能建新组，点已有组名能立刻归位，不用记之前起过什么名字。
 */
function OrgEditor({
  group,
  tags,
  knownGroups,
  activeTags,
  onGroup,
  onTags,
  onFilterTag
}: {
  group: string
  tags: string[]
  knownGroups: string[]
  activeTags: string[]
  onGroup: (g: string) => void
  onTags: (t: string[]) => void
  onFilterTag: (t: string) => void
}): JSX.Element {
  const [groupDraft, setGroupDraft] = useState(group)
  const [tagDraft, setTagDraft] = useState('')

  const commitGroup = (value: string): void => {
    setGroupDraft(value)
    onGroup(value.trim())
  }

  const addTag = (): void => {
    // 支持一次粘进多个标签：逗号、中文逗号、空格都当分隔符
    const parts = tagDraft
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...tags]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onTags(next)
    setTagDraft('')
  }

  return (
    <div style={styles.orgBox}>
      <div style={styles.paramRow}>
        <span style={styles.paramLabel}>分组</span>
        <input
          style={styles.paramInput}
          value={groupDraft}
          placeholder="留空为未分组"
          onChange={(e) => setGroupDraft(e.target.value)}
          onBlur={(e) => commitGroup(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitGroup((e.target as HTMLInputElement).value)
          }}
        />
      </div>
      {knownGroups.length > 0 && (
        <div style={styles.chipRow}>
          {knownGroups
            .filter((g) => g !== groupDraft.trim())
            .map((g) => (
              <button key={g} style={styles.chipGhost} title="移动到该分组" onClick={() => commitGroup(g)}>
                {g}
              </button>
            ))}
          {groupDraft.trim() !== '' && (
            <button style={styles.chipGhost} title="移出分组" onClick={() => commitGroup('')}>
              移出分组
            </button>
          )}
        </div>
      )}

      <div style={styles.paramRow}>
        <span style={styles.paramLabel}>标签</span>
        <div style={styles.tagInputRow}>
          <input
            style={{ ...styles.paramInput, flex: 1 }}
            value={tagDraft}
            placeholder="回车添加，可用逗号分隔"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              }
            }}
          />
          <button style={styles.tagAdd} onClick={addTag}>
            添加
          </button>
        </div>
      </div>
      {tags.length === 0 ? (
        <div style={styles.hint}>还没有标签。标签可在左栏用来筛选会话。</div>
      ) : (
        <div style={styles.chipRow}>
          {tags.map((t) => (
            <span key={t} style={{ ...styles.chipTag, ...(activeTags.includes(t) ? styles.chipTagOn : {}) }}>
              <button style={styles.chipTagName} title="在左栏按此标签筛选" onClick={() => onFilterTag(t)}>
                {t}
              </button>
              <button
                style={styles.chipTagDel}
                title="移除标签"
                onClick={() => onTags(tags.filter((x) => x !== t))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ParamEditor({
  fields,
  config,
  onSave
}: {
  fields: ParamField[]
  config: Record<string, unknown>
  onSave: (patch: Record<string, unknown>) => void
}): JSX.Element {
  /**
   * 草稿统一按字符串存，渲染时再按 type 还原。
   * 好处是「输入到一半」不会因为 Number('') = 0 把端口改成 0；
   * 提交时才做校验，非法值直接保留原值。
   */
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of fields) {
      const value = config[f.key]
      if (f.type === 'lines') {
        init[f.key] =
          value && typeof value === 'object'
            ? Object.entries(value as Record<string, string>)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
            : ''
      } else if (f.type === 'csv') {
        init[f.key] = Array.isArray(value) ? value.join(', ') : ''
      } else if (f.type === 'bool') {
        init[f.key] = value === true ? 'true' : 'false'
      } else {
        init[f.key] = String(value ?? '')
      }
    }
    return init
  })

  const commit = (): void => {
    const patch: Record<string, unknown> = {}
    for (const f of fields) {
      const raw = draft[f.key] ?? ''
      switch (f.type) {
        case 'number': {
          const n = Number(raw)
          // 空值或非法数字不提交，避免把端口写成 0 / NaN
          if (raw.trim() === '' || Number.isNaN(n)) continue
          patch[f.key] = n
          break
        }
        case 'lines': {
          const headers: Record<string, string> = {}
          for (const line of raw.split('\n')) {
            const idx = line.indexOf(':')
            if (idx <= 0) continue
            const k = line.slice(0, idx).trim()
            if (k) headers[k] = line.slice(idx + 1).trim()
          }
          patch[f.key] = headers
          break
        }
        case 'csv':
          patch[f.key] = raw
            .split(/[,，]/)
            .map((v) => v.trim())
            .filter(Boolean)
          break
        case 'bool':
          patch[f.key] = raw === 'true'
          break
        default:
          patch[f.key] = raw
      }
    }
    onSave(patch)
  }

  return (
    <div style={styles.paramBox}>
      {fields.map((f) => {
        if (f.type === 'bool') {
          return (
            <label key={f.key} style={styles.paramCheck}>
              <input
                type="checkbox"
                checked={draft[f.key] === 'true'}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.key]: e.target.checked ? 'true' : 'false' }))
                }
              />
              {f.label}
            </label>
          )
        }
        if (f.type === 'lines') {
          return (
            <div key={f.key} style={styles.paramStack}>
              <span style={styles.paramLabel}>{f.label}</span>
              <textarea
                style={styles.paramArea}
                value={draft[f.key] ?? ''}
                placeholder={'Authorization: Bearer xxx\nX-Tenant: demo'}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </div>
          )
        }
        if (f.type === 'select') {
          return (
            <div key={f.key} style={styles.paramRow}>
              <span style={styles.paramLabel}>{f.label}</span>
              <Select
                size="sm"
                searchable={false}
                value={draft[f.key] ?? ''}
                options={f.options ?? []}
                onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
              />
            </div>
          )
        }
        return (
          <div key={f.key} style={styles.paramRow}>
            <span style={styles.paramLabel}>{f.label}</span>
            <input
              style={styles.paramInput}
              value={draft[f.key] ?? ''}
              inputMode={f.type === 'number' ? 'numeric' : undefined}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            />
          </div>
        )
      })}
      <button style={styles.nameOk} onClick={commit}>
        应用并重建
      </button>
      <div style={styles.hint}>应用后会断开当前连接，并按新参数自动重连。</div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={styles.group}>
      <div style={styles.groupTitle}>{title}</div>
      {children}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div style={styles.row}>
      <span style={styles.k}>{k}</span>
      <span style={styles.v}>{v}</span>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  aside: { background: 'var(--bg-1)', minWidth: 0, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 14 },
  section: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', marginBottom: 12, letterSpacing: 0.5 },
  group: { marginBottom: 18 },
  groupTitle: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 'var(--fs-sm)' },
  k: { color: 'var(--text-2)' },
  v: { color: 'var(--text-0)', fontFamily: 'var(--font-mono)', maxWidth: 150, textAlign: 'right', wordBreak: 'break-all' },
  hint: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)' },
  peer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', gap: 8 },
  peerLabel: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  kick: { padding: '2px 8px', background: 'transparent', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  nameRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  nameText: { flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  nameEditBtn: { flexShrink: 0, padding: '2px 8px', background: 'var(--btn2-bg)', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-micro)' },
  nameEdit: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  nameInput: { width: '100%', minWidth: 0, background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 7px', fontSize: 'var(--fs-sm)', outline: 'none' },
  nameOk: { alignSelf: 'flex-start', padding: '3px 12px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  autoStart: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  btnRow: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  ghostBtn: { flex: '1 1 auto', minWidth: 0, padding: '4px 8px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  dangerBtn: { flex: '1 1 auto', minWidth: 0, padding: '4px 8px', background: 'var(--btn2-bg)', color: 'var(--error)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  pathText: { marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--text-2)', wordBreak: 'break-all' },
  paramBox: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, padding: 8, border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', minWidth: 0 },
  paramRow: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  paramStack: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  paramLabel: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  paramInput: { width: '100%', minWidth: 0, background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 7px', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', outline: 'none' },
  paramArea: { width: '100%', minWidth: 0, minHeight: 84, resize: 'vertical', background: 'var(--field-bg)', color: 'var(--field-fg)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '6px 7px', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', lineHeight: 1.6, outline: 'none' },
  paramCheck: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  orgBox: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  chipGhost: { padding: '2px 8px', background: 'var(--btn2-bg)', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 11, fontSize: 'var(--fs-micro)' },
  chipTag: { display: 'inline-flex', alignItems: 'center', background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 11, overflow: 'hidden' },
  chipTagOn: { background: 'var(--selected-bg)' },
  chipTagName: { padding: '2px 4px 2px 8px', background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 'var(--fs-micro)' },
  chipTagDel: { padding: '2px 7px 2px 3px', background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-micro)' },
  tagInputRow: { display: 'flex', gap: 5, minWidth: 0 },
  tagAdd: { flexShrink: 0, padding: '4px 9px', background: 'var(--bg-2)', color: 'var(--text-1)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-micro)' }
}
