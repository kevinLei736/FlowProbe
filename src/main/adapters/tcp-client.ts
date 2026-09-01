import * as net from 'node:net'
import type { ConnectionKind, OutgoingFrame, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { FrameSplitter, encodeContent } from '../codec/framing'
import { Backoff, formatWait, normalizeBackoff } from './reconnect'

export class TcpClientAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'tcp-client'
  private socket: net.Socket | null = null
  private splitter: FrameSplitter | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private backoff: Backoff
  private manualStop = false
  /** 本轮是否已经建立过连接：用于区分「首次连不上」与「连上后掉线」 */
  private everConnected = false

  constructor(id: string, config: SessionConfig) {
    super(id, config)
    this.backoff = new Backoff(normalizeBackoff(config))
  }

  async start(): Promise<void> {
    this.manualStop = false
    this.everConnected = false
    this.backoff.update(normalizeBackoff(this.config))
    this.backoff.reset()
    this.connect()
  }

  private connect(): void {
    const host = String(this.config.host ?? '127.0.0.1')
    const port = Number(this.config.port ?? 0)
    this.emitStatus('connecting', `正在连接 ${host}:${port}`)

    const socket = new net.Socket()
    this.socket = socket
    socket.setNoDelay(this.config.noDelay !== false)
    if (this.config.keepAlive) socket.setKeepAlive(true)

    const timeout = Number(this.config.connectTimeoutMs ?? 5000)
    const timer = setTimeout(() => {
      if (socket.connecting) socket.destroy(new Error('连接超时'))
    }, timeout)

    this.splitter = new FrameSplitter(
      this.config.framing ?? { mode: 'none' },
      (frame) => {
        this.emitData('rx', frame, 'hex')
        void this.runMock(frame, (bytes) => this.socket?.write(bytes))
      }
    )

    socket.connect(port, host, () => {
      clearTimeout(timer)
      const retried = this.backoff.attempts
      this.backoff.reset()
      this.everConnected = true
      this.emitStatus('connected', `已连接 ${host}:${port}`)
      this.emitConn(
        `已连接到 ${host}:${port}` + (retried > 0 ? `（重连第 ${retried} 次后成功）` : ''),
        'success'
      )
      this.startHeartbeat()
    })

    socket.on('data', (chunk: Buffer) => {
      const frames = this.splitter!.push(chunk)
      for (const f of frames) {
        this.emitData('rx', f, 'hex')
        void this.runMock(f, (bytes) => this.socket?.write(bytes))
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      this.emitError(err.message)
    })

    socket.on('close', () => {
      clearTimeout(timer)
      this.stopHeartbeat()
      if (this.manualStop) {
        this.emitStatus('closed', '连接已关闭')
        this.emitConn('连接已关闭（手动停止）', 'info')
      } else {
        this.emitStatus('closed', '连接断开')
        this.emitConn(this.everConnected ? '连接断开' : '连接未建立', 'warn')
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    if (!this.config.autoReconnect || this.manualStop) return
    const planned = this.backoff.schedule(() => this.connect())
    if (!planned) {
      const limit = normalizeBackoff(this.config).maxAttempts
      this.emitConn(`已重连 ${limit} 次仍未成功，停止重连`, 'error')
      this.emitStatus('error', '重连次数已用尽')
      return
    }
    this.emitConn(
      `第 ${planned.attempt} 次重连将在 ${formatWait(planned.delayMs)} 后开始`,
      'warn'
    )
  }

  private startHeartbeat(): void {
    if (!this.config.heartbeatEnabled) return
    const interval = Number(this.config.heartbeatIntervalMs ?? 5000)
    this.heartbeatTimer = setInterval(() => {
      const enc = this.config.heartbeatEncoding ?? 'utf8'
      const content = String(this.config.heartbeatContent ?? '')
      if (!content) return
      const bytes = encodeContent(content, enc)
      this.socket?.write(bytes)
      this.emitData('tx', bytes, enc)
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  async send(out: OutgoingFrame): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      this.emitError('未连接，无法发送')
      return
    }
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    this.socket.write(bytes)
    this.emitData('tx', bytes, out.encoding)
  }

  async stop(): Promise<void> {
    this.manualStop = true
    this.backoff.cancel()
    this.stopHeartbeat()
    this.splitter?.dispose()
    this.socket?.destroy()
    this.socket = null
  }
}
