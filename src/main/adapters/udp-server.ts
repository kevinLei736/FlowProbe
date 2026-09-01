import * as dgram from 'node:dgram'
import type { ConnectionKind, OutgoingFrame, Peer, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { encodeContent } from '../codec/framing'

interface UdpPeer {
  peer: Peer
  address: string
  port: number
  /** 最近一次收到该地址数据报的时间，淘汰判据 */
  lastSeen: number
}

/**
 * UDP 服务端（绑定端口收包，可回指定对端或广播给所有已知对端）。
 *
 * 与 TCP 服务端最大的不同在「对端」这件事上：TCP 有 connection/close 事件，
 * peer 列表能精确对应活跃连接；UDP 只有一个个孤立的数据报，
 * 因此这里的 peer 是「按 ip:port 派生的发件人档案」，靠空闲超时淘汰。
 * kickPeer 也只能是「从列表移除」——协议上没有任何办法阻止对方继续发包。
 *
 * 同样不接 FrameSplitter：数据报边界即帧边界，再拆一次是错的。
 */
export class UdpServerAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'udp-server'
  private socket: dgram.Socket | null = null
  private peers = new Map<string, UdpPeer>()
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(id: string, config: SessionConfig) {
    super(id, config)
  }

  async start(): Promise<void> {
    const port = Number(this.config.port ?? this.config.udpBindPort ?? 0)
    const host = String(this.config.host ?? this.config.udpBindHost ?? '0.0.0.0')
    this.emitStatus('connecting', `正在绑定 ${host}:${port}`)

    const socket = dgram.createSocket({
      type: 'udp4',
      reuseAddr: this.config.udpReuseAddr !== false
    })
    this.socket = socket

    socket.on('error', (err) => {
      this.emitError(err.message)
      this.emitStatus('error', err.message)
    })

    socket.on('message', (msg, rinfo) => {
      const peer = this.touchPeer(rinfo.address, rinfo.port)
      const bytes = Buffer.from(msg)
      this.emitData('rx', bytes, 'hex', peer)
      void this.runMock(
        bytes,
        (out) => socket.send(out, rinfo.port, rinfo.address),
        peer
      )
    })

    socket.bind(port, host, () => {
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
      this.emitStatus('listening', `监听中 ${local.address}:${local.port}`)
      this.emitConn(`UDP 服务端已绑定 ${local.address}:${local.port}`, 'success')
      this.startSweep()
    })
  }

  /** 收到包就登记/续期发件人；新面孔算一次「接入」，让界面对端列表有东西可看 */
  private touchPeer(address: string, port: number): Peer {
    const key = `${address}:${port}`
    const found = this.peers.get(key)
    if (found) {
      found.lastSeen = Date.now()
      return found.peer
    }
    const peer: Peer = { id: key, label: key, connectedAt: Date.now() }
    this.peers.set(key, { peer, address, port, lastSeen: Date.now() })
    this.emitPeer(peer, true)
    this.emitConn(`发现对端 ${key}`, 'success')
    return peer
  }

  /**
   * 空闲淘汰。默认 60 秒没再发包就从列表移除。
   * 不淘汰的话，一台机器扫过来的成百上千个临时源端口会把对端列表撑爆。
   */
  private startSweep(): void {
    const idle = Number(this.config.udpPeerIdleMs ?? 60000)
    if (idle <= 0) return
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of [...this.peers.entries()]) {
        if (now - entry.lastSeen > idle) {
          this.peers.delete(key)
          this.emitPeer(entry.peer, false)
          this.emitConn(`对端 ${key} 空闲超时，已从列表移除`, 'warn')
        }
      }
    }, Math.max(2000, Math.min(idle, 15000)))
  }

  private stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  listPeers(): Peer[] {
    return [...this.peers.values()].map((p) => p.peer)
  }

  kickPeer(peerId: string): void {
    const entry = this.peers.get(peerId)
    if (!entry) return
    this.peers.delete(peerId)
    this.emitPeer(entry.peer, false)
    // 说清楚语义：UDP 无连接，这里只是不再跟踪，对方仍可继续发包
    this.emitSystem(`已移除对端 ${entry.peer.label}（UDP 无连接，无法真正断开）`, 'warn')
  }

  async send(out: OutgoingFrame): Promise<void> {
    const socket = this.socket
    if (!socket) {
      this.emitError('服务端未启动，无法发送')
      return
    }
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    if (out.target) {
      const entry = this.peers.get(out.target)
      if (!entry) {
        this.emitError('目标对端不存在（可能已空闲超时）')
        return
      }
      socket.send(bytes, entry.port, entry.address, (err) => {
        if (err) this.emitError(err.message)
      })
      this.emitData('tx', bytes, out.encoding, entry.peer)
      return
    }
    if (this.peers.size === 0) {
      this.emitError('尚未收到任何对端数据报，无法确定发送目标')
      return
    }
    for (const entry of this.peers.values()) {
      socket.send(bytes, entry.port, entry.address, (err) => {
        if (err) this.emitError(err.message)
      })
    }
    this.emitData('tx', bytes, out.encoding)
  }

  async stop(): Promise<void> {
    this.stopSweep()
    const socket = this.socket
    this.socket = null
    for (const entry of this.peers.values()) this.emitPeer(entry.peer, false)
    this.peers.clear()
    if (socket) {
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    this.emitStatus('closed', '服务端已停止')
    this.emitConn('UDP 服务端已停止', 'info')
  }
}
