import { create } from 'zustand'
import { useTabs } from './useTabs'
import { annotateFrame } from '../features/alerts/alertRuntime'
import type {
  ConnectionKind,
  Frame,
  MockConfig,
  HttpMockConfig,
  HttpLogEntry,
  ModbusPoint,
  ModbusPointValue,
  ModbusArea,
  ModbusSlaveRegion,
  ModbusSlaveRegionValues,
  MqttSubscription,
  OutgoingFrame,
  Peer,
  Session,
  SessionConfig,
  SessionMetaPatch
} from '@shared/protocol'

interface State {
  sessions: Session[]
  framesBySession: Record<string, Frame[]>
  peersBySession: Record<string, Peer[]>
  httpLogsBySession: Record<string, HttpLogEntry[]>
  /** Modbus 点位实时值：sessionId -> pointId -> 值 */
  modbusValues: Record<string, Record<string, ModbusPointValue>>
  /** Modbus 从站各数据区当前值：sessionId -> regionId -> 值数组 */
  slaveValues: Record<string, Record<string, ModbusSlaveRegionValues>>
  activeId: string | null
  initialized: boolean
  /**
   * 会话列表是否已从主进程拉回来。
   *
   * 为什么不能复用 initialized：它在 init() 里同步置真（用来防重复订阅），
   * 而会话列表要等一次 IPC 往返。任何「拿 sessions 当全量真相」的逻辑
   * （比如清理失效标签）都必须等这个标志，否则首帧的空数组会被当成
   * 「一个会话都没有」。
   */
  sessionsLoaded: boolean

  init: () => void
  /** 传 null = 中栏回到空态（关掉最后一个标签时用） */
  setActive: (id: string | null) => void
  createSession: (
    kind: ConnectionKind,
    name: string,
    config: SessionConfig,
    autoStart?: boolean,
    meta?: SessionMetaPatch
  ) => Promise<void>
  renameSession: (id: string, name: string) => void
  setSessionMeta: (id: string, patch: SessionMetaPatch) => void
  duplicateSession: (id: string) => Promise<void>
  updateSessionConfig: (id: string, cfg: SessionConfig) => void
  setAutoStart: (id: string, on: boolean) => void
  start: (id: string) => void
  stop: (id: string) => void
  remove: (id: string) => void
  send: (frame: OutgoingFrame) => void
  kickPeer: (id: string, peerId: string) => void
  updateMock: (id: string, cfg: MockConfig) => void
  updateHttpMock: (id: string, cfg: HttpMockConfig) => void
  clearFrames: (id: string) => void
  clearHttpLogs: (id: string) => void
  /** 把一帧直接注入时间轴（用于录制回放，不经过真实链路） */
  injectFrame: (frame: Frame) => void
  /** MQTT 订阅表变更：主进程做增量订阅/退订，不重连 */
  updateMqttSubs: (id: string, subs: MqttSubscription[]) => void
  /** Modbus 点表变更：主进程重排轮询计划，不断链路 */
  updateModbusPoints: (id: string, points: ModbusPoint[]) => void
  /** 从站数据区定义变更：主进程重建地址空间，不断监听 */
  updateSlaveRegions: (id: string, regions: ModbusSlaveRegion[]) => void
  /** 从站手动置值 */
  writeSlaveRegister: (id: string, area: ModbusArea, addr: number, value: number) => void
}

/**
 * 报文/日志内存上限。时间轴已改为虚拟滚动，DOM 只渲染可视区几十行，
 * 因此上限从 2000 提到 50000，长时间抓包也能往回翻。
 */
const MAX_FRAMES = 50000

/**
 * 高频报文合批：每帧到达就 set 一次会让 React 在高吞吐下疯狂重渲染。
 * 这里先攒进缓冲区，每帧合并写一次 store。
 */
const frameBuffer = new Map<string, Frame[]>()
const logBuffer = new Map<string, HttpLogEntry[]>()
let rafHandle: number | null = null
let timerHandle: ReturnType<typeof setTimeout> | null = null

/**
 * 配置类 IPC 的合并写入。
 *
 * Mock 路由面板是「改一个字就提交」的受控表单，而主进程收到后会把整个
 * workspace.json 同步落盘一次。编辑一段 200 字的响应体就是 200 次写盘，
 * 既卡界面也伤磁盘。这里只延迟主进程写入，界面状态仍然即时更新，
 * 用户感知不到差别；窗口关闭前统一 flush，不会丢最后一次修改。
 */
const pendingWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>()

