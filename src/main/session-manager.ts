import { randomUUID } from 'node:crypto'
import {
  type CreateSessionRequest,
  type OutgoingFrame,
  type Peer,
  type Session,
  type SessionEvent,
  type MockConfig,
  type HttpMockConfig,
  type SessionConfig,
  type SessionMetaPatch,
  type MqttSubscription,
  type ModbusPoint,
  type ModbusPointValue,
  type ModbusArea,
  type ModbusSlaveRegion,
  type ModbusSlaveRegionValues
} from '@shared/protocol'
import { BaseAdapter } from './adapters/base'
import { TcpClientAdapter } from './adapters/tcp-client'
import { TcpServerAdapter } from './adapters/tcp-server'
import { UdpClientAdapter } from './adapters/udp-client'
import { UdpServerAdapter } from './adapters/udp-server'
import { SerialAdapter } from './adapters/serial'
import { WsClientAdapter } from './adapters/ws-client'
import { WsServerAdapter } from './adapters/ws-server'
import { LoopbackAdapter } from './adapters/loopback'
import { MqttClientAdapter, defaultMqttConfig } from './adapters/mqtt-client'
import { ModbusAdapter } from './adapters/modbus'
import { ModbusSlaveAdapter } from './adapters/modbus-slave'
import { defaultModbusConfig } from './modbus/pdu'
import { defaultSlaveConfig } from './modbus/slave'
import { HttpMockAdapter } from './adapters/http-mock'
import { defaultHttpMockConfig } from './http-mock/engine'
import { loadWorkspace, saveWorkspace, type PersistedSession } from './persistence'
import { HistoryStore } from './history/store'

type Emit = (event: SessionEvent) => void

interface Entry {
  session: Session
  adapter: BaseAdapter
}

export class SessionManager {
  private entries = new Map<string, Entry>()
  /** 报文历史落库。渲染层内存只保留最近 5 万条，长期历史由它承接。 */
  readonly history = new HistoryStore()

  constructor(private emit: Emit) {}

  /** 应用启动时初始化历史库。失败不影响其他功能。 */
  initHistory(): void {
    this.history.init()
  }

  create(req: CreateSessionRequest): Session {
    const session = this.createInternal(req)
    this.persist()
    this.syncHistorySnapshots()
    return session
  }

  /** 内部创建：不触发落盘，供批量恢复复用 */
  private createInternal(req: CreateSessionRequest): Session {
    const id = req.id ?? randomUUID()
    const session: Session = {
      id,
      kind: req.kind,
      name: req.name,
      status: 'idle',
      config: req.config ?? {},
      createdAt: Date.now(),
      metrics: { txBytes: 0, rxBytes: 0, txFrames: 0, rxFrames: 0, peers: 0 },
      autoStart: req.autoStart ?? false,
      group: req.group ?? '',
      tags: Array.isArray(req.tags) ? req.tags : []
    }
    // http-mock 会话若未带配置，直接落默认路由+场景，避免主/渲染两侧默认值不一致
    if (req.kind === 'http-mock' && !session.config.httpMock) {
      session.config.httpMock = defaultHttpMockConfig()
      req.config = session.config
    }
    // 同理，MQTT 与 Modbus 的默认配置也在主进程侧补齐，
    // 避免渲染层漏传字段时适配器读到 undefined
    if (req.kind === 'mqtt-client' && !session.config.mqtt) {
      session.config.mqtt = defaultMqttConfig()
      req.config = session.config
    }
    if ((req.kind === 'modbus-tcp' || req.kind === 'modbus-rtu') && !session.config.modbus) {
      session.config.modbus = defaultModbusConfig(req.kind === 'modbus-rtu' ? 'rtu' : 'tcp')
      req.config = session.config
    }
    if (req.kind === 'modbus-slave' && !session.config.modbusSlave) {
      session.config.modbusSlave = defaultSlaveConfig('tcp')
      req.config = session.config
    }
    const adapter = this.buildAdapter(id, req)
    adapter.initMock(req.config?.mock)
    adapter.on('event', (event: SessionEvent) => this.handleEvent(id, event))
    this.entries.set(id, { session, adapter })
    this.emit({
      type: 'frame',
      frame: {
        id: randomUUID(),
        sessionId: id,
        direction: 'system',
        ts: Date.now(),
        size: 0,
        encoding: 'utf8',
        rawBase64: '',
        text: `会话已创建（${req.kind}）`
      }
    })
    return session
  }

