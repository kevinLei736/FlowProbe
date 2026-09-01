import mqtt from 'mqtt'
import type { IClientOptions, MqttClient } from 'mqtt'
import type {
  ConnectionKind,
  MqttConfig,
  MqttSubscription,
  OutgoingFrame,
  SessionConfig
} from '@shared/protocol'
import { BaseAdapter } from './base'
import { encodeContent } from '../codec/framing'
import { Backoff, formatWait, normalizeBackoff } from './reconnect'

/**
 * MQTT 客户端适配器。
 *
 * 两个设计决定：
 * 1. 关掉 mqtt 包自带的 reconnectPeriod，改用项目里统一的指数退避 Backoff。
 *    否则会出现两套重连策略打架，而且库内部重连不会走我们的连接生命周期日志。
 * 2. 收发一律映射为 Frame，主题 / QoS / retain 塞进 frame.meta。
 *    这样报文时间轴、虚拟滚动、历史落库、全局搜索、看板吞吐全部自动生效。
 */
export class MqttClientAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'mqtt-client'
  private client: MqttClient | null = null
  private backoff: Backoff
  private manualStop = false
  private everConnected = false
  /** 已成功订阅的过滤器，重连后据此恢复 */
  private subscribed = new Set<string>()

  constructor(id: string, config: SessionConfig) {
    super(id, config)
    this.backoff = new Backoff(normalizeBackoff(config))
  }

  private get mqttCfg(): MqttConfig {
    return (this.config.mqtt ?? defaultMqttConfig()) as MqttConfig
  }

  async start(): Promise<void> {
    this.manualStop = false
    this.everConnected = false
    this.subscribed.clear()
    this.backoff.update(normalizeBackoff(this.config))
    this.backoff.reset()
    this.connect()
  }

  private buildOptions(cfg: MqttConfig): IClientOptions {
    const opts: IClientOptions = {
      clientId: cfg.clientId || undefined,
      keepalive: Math.max(0, Number(cfg.keepalive ?? 60)),
      clean: cfg.cleanStart !== false,
      protocolVersion: cfg.protocolVersion === 5 ? 5 : 4,
      connectTimeout: Math.max(1000, Number(cfg.connectTimeoutMs ?? 10000)),
      // 重连交给我们自己的 Backoff，库内不要插手
      reconnectPeriod: 0,
      resubscribe: false
    }
    if (cfg.username) opts.username = cfg.username
    if (cfg.password) opts.password = cfg.password
    if (cfg.rejectUnauthorized === false) opts.rejectUnauthorized = false
    if (cfg.servername) opts.servername = cfg.servername
    // 证书按路径读取。读不到就报错并放弃，不静默降级为不校验
    for (const [key, file] of [
      ['ca', cfg.caPath],
      ['cert', cfg.certPath],
      ['key', cfg.keyPath]
    ] as Array<[string, string | undefined]>) {
      if (!file) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const buf = require('node:fs').readFileSync(file) as Buffer
        ;(opts as unknown as Record<string, unknown>)[key] = buf
      } catch (e) {
        this.emitError(`读取 ${key} 证书失败：${String((e as Error)?.message ?? e)}`)
      }
    }
    if (cfg.will?.enabled && cfg.will.topic) {
      opts.will = {
        topic: cfg.will.topic,
        payload: encodeContent(cfg.will.payload ?? '', cfg.will.encoding ?? 'utf8'),
        qos: cfg.will.qos ?? 0,
        retain: Boolean(cfg.will.retain)
      }
    }
    if (opts.protocolVersion === 5) {
      opts.properties = {
        sessionExpiryInterval: Math.max(0, Number(cfg.sessionExpiryInterval ?? 0))
      }
    }
    return opts
  }

  private connect(): void {
    const cfg = this.mqttCfg
    const url = String(cfg.url ?? '').trim()
    if (!url) {
      this.emitError('Broker 地址为空')
      this.emitStatus('error', 'Broker 地址为空')
      return
    }
    this.emitStatus('connecting', `正在连接 ${url}`)

    let client: MqttClient
    try {
      client = mqtt.connect(url, this.buildOptions(cfg))
    } catch (e) {
      this.emitError(String((e as Error)?.message ?? e))
      this.emitStatus('error', '连接创建失败')
      this.scheduleReconnect()
      return
    }
    this.client = client

    client.on('connect', (packet) => {
      const retried = this.backoff.attempts
      this.backoff.reset()
      this.everConnected = true
      const resumed = packet?.sessionPresent ? '（服务端已恢复会话）' : ''
      this.emitStatus('connected', `已连接 ${url}`)
      this.emitConn(
        `MQTT ${cfg.protocolVersion === 5 ? '5.0' : '3.1.1'} 已连接 ${url}` +
          ` clientId=${client.options.clientId}` +
          resumed +
          (retried > 0 ? `（重连第 ${retried} 次后成功）` : ''),
        'success'
      )
      this.applySubscriptions(cfg.subscriptions ?? [])
    })

    client.on('message', (topic, payload, packet) => {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      // 可打印文本按 utf8 展示，二进制载荷落 HEX，避免时间轴出现乱码方块
      const encoding = isMostlyText(buf) ? 'utf8' : 'hex'
      this.emitData('rx', buf, encoding, undefined, {
        topic,
        qos: (packet?.qos ?? 0) as 0 | 1 | 2,
        retain: Boolean(packet?.retain),
        packetId: packet?.messageId,
        userProps: readUserProps(packet?.properties?.userProperties)
      })
    })

    client.on('error', (err: Error) => this.emitError(err.message))

    client.on('disconnect', (packet) => {
      // MQTT 5：服务端主动下发 DISCONNECT，原因码是排障关键信息
      const code = packet?.reasonCode
      const reason = packet?.properties?.reasonString
      this.emitConn(
        `服务端下发 DISCONNECT${code !== undefined ? ` reasonCode=${code}` : ''}` +
          (reason ? ` ${reason}` : ''),
        'warn'
      )
    })

    client.on('close', () => {
      this.subscribed.clear()
      if (this.manualStop) {
        this.emitStatus('closed', '连接已关闭')
        this.emitConn('连接已关闭（手动停止）', 'info')
        return
      }
      this.emitStatus('closed', '连接断开')
      this.emitConn(this.everConnected ? 'MQTT 连接断开' : 'MQTT 连接未建立', 'warn')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.config.autoReconnect === false || this.manualStop) return
    const planned = this.backoff.schedule(() => {
      this.teardownClient()
      this.connect()
    })
    if (!planned) {
      const limit = normalizeBackoff(this.config).maxAttempts
      this.emitConn(`已重连 ${limit} 次仍未成功，停止重连`, 'error')
      this.emitStatus('error', '重连次数已用尽')
      return
    }
    this.emitConn(`第 ${planned.attempt} 次重连将在 ${formatWait(planned.delayMs)} 后开始`, 'warn')
  }

  /** 按订阅表订阅。granted QoS 可能低于请求值，如实报出来。 */
  private applySubscriptions(subs: MqttSubscription[]): void {
    const client = this.client
    if (!client) return
    for (const sub of subs) {
      if (!sub.enabled || !sub.filter.trim()) continue
      const opts: Record<string, unknown> = { qos: sub.qos ?? 0 }
      if (this.mqttCfg.protocolVersion === 5) {
        if (sub.noLocal) opts.nl = true
        if (sub.retainAsPublished) opts.rap = true
        if (sub.retainHandling !== undefined) opts.rh = sub.retainHandling
      }
      client.subscribe(sub.filter, opts as never, (err, granted) => {
        if (err) {
          this.emitConn(`订阅 ${sub.filter} 失败：${err.message}`, 'error')
          this.emitRaw({
            type: 'mqttSubAck',
            sessionId: this.id,
            filter: sub.filter,
            granted: -1,
            reason: err.message
          })
          return
        }
        const g = granted?.[0]
        // QoS 128 是 MQTT 3.1.1 的拒绝标记，MQTT 5 用 >=0x80 的原因码
        if (g && g.qos >= 128) {
          this.emitConn(`订阅 ${sub.filter} 被拒绝（原因码 ${g.qos}）`, 'error')
        } else {
          this.subscribed.add(sub.filter)
          this.emitConn(`已订阅 ${sub.filter}（QoS ${g?.qos ?? sub.qos}）`, 'success')
        }
        this.emitRaw({
          type: 'mqttSubAck',
          sessionId: this.id,
          filter: sub.filter,
          granted: g?.qos ?? sub.qos
        })
      })
    }
  }

  /** 订阅表变更：只处理增量，不重连 */
  updateSubscriptions(subs: MqttSubscription[]): void {
    const cfg = this.mqttCfg
    cfg.subscriptions = subs
    this.config.mqtt = cfg
    const client = this.client
    if (!client || !client.connected) return
    const wanted = new Set(subs.filter((s) => s.enabled && s.filter.trim()).map((s) => s.filter))
    for (const filter of [...this.subscribed]) {
      if (!wanted.has(filter)) {
        client.unsubscribe(filter, () => undefined)
        this.subscribed.delete(filter)
        this.emitConn(`已取消订阅 ${filter}`, 'info')
      }
    }
    this.applySubscriptions(subs.filter((s) => !this.subscribed.has(s.filter)))
  }

  async send(out: OutgoingFrame): Promise<void> {
    const client = this.client
    if (!client || !client.connected) {
      this.emitError('未连接，无法发布')
      return
    }
    const pub = out.mqtt
    const topic = (pub?.topic ?? '').trim()
    if (!topic) {
      this.emitError('发布主题为空')
      return
    }
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    const opts: Record<string, unknown> = {
      qos: pub?.qos ?? 0,
      retain: Boolean(pub?.retain)
    }
    if (this.mqttCfg.protocolVersion === 5) {
      const props: Record<string, unknown> = {}
      if (pub?.contentType) props.contentType = pub.contentType
      if (pub?.responseTopic) props.responseTopic = pub.responseTopic
      if (pub?.correlationData) props.correlationData = Buffer.from(pub.correlationData, 'utf8')
      if (pub?.userProps && Object.keys(pub.userProps).length) props.userProperties = pub.userProps
      if (Object.keys(props).length) opts.properties = props
    }
    client.publish(topic, bytes, opts as never, (err) => {
      if (err) this.emitError(`发布失败：${err.message}`)
    })
    this.emitData('tx', bytes, out.encoding, undefined, {
      topic,
      qos: (pub?.qos ?? 0) as 0 | 1 | 2,
      retain: Boolean(pub?.retain),
      userProps: pub?.userProps
    })
  }

  private teardownClient(): void {
    const client = this.client
    this.client = null
    if (!client) return
    client.removeAllListeners()
    try {
      client.end(true)
    } catch {
      // 忽略关闭异常
    }
  }

  async stop(): Promise<void> {
    this.manualStop = true
    this.backoff.cancel()
    this.subscribed.clear()
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners()
      await new Promise<void>((resolve) => {
        try {
          client.end(false, {}, () => resolve())
        } catch {
          resolve()
        }
      })
      this.emitStatus('closed', '连接已关闭')
      this.emitConn('连接已关闭（手动停止）', 'info')
    }
  }
}

/** 判断载荷是否「基本上是文本」：控制字符占比低于 10% 就按文本显示 */
function isMostlyText(buf: Buffer): boolean {
  if (buf.length === 0) return true
  let ctrl = 0
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13) continue
    if (b < 32 || b === 127) ctrl += 1
  }
  return ctrl / buf.length < 0.1
}

function readUserProps(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  return Object.keys(out).length ? out : undefined
}

export function defaultMqttConfig(): MqttConfig {
  return {
    url: 'mqtt://127.0.0.1:1883',
    clientId: 'toolbox-' + Math.random().toString(16).slice(2, 10),
    keepalive: 60,
    cleanStart: true,
    protocolVersion: 4,
    connectTimeoutMs: 10000,
    rejectUnauthorized: true,
    subscriptions: []
  }
}