function scheduleWrite(key: string, run: () => void, delayMs = 280): void {
  const prev = pendingWrites.get(key)
  if (prev) clearTimeout(prev.timer)
  const timer = setTimeout(() => {
    pendingWrites.delete(key)
    run()
  }, delayMs)
  pendingWrites.set(key, { timer, run })
}

function flushWrites(key?: string): void {
  for (const k of key ? [key] : [...pendingWrites.keys()]) {
    const pending = pendingWrites.get(k)
    if (!pending) continue
    clearTimeout(pending.timer)
    pendingWrites.delete(k)
    pending.run()
  }
}

function cancelWrite(key: string): void {
  const pending = pendingWrites.get(key)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingWrites.delete(key)
}

/** 立即把待写的配置发给主进程（面板关闭、窗口失焦时调用） */
export function flushPendingWrites(): void {
  flushWrites()
}

/** 后台兜底刷新间隔。取 120ms：肉眼无感，又不至于在高吞吐下把主线程占满 */
const BACKGROUND_FLUSH_MS = 120

/**
 * 合批只用 requestAnimationFrame 是不够的：窗口最小化、被完全遮挡或切到后台时
 * 浏览器会挂起 rAF 回调，报文就一直堆在缓冲区里进不了时间轴，
 * 用户切回来才「一次性刷出一大坨」，长时间挂机抓包时看起来像丢数据。
 *
 * 因此同时挂一个定时器兜底，两者谁先到谁负责刷，另一个取消。
 * 前台时 rAF 先到（保持按帧节流的渲染性能），后台时定时器接管（保证数据可见）。
 */
function scheduleFlush(set: (fn: (s: State) => Partial<State>) => void): void {
  if (rafHandle !== null || timerHandle !== null) return
  const run = (): void => {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle)
      rafHandle = null
    }
    if (timerHandle !== null) {
      clearTimeout(timerHandle)
      timerHandle = null
    }
    if (frameBuffer.size === 0 && logBuffer.size === 0) return
    const pendingFrames = new Map(frameBuffer)
    const pendingLogs = new Map(logBuffer)
    frameBuffer.clear()
    logBuffer.clear()
    set((s) => {
      const patch: Partial<State> = {}
      if (pendingFrames.size > 0) {
        const next = { ...s.framesBySession }
        pendingFrames.forEach((incoming, id) => {
          const merged = [...(next[id] ?? []), ...incoming]
          if (merged.length > MAX_FRAMES) merged.splice(0, merged.length - MAX_FRAMES)
          next[id] = merged
        })
        patch.framesBySession = next
      }
      if (pendingLogs.size > 0) {
        const next = { ...s.httpLogsBySession }
        pendingLogs.forEach((incoming, id) => {
          const merged = [...(next[id] ?? []), ...incoming]
          if (merged.length > MAX_FRAMES) merged.splice(0, merged.length - MAX_FRAMES)
          next[id] = merged
        })
        patch.httpLogsBySession = next
      }
      return patch
    })
  }
  rafHandle = requestAnimationFrame(run)
  timerHandle = setTimeout(run, BACKGROUND_FLUSH_MS)
}


