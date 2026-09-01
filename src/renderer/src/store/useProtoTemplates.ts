import { create } from 'zustand'
import type { ConnectionKind, ProtoField, ProtoTemplate } from '@shared/protocol'

interface ProtoState {
  templates: ProtoTemplate[]
  /** 每个会话选中的模板 id；'' = 关闭解析，'auto' = 按前缀自动匹配 */
  selBySession: Record<string, string>
  /** 新建模板。传入 kinds 时模板只在这些连接类型下可选（新建入口会带上当前会话类型） */
  add: (kinds?: ConnectionKind[]) => ProtoTemplate
  update: (id: string, patch: Partial<ProtoTemplate>) => void
  remove: (id: string) => void
  duplicate: (id: string) => void
  addField: (id: string) => void
  updateField: (id: string, fieldId: string, patch: Partial<ProtoField>) => void
  removeField: (id: string, fieldId: string) => void
  moveField: (id: string, fieldId: string, delta: number) => void
  select: (sessionId: string, templateId: string) => void
  load: (list: ProtoTemplate[]) => void
}

/**
 * 某模板是否适用于某连接类型。
 *
 * 兼容旧数据：1.8.2 之前存下来的模板没有 kinds 字段，一律视为通用模板，
 * 否则用户升级后解析下拉会突然空掉。
 */
export function templateFitsKind(tpl: ProtoTemplate, kind: ConnectionKind): boolean {
  const list = tpl.kinds
  if (!list || list.length === 0) return true
  return list.includes(kind)
}

const KEY = 'toolbox.protoTemplates'
const SEL_KEY = 'toolbox.protoSelection'

function rid(): string {
  return Math.random().toString(36).slice(2)
}

function persist(list: ProtoTemplate[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // ignore
  }
}

function persistSel(map: Record<string, string>): void {
  try {
    localStorage.setItem(SEL_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

function restoreSel(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEL_KEY)
    if (raw) return JSON.parse(raw) as Record<string, string>
  } catch {
    // ignore
  }
  return {}
}

/** 内置示例：一个常见的「帧头+命令+长度+载荷+校验」自定义协议，和一条 Modbus RTU 读保持寄存器 */
function demoTemplates(): ProtoTemplate[] {
  return [
    {
      id: 'tpl-demo',
      name: '示例：AA55 自定义帧',
      // 通用字节流协议，TCP/串口/WebSocket 都可能遇到，所以不限归属
      kinds: [],
      matchPrefixHex: 'AA55',
      direction: 'any',
      checksum: 'sum8',
      fields: [
        { id: 'f1', name: '帧头', type: 'hex', length: 2, note: '固定 AA 55' },
        { id: 'f2', name: '命令码', type: 'uint8', enumMap: '1=读取,2=写入,3=心跳,255=错误' },
        { id: 'f3', name: '数据长度', type: 'uint8', unit: 'B' },
        { id: 'f4', name: '温度', type: 'int16', bigEndian: true, scale: 0.1, unit: '℃', chart: true },
        { id: 'f5', name: '状态位', type: 'bits', length: 1 },
        { id: 'f6', name: '载荷', type: 'hex', length: 0, note: '剩余字节' }
      ]
    },
    {
      id: 'tpl-modbus',
      name: '示例：Modbus RTU 读保持寄存器',
      // 「从站地址 / 起始地址」是 Modbus 专有语义，别的链路选中只会得到噪声
      kinds: ['modbus-rtu', 'modbus-tcp'],
      matchPrefixHex: '',
      direction: 'tx',
      checksum: 'crc16-modbus',
      fields: [
        { id: 'm1', name: '从站地址', type: 'uint8' },
        { id: 'm2', name: '功能码', type: 'uint8', enumMap: '1=读线圈,3=读保持寄存器,6=写单个寄存器,16=写多个寄存器' },
        { id: 'm3', name: '起始地址', type: 'uint16', bigEndian: true },
        { id: 'm4', name: '寄存器数量', type: 'uint16', bigEndian: true }
      ]
    }
  ]
}

function restore(): ProtoTemplate[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as ProtoTemplate[]
  } catch {
    // ignore
  }
  return demoTemplates()
}

export const useProtoTemplates = create<ProtoState>((set, get) => ({
  templates: restore(),
  selBySession: restoreSel(),

  add: (kinds) => {
    const tpl: ProtoTemplate = {
      id: rid(),
      name: '新模板',
      kinds: kinds ?? [],
      matchPrefixHex: '',
      direction: 'any',
      checksum: 'none',
      fields: [{ id: rid(), name: '字段1', type: 'uint8' }]
    }
    const list = [...get().templates, tpl]
    persist(list)
    set({ templates: list })
    return tpl
  },

  update: (id, patch) => {
    const list = get().templates.map((t) => (t.id === id ? { ...t, ...patch } : t))
    persist(list)
    set({ templates: list })
  },

  remove: (id) => {
    const list = get().templates.filter((t) => t.id !== id)
    persist(list)
    // 清掉指向已删模板的会话选择，避免解析栏挂空
    const sel = { ...get().selBySession }
    for (const k of Object.keys(sel)) if (sel[k] === id) delete sel[k]
    persistSel(sel)
    set({ templates: list, selBySession: sel })
  },

  duplicate: (id) => {
    const src = get().templates.find((t) => t.id === id)
    if (!src) return
    const copy: ProtoTemplate = {
      ...JSON.parse(JSON.stringify(src)),
      id: rid(),
      name: src.name + ' 副本'
    }
    copy.fields = copy.fields.map((f) => ({ ...f, id: rid() }))
    const list = [...get().templates, copy]
    persist(list)
    set({ templates: list })
  },

  addField: (id) => {
    const list = get().templates.map((t) =>
      t.id === id
        ? { ...t, fields: [...t.fields, { id: rid(), name: '字段' + (t.fields.length + 1), type: 'uint8' as const }] }
        : t
    )
    persist(list)
    set({ templates: list })
  },

  updateField: (id, fieldId, patch) => {
    const list = get().templates.map((t) =>
      t.id === id
        ? { ...t, fields: t.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) }
        : t
    )
    persist(list)
    set({ templates: list })
  },

  removeField: (id, fieldId) => {
    const list = get().templates.map((t) =>
      t.id === id ? { ...t, fields: t.fields.filter((f) => f.id !== fieldId) } : t
    )
    persist(list)
    set({ templates: list })
  },

  moveField: (id, fieldId, delta) => {
    const list = get().templates.map((t) => {
      if (t.id !== id) return t
      const i = t.fields.findIndex((f) => f.id === fieldId)
      const j = i + delta
      if (i < 0 || j < 0 || j >= t.fields.length) return t
      const fields = [...t.fields]
      const [moved] = fields.splice(i, 1)
      fields.splice(j, 0, moved)
      return { ...t, fields }
    })
    persist(list)
    set({ templates: list })
  },

  select: (sessionId, templateId) => {
    const sel = { ...get().selBySession, [sessionId]: templateId }
    persistSel(sel)
    set({ selBySession: sel })
  },

  load: (list) => {
    persist(list)
    set({ templates: list })
  }
}))
