import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { MockEngine, defaultMockConfig } from '../mock/engine'
import type {
  ConnectionKind,
  MockConfig,
  Direction,
  Encoding,
  Frame,
  FrameMeta,
  OutgoingFrame,
  Peer,
  SessionConfig,
  SessionEvent,
  SessionMetrics,
  SessionStatus,
  SystemLevel
} from '@shared/protocol'

export interface AdapterEvents {
  event: (event: SessionEvent) => void
}

/**
 * 所有协议适配器的统一基类。
 * 子类实现 start/stop/send，基类提供 事件发射 / 指标累计 / 帧构建 工具。
 */
export abstract class BaseAdapter extends EventEmitter {
  readonly id: string
  abstract readonly kind: ConnectionKind
  protected metrics: SessionMetrics = {
    txBytes: 0,
    rxBytes: 0,
    txFrames: 0,
    rxFrames: 0,
    peers: 0
  }

  constructor(
    id: string,
    protected config: SessionConfig
  ) {
    super()
    this.id = id
  }

  protected mock = new MockEngine(defaultMockConfig())

  initMock(cfg?: MockConfig): void {
    this.mock.update(cfg ?? defaultMockConfig())
  }

  updateMock(cfg: MockConfig): void {
    this.mock.update(cfg)
    this.emitSystem(`Mock 配置已更新（${cfg.enabled ? '启用' : '停用'}，规则 ${cfg.rules.length} 条）`)
  }

  /**
   * 收到数据后调用：若 Mock 命中则按延迟自动应答。
   * reply 由各适配器提供（客户端写回连接、服务端写回该 peer）。
   * 返回 true 表示已被 Mock 处理。
   */
  protected async runMock(
    incoming: Buffer,
    reply: (bytes: Buffer, encoding: import('@shared/protocol').Encoding, peer?: { id: string; label: string }) => void,
    peer?: { id: string; label: string }
  ): Promise<boolean> {
    if (!this.mock.isEnabled()) return false
    const result = this.mock.handle(incoming)
    if (!result) {
      // 命中丢包或无规则：是否回显由 fallthrough 决定
      return this.mock.fallthrough() ? false : true
    }
    const doReply = (): void => {
      if (result.bytes.length === 0) return
      reply(result.bytes, result.encoding, peer)
      this.emitData('tx', result.bytes, result.encoding, peer)
      this.emitSystem(`Mock 命中「${result.ruleName}」自动应答`)
    }
    if (result.delayMs > 0) setTimeout(doReply, result.delayMs)
    else doReply()
    return true
  }

  abstract start(): Promise<void>
  abstract stop(): Promise<void>
  abstract send(out: OutgoingFrame): Promise<void>

  listPeers(): Peer[] {
    return []
  }

  kickPeer(_peerId: string): void {
    // 默认无操作，服务端适配器覆盖
  }

  // —— 供子类使用的工具 ——
  protected emitStatus(status: SessionStatus, detail?: string): void {
    this.emit('event', { type: 'status', sessionId: this.id, status, detail })
  }

  protected emitError(message: string): void {
    this.emit('event', { type: 'error', sessionId: this.id, message })
  }

  protected emitPeer(peer: Peer, connected: boolean): void {
    if (connected) this.metrics.peers += 1
    else this.metrics.peers = Math.max(0, this.metrics.peers - 1)
    this.emit('event', { type: 'peer', sessionId: this.id, peer, connected })
    this.pushMetrics()
  }

  /** 供子类直接投递自定义事件（如 Modbus 点位值、MQTT SUBACK） */
  protected emitRaw(event: SessionEvent): void {
    this.emit('event', event)
  }

  protected emitSystem(text: string, level: SystemLevel = 'info'): void {
    const frame: Frame = {
      id: randomUUID(),
      sessionId: this.id,
      direction: 'system',
      ts: Date.now(),
      size: 0,
      encoding: 'utf8',
      rawBase64: '',
      text,
      level
    }
    this.emit('event', { type: 'frame', frame })
  }

  /**
   * 连接生命周期日志：连接建立、断开、重连预告、放弃重连。
   * 单独标记出来，界面可以只看这一类，快速回溯「什么时候断的」。
   */
  protected emitConn(text: string, level: SystemLevel = 'info'): void {
    const frame: Frame = {
      id: randomUUID(),
      sessionId: this.id,
      direction: 'system',
      ts: Date.now(),
      size: 0,
      encoding: 'utf8',
      rawBase64: '',
      text,
      level,
      conn: true
    }
    this.emit('event', { type: 'frame', frame })
  }

  /**
   * 发出一帧数据。
   * meta 用于携带协议专属信息（MQTT 主题、Modbus 功能码等），
   * 这样新协议接入不需要在 Frame 上加字段、也不用改历史库结构。
   */
  protected emitData(
    direction: Exclude<Direction, 'system'>,
    bytes: Buffer,
    encoding: Encoding,
    peer?: { id: string; label: string },
    meta?: FrameMeta
  ): void {
    if (direction === 'tx') {
      this.metrics.txBytes += bytes.length
      this.metrics.txFrames += 1
    } else {
      this.metrics.rxBytes += bytes.length
      this.metrics.rxFrames += 1
    }
    const frame: Frame = {
      id: randomUUID(),
      sessionId: this.id,
      direction,
      peerId: peer?.id,
      peerLabel: peer?.label,
      ts: Date.now(),
      size: bytes.length,
      encoding,
      rawBase64: bytes.toString('base64'),
      text: encoding === 'hex' ? bytes.toString('hex') : bytes.toString('utf8'),
      ...(meta ? { meta } : {})
    }
    this.emit('event', { type: 'frame', frame })
    this.pushMetrics()
  }

  protected pushMetrics(): void {
    this.emit('event', { type: 'metrics', sessionId: this.id, metrics: { ...this.metrics } })
  }

  getMetrics(): SessionMetrics {
    return { ...this.metrics }
  }
}