export const useStore = create<State>((set, get) => ({
  sessions: [],
  framesBySession: {},
  peersBySession: {},
  httpLogsBySession: {},
  modbusValues: {},
  slaveValues: {},
  activeId: null,
  initialized: false,
  sessionsLoaded: false,

  init: () => {
    if (get().initialized) return
    set({ initialized: true })

    // 关窗/刷新/切走前把还没发出去的配置写掉，否则最后 280ms 内的编辑会丢
    window.addEventListener('beforeunload', () => flushWrites())
    window.addEventListener('blur', () => flushWrites())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushWrites()
    })

    window.toolbox.onEvent((event) => {
      if (event.type === 'frame') {
        const { sessionId } = event.frame
        /*
          告警判定放在入队之前：此刻这一帧还没有任何持有者，可以就地打标记；
          等它进了 React 状态再回头改，就得复制整条报文数组重新渲染一次。
          规则为空时 annotateFrame 第一行即返回，没配告警的用户不承担成本。
        */
        const owner = get().sessions.find((x) => x.id === sessionId)
        if (owner) annotateFrame(event.frame, owner.kind, owner.name)
        const buf = frameBuffer.get(sessionId)
        if (buf) buf.push(event.frame)
        else frameBuffer.set(sessionId, [event.frame])
        scheduleFlush(set)
      } else if (event.type === 'status') {
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === event.sessionId ? { ...x, status: event.status } : x
          )
        }))
      } else if (event.type === 'metrics') {
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === event.sessionId ? { ...x, metrics: event.metrics } : x
          )
        }))
      } else if (event.type === 'httpLog') {
        const { sessionId } = event.log
        const buf = logBuffer.get(sessionId)
        if (buf) buf.push(event.log)
        else logBuffer.set(sessionId, [event.log])
        scheduleFlush(set)
      } else if (event.type === 'modbusValues') {
        // 点位值按 pointId 覆盖式合并：轮询高频，只保留最新一次
        set((s) => {
          const cur = s.modbusValues[event.sessionId] ?? {}
          const next = { ...cur }
          for (const v of event.values) next[v.pointId] = v
          return { modbusValues: { ...s.modbusValues, [event.sessionId]: next } }
        })
      } else if (event.type === 'modbusSlaveValues') {
        // 与点位值同理：从站每 120ms 推一次全区快照，按 regionId 覆盖
        set((s) => {
          const cur = s.slaveValues[event.sessionId] ?? {}
          const next = { ...cur }
          for (const r of event.regions) next[r.regionId] = r
          return { slaveValues: { ...s.slaveValues, [event.sessionId]: next } }
        })
      } else if (event.type === 'peer') {
        set((s) => {
          const list = s.peersBySession[event.sessionId] ?? []
          const next = event.connected
            ? [...list, event.peer]
            : list.filter((p) => p.id !== event.peer.id)
          return { peersBySession: { ...s.peersBySession, [event.sessionId]: next } }
        })
      }
    })

    window.toolbox.listSessions().then((sessions) => {
      const frames: Record<string, Frame[]> = {}
      const peers: Record<string, Peer[]> = {}
      const logs: Record<string, HttpLogEntry[]> = {}
      for (const s of sessions) {
        frames[s.id] = []
        peers[s.id] = []
        logs[s.id] = []
      }
      set((state) => ({
        sessions,
        sessionsLoaded: true,
        framesBySession: { ...frames, ...state.framesBySession },
        peersBySession: { ...peers, ...state.peersBySession },
        httpLogsBySession: { ...logs, ...state.httpLogsBySession },
        activeId: state.activeId ?? (sessions[0]?.id ?? null)
      }))
    })
  },

  setActive: (id) => set({ activeId: id }),

  createSession: async (kind, name, config, autoStart, meta) => {
    const session = await window.toolbox.createSession({
      kind,
      name,
      config,
      autoStart,
      group: meta?.group,
      tags: meta?.tags
    })
    set((s) => ({
      sessions: [...s.sessions, session],
      activeId: session.id,
      framesBySession: { ...s.framesBySession, [session.id]: [] },
      peersBySession: { ...s.peersBySession, [session.id]: [] },
      httpLogsBySession: { ...s.httpLogsBySession, [session.id]: [] }
    }))
  },

  duplicateSession: async (id) => {
    const src = get().sessions.find((x) => x.id === id)
    if (!src) return
    // 复制配置本体，名称加「副本」后缀；副本默认不自动连接，避免端口冲突
    const cfg = JSON.parse(JSON.stringify(src.config)) as SessionConfig
    /*
      MQTT 的 clientId 必须换。

      Broker 按 clientId 识别会话：两条链路用同一个 id 连上来时，后连的会把
      先连的踢掉，被踢的那条按自动重连接着连，于是两条链路互相踢，
      日志上就是「连上→断开→连上→断开」无限循环。端口可以冲突（最多起不来），
      clientId 冲突则是两条都能连上然后持续互踢，更难排查。
    */
    if (cfg.mqtt) {
      cfg.mqtt = {
        ...cfg.mqtt,
        clientId: 'flowprobe-' + Math.random().toString(16).slice(2, 10)
      }
    }
    // 分组与标签一并带过去，副本天然落在同一分组里
    await get().createSession(src.kind, src.name + ' 副本', cfg, false, {
      group: src.group,
      tags: src.tags ? [...src.tags] : []
    })
  },

  renameSession: (id, name) => {
    window.toolbox.renameSession(id, name)
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x)) }))
  },
  setSessionMeta: (id, patch) => {
    window.toolbox.setSessionMeta(id, patch)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? {
              ...x,
              group: typeof patch.group === 'string' ? patch.group.trim() : x.group,
              tags: Array.isArray(patch.tags)
                ? [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))]
                : x.tags
            }
          : x
      )
    }))
  },
  updateSessionConfig: (id, cfg) => {
    window.toolbox.updateSessionConfig(id, cfg)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, config: { ...x.config, ...cfg }, status: 'idle' } : x
      )
    }))
  },
  setAutoStart: (id, on) => {
    window.toolbox.setSessionAutoStart(id, on)
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, autoStart: on } : x)) }))
  },

  start: (id) => window.toolbox.startSession(id),
  stop: (id) => window.toolbox.stopSession(id),

  remove: (id) => {
    const target = get().sessions.find((x) => x.id === id)
    if (!target) return
    /*
      删除是不可逆的：会话配置会从工作区移除，下次启动不再恢复。
      历史库里的报文仍然保留（可在「报文历史」检索），这一点写进提示里，
      否则用户会以为连历史也一起没了而不敢删。
    */
    if (
      !window.confirm(
        `删除会话「${target.name}」？\n\n会话配置会从工作区移除；已采集的报文仍保留在本地历史库，可在「报文历史」中检索。`
      )
    ) {
      return
    }
    cancelWrite('mock:' + id)
    cancelWrite('httpMock:' + id)
    window.toolbox.removeSession(id)
    frameBuffer.delete(id)
    logBuffer.delete(id)
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      const frames = { ...s.framesBySession }
      const peers = { ...s.peersBySession }
      const logs = { ...s.httpLogsBySession }
      delete frames[id]
      delete peers[id]
      delete logs[id]
      return {
        sessions,
        framesBySession: frames,
        peersBySession: peers,
        httpLogsBySession: logs,
        activeId: s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId
      }
    })
  },

  send: (frame) => {
    window.toolbox.sendFrame(frame)
    // 在某个会话里真的发过报文，说明它不再是「随手点开看看」，
    // 把预览标签提升为常驻，免得下次点别的会话时被顶掉。
    // 放在 store 层而不是发送按钮里：MQTT 发布、Modbus 写寄存器、
    // 报文片段都走这一个出口，逐个补容易漏。
    useTabs.getState().pin(frame.sessionId)
  },
  kickPeer: (id, peerId) => window.toolbox.kickPeer(id, peerId),
  updateMock: (id, cfg) => {
    scheduleWrite('mock:' + id, () => window.toolbox.updateMock(id, cfg))
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, config: { ...x.config, mock: cfg } } : x
      )
    }))
  },
  updateHttpMock: (id, cfg) => {
    scheduleWrite('httpMock:' + id, () => window.toolbox.updateHttpMock(id, cfg))
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, config: { ...x.config, httpMock: cfg } } : x
      )
    }))
  },

  clearFrames: (id) => {
    // 同时丢掉尚未刷入的缓冲，否则清屏后又被回填
    frameBuffer.delete(id)
    set((s) => ({ framesBySession: { ...s.framesBySession, [id]: [] } }))
  },
  clearHttpLogs: (id) => {
    logBuffer.delete(id)
    set((s) => ({ httpLogsBySession: { ...s.httpLogsBySession, [id]: [] } }))
  },

  updateMqttSubs: (id, subs) => {
    window.toolbox.mqttUpdateSubs(id, subs)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id && x.config.mqtt
          ? { ...x, config: { ...x.config, mqtt: { ...x.config.mqtt, subscriptions: subs } } }
          : x
      )
    }))
  },

  updateModbusPoints: (id, points) => {
    window.toolbox.modbusUpdatePoints(id, points)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id && x.config.modbus
          ? { ...x, config: { ...x.config, modbus: { ...x.config.modbus, points } } }
          : x
      )
    }))
  },

  updateSlaveRegions: (id, regions) => {
    window.toolbox.modbusSlaveUpdateRegions(id, regions)
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id && x.config.modbusSlave
          ? { ...x, config: { ...x.config, modbusSlave: { ...x.config.modbusSlave, regions } } }
          : x
      )
    }))
  },

  writeSlaveRegister: (id, area, addr, value) => {
    // 不在本地乐观更新：值是否落得下去取决于该地址是否已定义，
    // 由主进程判定后统一推回来，避免界面显示一个实际没生效的数
    window.toolbox.modbusSlaveWrite(id, area, addr, value)
  },

  injectFrame: (frame) => {
    // 复用真实报文的合批通道，回放高频录制时同样不会逐帧重渲染
    const buf = frameBuffer.get(frame.sessionId)
    if (buf) buf.push(frame)
    else frameBuffer.set(frame.sessionId, [frame])
    scheduleFlush(set)
  }
}))