  /** 同步会话内存态并转发事件，同时把报文与请求日志投给历史库 */
  private handleEvent(id: string, event: SessionEvent): void {
    const entry = this.entries.get(id)
    if (entry) {
      if (event.type === 'status') entry.session.status = event.status
      if (event.type === 'metrics') entry.session.metrics = event.metrics
    }
    // 回放注入的帧不落库：它不是真实链路数据，入库会污染历史
    if (event.type === 'frame' && event.frame.replay !== true) {
      this.history.recordFrame(event.frame)
    } else if (event.type === 'httpLog') {
      this.history.recordHttpLog(event.log)
    }
    this.emit(event)
  }

  /** 把会话名称/类型/分组快照推给历史库，历史行里冗余这些字段 */
  private syncHistorySnapshots(): void {
    this.history.syncSessions(this.list())
  }

  private buildAdapter(id: string, req: CreateSessionRequest): BaseAdapter {
    switch (req.kind) {
      case 'tcp-client':
        return new TcpClientAdapter(id, req.config)
      case 'tcp-server':
        return new TcpServerAdapter(id, req.config)
      case 'udp-client':
        return new UdpClientAdapter(id, req.config)
      case 'udp-server':
        return new UdpServerAdapter(id, req.config)
      case 'serial':
        return new SerialAdapter(id, req.config)
      case 'ws-client':
        return new WsClientAdapter(id, req.config)
      case 'ws-server':
        return new WsServerAdapter(id, req.config)
      case 'http-mock':
        return new HttpMockAdapter(id, req.config)
      case 'mqtt-client':
        return new MqttClientAdapter(id, req.config)
      case 'modbus-tcp':
      case 'modbus-rtu':
        return new ModbusAdapter(id, req.config, req.kind)
      case 'modbus-slave':
        return new ModbusSlaveAdapter(id, req.config)
      default:
        return new LoopbackAdapter(id, req.config, req.kind)
    }
  }

  list(): Session[] {
    return [...this.entries.values()].map((e) => e.session)
  }

  peers(id: string): Peer[] {
    return this.entries.get(id)?.adapter.listPeers() ?? []
  }

  kickPeer(id: string, peerId: string): void {
    this.entries.get(id)?.adapter.kickPeer(peerId)
  }

  updateMock(id: string, cfg: MockConfig): void {
    const entry = this.entries.get(id)
    if (entry) {
      entry.adapter.updateMock(cfg)
      entry.session.config.mock = cfg
      this.persist()
    }
  }

  /** 重命名会话 */
  rename(id: string, name: string): void {
    const entry = this.entries.get(id)
    if (entry && name.trim()) {
      entry.session.name = name.trim()
      this.persist()
    }
  }

  /**
   * 修改连接参数。运行中的会话会先停止，由调用方决定是否重新启动，
   * 因为多数适配器的参数只在建立连接时生效。
   */
  updateConfig(id: string, config: SessionConfig): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const wasRunning =
      entry.session.status === 'connected' ||
      entry.session.status === 'listening' ||
      entry.session.status === 'connecting'
    if (wasRunning) entry.adapter.stop().catch(() => undefined)

