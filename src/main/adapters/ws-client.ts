import WebSocket from 'ws'
import type { ConnectionKind, OutgoingFrame, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { encodeContent } from '../codec/framing'
import { Backoff, formatWait, normalizeBackoff } from './reconnect'
import { describeConnectError } from './net-error'

export class WsClientAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'ws-client'
  private ws: WebSocket | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private backoff: Backoff
  private manualStop = false
  private everConnected = false

  constructor(id: string, config: SessionConfig) {
    super(id, config)
    this.backoff = new Backoff(normalizeBackoff(config))
  }

  async start(): Promise<void> {
    // 已连接或正在连接时忽略重复启动
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return
    }
    this.manualStop = false
    this.everConnected = false
    this.backoff.update(normalizeBackoff(this.config))
    this.backoff.reset()
    // 与 TCP / MQTT 一致：重复启动先拆旧链路，避免遗留连接继续驱动重连
    this.teardown()
    this.connect()
  }

  private connect(): void {
    const url = String(this.config.url ?? '')
    if (!url) {
      this.emitError('URL 为空')
      this.emitStatus('error', 'URL 为空')
      return
    }
    this.emitStatus('connecting', `正在连接 ${url}`)

    const opts: WebSocket.ClientOptions = {
      rejectUnauthorized: this.config.rejectUnauthorized !== false
    }
    if (this.config.headers) opts.headers = this.config.headers
    if (this.config.origin) opts.origin = String(this.config.origin)
    const protocols = this.config.subProtocols?.filter(Boolean)

    const ws = protocols && protocols.length
      ? new WebSocket(url, protocols, opts)
      : new WebSocket(url, opts)
    this.ws = ws
    const current = (): boolean => this.ws === ws

    ws.on('open', () => {
      if (!current()) return
      const retried = this.backoff.attempts
      this.backoff.reset()
      this.everConnected = true
      this.emitStatus('connected', `已连接 ${url}`)
      this.emitConn(
        `WebSocket 已连接 ${url}${ws.protocol ? ` (子协议: ${ws.protocol})` : ''}` +
          (retried > 0 ? `（重连第 ${retried} 次后成功）` : ''),
        'success'
      )
      this.startPing()
    })
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!current()) return
      const buf = toBuffer(data)
      this.emitData('rx', buf, isBinary ? 'hex' : 'utf8')
      void this.runMock(buf, (bytes) => {
        const bin = this.config.wsSendMode === 'binary' || isBinary
        this.ws?.send(bin ? bytes : bytes.toString('utf8'), { binary: bin })
      })
    })
    ws.on('ping', () => {
      if (current()) this.emitSystem('收到 Ping')
    })
    ws.on('pong', () => {
      if (current()) this.emitSystem('收到 Pong')
    })
    ws.on('error', (err: Error) => {
      if (!current()) return
      this.emitError(describeConnectError(err, url))
    })
    ws.on('close', (code: number, reason: Buffer) => {
      if (!current()) return
      this.stopPing()
      this.ws = null
      const r = reason?.toString() || ''
      this.emitStatus('closed', `连接关闭 code=${code}`)
      if (this.manualStop) {
        this.emitConn(`连接已关闭（手动停止）code=${code}${r ? ` reason=${r}` : ''}`, 'info')
        return
      }
      this.emitConn(
        (this.everConnected ? '连接关闭' : '连接未建立') +
          ` code=${code}${r ? ` reason=${r}` : ''}`,
        'warn'
      )
      this.scheduleReconnect()
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
    this.emitConn(`第 ${planned.attempt} 次重连将在 ${formatWait(planned.delayMs)} 后开始`, 'warn')
  }

  private startPing(): void {
    const interval = Number(this.config.pingIntervalMs ?? 0)
    if (interval <= 0) return
    // 重连成功会再调一次；先清掉旧定时器，避免 Ping 频率翻倍
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
        this.emitSystem('发送 Ping')
      }
    }, interval)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  async send(out: OutgoingFrame): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emitError('未连接，无法发送')
      return
    }
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    const binary = this.config.wsSendMode === 'binary' || out.encoding !== 'utf8'
    this.ws.send(binary ? bytes : bytes.toString('utf8'), { binary })
    this.emitData('tx', bytes, out.encoding)
  }

  async stop(): Promise<void> {
    this.manualStop = true
    this.backoff.cancel()
    const wasOpen = this.ws !== null
    this.teardown()
    if (wasOpen) {
      this.emitStatus('closed', '连接已关闭')
      this.emitConn('连接已关闭（手动停止）', 'info')
    }
  }

  private teardown(): void {
    this.stopPing()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      try {
        ws.terminate()
      } catch {
        // 忽略关闭异常
      }
    }
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data as ArrayBuffer)
}
