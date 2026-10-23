import * as dgram from 'node:dgram'
import type { ConnectionKind, OutgoingFrame, Peer, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { encodeContent } from '../codec/framing'
import { describeConnectError } from './net-error'

/**
 * UDP 客户端。
 *
 * 为什么不复用 TCP 客户端那套骨架：
 * 1) 不接 FrameSplitter —— dgram 的一次 message 事件本身就是一个完整数据报，
 *    再套「按分隔符/按长度」拆包只会把正确的边界切碎（同 M28.1 里 WebSocket
 *    不该有结束符的道理）。
 * 2) 不接 Backoff 重连 —— UDP 没有连接，socket 建好就能收发，没有「断线」这件事，
 *    重连逻辑在这里是空转。
 * 3) 状态语义 —— 仍然沿用 connected，但含义是「socket 已就绪」，
 *    因此启动时会在系统日志里说明清楚，避免用户误以为对端已确认在线。
 */
export class UdpClientAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'udp-client'
  private socket: dgram.Socket | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  /** 最近一次回包的来源，供界面显示「谁在应答」 */
  private lastPeer: Peer | null = null

  constructor(id: string, config: SessionConfig) {
    super(id, config)
  }

  async start(): Promise<void> {
    // 已有套接字（绑定中或已就绪）时忽略重复启动，避免遗留一个没人管的旧 socket
    if (this.socket) return
    const host = String(this.config.host ?? '127.0.0.1')
    const port = Number(this.config.port ?? 0)
    this.emitStatus('connecting', `正在准备 UDP 套接字 → ${host}:${port}`)

    const socket = dgram.createSocket({
      type: 'udp4',
      reuseAddr: this.config.udpReuseAddr === true
    })
    this.socket = socket

    socket.on('error', (err) => {
      const msg = describeConnectError(err, `${host}:${port}`)
      this.emitError(msg)
      this.emitStatus('error', msg)
      // 绑定失败时 socket 不可用；清掉引用，让用户改完参数能重新启动
      let bound = true
      try {
        socket.address()
      } catch {
        bound = false
      }
      if (!bound && this.socket === socket) {
        try {
          socket.close()
        } catch {
          // 忽略关闭异常
        }
        this.socket = null
      }
    })

    socket.on('message', (msg, rinfo) => {
      const label = `${rinfo.address}:${rinfo.port}`
      // UDP 不建连接，来源可能每包不同，所以 peer 用地址即时派生而非维护会话
      const peer: Peer = { id: label, label, connectedAt: Date.now() }
      this.lastPeer = peer
      const bytes = Buffer.from(msg)
      this.emitData('rx', bytes, 'hex', peer)
      void this.runMock(
        bytes,
        (out) => socket.send(out, rinfo.port, rinfo.address),
        peer
      )
    })

    const bindPort = Number(this.config.udpBindPort ?? 0)
    const bindHost = String(this.config.udpBindHost ?? '0.0.0.0')
    socket.bind(bindPort, bindHost, () => {
      try {
        if (this.config.udpBroadcast) socket.setBroadcast(true)
        const group = String(this.config.udpMulticastGroup ?? '').trim()
        if (group) {
          socket.setMulticastTTL(Number(this.config.udpTtl ?? 1))
          socket.addMembership(group)
          this.emitSystem(`已加入组播组 ${group}（TTL ${Number(this.config.udpTtl ?? 1)}）`)
        }
      } catch (err) {
        this.emitError(`组播/广播设置失败：${(err as Error).message}`)
      }
      const local = socket.address()
      this.emitStatus('connected', `就绪，默认目标 ${host}:${port}`)
      this.emitConn(
        `UDP 套接字已就绪，本地 ${local.address}:${local.port}，默认目标 ${host}:${port}（UDP 无连接，此状态仅表示可收发）`,
        'success'
      )
      this.startHeartbeat()
    })
  }

  private startHeartbeat(): void {
    if (!this.config.heartbeatEnabled) return
    const interval = Number(this.config.heartbeatIntervalMs ?? 5000)
    this.heartbeatTimer = setInterval(() => {
      const enc = this.config.heartbeatEncoding ?? 'utf8'
      const content = String(this.config.heartbeatContent ?? '')
      if (!content) return
      const bytes = encodeContent(content, enc)
      this.writeTo(bytes)
      this.emitData('tx', bytes, enc)
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private writeTo(bytes: Buffer, target?: string): void {
    if (!this.socket) return
    let host = String(this.config.host ?? '127.0.0.1')
    let port = Number(this.config.port ?? 0)
    if (target) {
      // 「回给最近应答方」的场景：target 形如 ip:port
      const idx = target.lastIndexOf(':')
      if (idx > 0) {
        host = target.slice(0, idx)
        port = Number(target.slice(idx + 1))
      }
    }
    this.socket.send(bytes, port, host, (err) => {
      if (err) this.emitError(err.message)
    })
  }

  async send(out: OutgoingFrame): Promise<void> {
    if (!this.socket) {
      this.emitError('套接字未就绪，无法发送')
      return
    }
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    const target = out.target || undefined
    this.writeTo(bytes, target)
    const peer = target ? { id: target, label: target } : undefined
    this.emitData('tx', bytes, out.encoding, peer)
  }

  listPeers(): Peer[] {
    return this.lastPeer ? [this.lastPeer] : []
  }

  async stop(): Promise<void> {
    this.stopHeartbeat()
    const socket = this.socket
    this.socket = null
    this.lastPeer = null
    if (socket) {
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    this.emitStatus('closed', '套接字已关闭')
    this.emitConn('UDP 套接字已关闭', 'info')
  }
}