    const merged: SessionConfig = { ...entry.session.config, ...config }
    entry.session.config = merged
    // 适配器参数在构造时固化，重建一个新的
    const adapter = this.buildAdapter(id, {
      kind: entry.session.kind,
      name: entry.session.name,
      config: merged
    })
    adapter.initMock(merged.mock)
    adapter.on('event', (event: SessionEvent) => this.handleEvent(id, event))
    entry.adapter = adapter
    entry.session.status = 'idle'
    this.emit({ type: 'status', sessionId: id, status: 'idle', detail: '参数已更新' })
    this.persist()
  }

  /**
   * 更新会话的组织信息（分组 / 标签）。这类信息不影响链路，
   * 因此只改内存态并落盘，不重建适配器、不打断正在跑的连接。
   */
  setMeta(id: string, patch: SessionMetaPatch): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (typeof patch.group === 'string') entry.session.group = patch.group.trim()
    if (Array.isArray(patch.tags)) {
      const seen = new Set<string>()
      const tags: string[] = []
      for (const raw of patch.tags) {
        const t = String(raw).trim()
        if (!t || seen.has(t)) continue
        seen.add(t)
        tags.push(t)
      }
      entry.session.tags = tags
    }
    this.persist()
  }

  /** 设置是否随应用启动自动连接 */
  setAutoStart(id: string, autoStart: boolean): void {
    const entry = this.entries.get(id)
    if (entry) {
      entry.session.autoStart = autoStart
      this.persist()
    }
  }

  /** 更新 MQTT 订阅表：只做增量订阅/退订，不断开连接 */
  updateMqttSubs(id: string, subs: MqttSubscription[]): void {
    const entry = this.entries.get(id)
    if (!entry || !(entry.adapter instanceof MqttClientAdapter)) return
    entry.adapter.updateSubscriptions(subs)
    if (entry.session.config.mqtt) entry.session.config.mqtt.subscriptions = subs
    this.persist()
  }

  /** 更新 Modbus 点表：重排轮询计划，不断开链路 */
  updateModbusPoints(id: string, points: ModbusPoint[]): void {
    const entry = this.entries.get(id)
    if (!entry || !(entry.adapter instanceof ModbusAdapter)) return
    entry.adapter.updatePoints(points)
    if (entry.session.config.modbus) entry.session.config.modbus.points = points
    this.persist()
  }

  readModbusPoint(id: string, pointId: string): void {
    const entry = this.entries.get(id)
    if (entry?.adapter instanceof ModbusAdapter) entry.adapter.readPoint(pointId)
  }

  writeModbusPoint(id: string, pointId: string, value: number | boolean): void {
    const entry = this.entries.get(id)
    if (entry?.adapter instanceof ModbusAdapter) entry.adapter.writePoint(pointId, value)
  }

  /** 点位最近值快照，供界面初次渲染点表 */
  modbusValues(id: string): ModbusPointValue[] {
    const entry = this.entries.get(id)
    return entry?.adapter instanceof ModbusAdapter ? entry.adapter.snapshotValues() : []
  }

  // —— Modbus 从站模拟 ——

  /** 数据区定义变更：重建地址空间，不断开监听 */
  updateSlaveRegions(id: string, regions: ModbusSlaveRegion[]): void {
    const entry = this.entries.get(id)
    if (!entry || !(entry.adapter instanceof ModbusSlaveAdapter)) return
    entry.adapter.updateRegions(regions)
    if (entry.session.config.modbusSlave) entry.session.config.modbusSlave.regions = regions
    this.persist()
  }

  /** 界面手动置值（模拟现场量变化） */
  writeSlaveRegister(id: string, area: ModbusArea, addr: number, value: number): void {
    const entry = this.entries.get(id)
    if (entry?.adapter instanceof ModbusSlaveAdapter) entry.adapter.writeRegister(area, addr, value)
  }

  slaveSnapshot(id: string): ModbusSlaveRegionValues[] {
    const entry = this.entries.get(id)
    return entry?.adapter instanceof ModbusSlaveAdapter ? entry.adapter.snapshotRegions() : []
  }

  updateHttpMock(id: string, cfg: HttpMockConfig): void {
    const entry = this.entries.get(id)
    if (entry && entry.adapter instanceof HttpMockAdapter) {
      entry.adapter.updateHttpMock(cfg)
      entry.session.config.httpMock = cfg
      this.persist()
    }
  }

  start(id: string): void {
    this.entries.get(id)?.adapter.start().catch((e) =>
      this.emit({ type: 'error', sessionId: id, message: String(e?.message ?? e) })
    )
  }

  stop(id: string): void {
    this.entries.get(id)?.adapter.stop().catch(() => undefined)
  }

  remove(id: string): void {
    const entry = this.entries.get(id)
    if (entry) {
      entry.adapter.stop().catch(() => undefined)
      this.entries.delete(id)
      this.persist()
    }
  }

  send(out: OutgoingFrame): void {
    this.entries.get(out.sessionId)?.adapter.send(out).catch((e) =>
      this.emit({ type: 'error', sessionId: out.sessionId, message: String(e?.message ?? e) })
    )
  }

  /** 把当前会话清单落盘（仅配置，不含报文与指标） */
  private persist(): void {
    this.syncHistorySnapshots()
    const sessions: PersistedSession[] = [...this.entries.values()].map((e) => ({
      id: e.session.id,
      kind: e.session.kind,
      name: e.session.name,
      config: e.session.config,
      autoStart: e.session.autoStart ?? false,
      group: e.session.group ?? '',
      tags: e.session.tags ?? [],
      createdAt: e.session.createdAt
    }))
    saveWorkspace(sessions)
  }

  /**
   * 从工作区文件恢复会话。返回恢复出的会话列表。
   * 标记了 autoStart 的会话会尝试自动启动，单个失败不影响其余。
   */
  restore(): Session[] {
    const saved = loadWorkspace()
    const restored: Session[] = []
    for (const item of saved) {
      try {
        const session = this.createInternal({
          id: item.id,
          kind: item.kind,
          name: item.name,
          config: item.config ?? {},
          autoStart: item.autoStart,
          group: item.group,
          tags: item.tags
        })
        restored.push(session)
      } catch {
        // 单个会话恢复失败时跳过，不影响其他会话
      }
    }
    // 创建完成后再统一自启，避免端口竞争时序问题
    this.syncHistorySnapshots()
    for (const session of restored) {
      if (session.autoStart) this.start(session.id)
    }
    return restored
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) entry.adapter.stop().catch(() => undefined)
    this.entries.clear()
    // 退出前把缓冲落盘并关库，否则最后一批报文会丢
    this.history.dispose()
  }
}
