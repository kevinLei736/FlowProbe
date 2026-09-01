import type { ConnectionKind, SessionStatus } from '@shared/protocol'

/**
 * 平台标志与修饰键名。
 *
 * 为什么集中到这里：快捷键提示原先在多个文件里各写死 'Ctrl+X'，mac 上应显示 ⌘。
 * 键盘处理本身早就同时认 ctrlKey || metaKey（见 App.tsx），差的只是显示文案，
 * 因此统一出 MOD 常量与 keyHint() 即可，不必改动任何按键判断逻辑。
 *
 * platform 由 preload 同步注入，首帧即可用，不会出现文案先 Ctrl 再跳 ⌘ 的闪烁。
 */
export const IS_MAC = window.toolbox.platform === 'darwin'

/** 修饰键显示名：mac 用 ⌘，其余用 Ctrl */
export const MOD = IS_MAC ? '⌘' : 'Ctrl'

/**
 * 把 'Ctrl+N' / 'Ctrl Shift Tab' 这类写死的提示转成当前平台写法。
 * mac 习惯符号紧挨不加分隔符（⌘N），Windows 习惯用加号（Ctrl+N）。
 */
export function keyHint(hint: string): string {
  if (!IS_MAC) return hint
  const parts = hint.split('+').join(' ').split(' ').filter((s) => s.length > 0)
  return parts
    .map((p) => {
      if (p === 'Ctrl') return '⌘'
      if (p === 'Shift') return '⇧'
      if (p === 'Alt') return '⌥'
      if (p === 'Enter') return '↩'
      return p
    })
    .join('')
}


export const KIND_META: Record<ConnectionKind, { label: string; icon: string; group: string }> = {
  'tcp-client': { label: 'TCP 客户端', icon: 'C', group: 'Socket' },
  'tcp-server': { label: 'TCP 服务端', icon: 'S', group: 'Socket' },
  'ws-client': { label: 'WebSocket 客户端', icon: 'W', group: 'WebSocket' },
  'ws-server': { label: 'WebSocket 服务端', icon: 'V', group: 'WebSocket' },
  'udp-client': { label: 'UDP 客户端', icon: 'U', group: 'UDP' },
  'udp-server': { label: 'UDP 服务端', icon: 'D', group: 'UDP' },
  serial: { label: '串口', icon: 'P', group: '串口' },
  'http-mock': { label: 'HTTP Mock 服务', icon: 'M', group: 'HTTP' },
  'mqtt-client': { label: 'MQTT 客户端', icon: 'Q', group: 'MQTT' },
  'modbus-tcp': { label: 'Modbus TCP 主站', icon: 'B', group: 'Modbus' },
  'modbus-rtu': { label: 'Modbus RTU 主站', icon: 'R', group: 'Modbus' },
  'modbus-slave': { label: 'Modbus 从站模拟', icon: 'L', group: 'Modbus' }
}

/**
 * 模块能力矩阵。
 *
 * 为什么要有这张表：会话界面原来把所有功能一股脑铺给每种连接 —— WebSocket 上挂
 * 「追加 CRLF」（WS 本身有消息边界，加结束符是错的）、MQTT 上挂「规则应答 Mock」
 * （Mock 匹配的是裸字节流，MQTT 走的是主题）、Modbus 的地址类模板出现在串口的解析
 * 下拉里。这些都不是配色问题，是模块边界没画清。
 *
 * 把「这个模块有哪些功能」集中成数据，界面只按矩阵渲染。新增连接类型时只需在这里
 * 补一行，不用再去十几个 `kind === xxx` 的条件里逐个补丁。
 */
export interface KindCaps {
  /** 协议解析模板：只有面向字节流的链路才谈得上按帧结构拆字段 */
  protoTemplate: boolean
  /** 结束符：只有「以换行分帧」的流式协议需要，WS/MQTT/Modbus 自带边界 */
  terminator: boolean
  /** 发送编码可切换：Modbus 是纯二进制，切到 TEXT 只会发出乱码 */
  encodingSwitch: boolean
  /** 报文级规则应答 Mock：按收到的裸字节匹配并回包 */
  frameMock: boolean
  /** 录制与回放 */
  recording: boolean
  /** 循环发送 */
  loopSend: boolean
  /** 多对端：服务端才有「广播全部 / 指定对端」 */
  peerTarget: boolean
  /** 发送前需要指定主题（MQTT） */
  topicPublish: boolean
  /** 点表轮询（Modbus 主站） */
  pointTable: boolean
  /**
   * 数据区表（Modbus 从站模拟）。
   *
   * 与 pointTable 是镜像而不是同一项：主站的点表是「我要去读哪些地址」，
   * 从站的数据区是「我这里有哪些地址、初值多少、怎么自动变化」。两张表的列、
   * 校验规则和写入语义都不同，合成一项必然在界面里长出一堆 kind 判断。
   */
  regionTable: boolean
  /** 订阅管理（MQTT） */
  subscription: boolean
  /**
   * 报文断言告警：对收发字节设阈值并在命中时提醒。
   * 与 protoTemplate 同源（字段判定要靠模板解析），但单列一项——
   * 文本关键字告警不需要模板，将来可能出现「支持告警但不支持模板」的链路。
   */
  alertRule: boolean
}

const STREAM: KindCaps = {
  protoTemplate: true,
  terminator: true,
  encodingSwitch: true,
  frameMock: true,
  recording: true,
  loopSend: true,
  peerTarget: false,
  topicPublish: false,
  pointTable: false,
  regionTable: false,
  subscription: false,
  alertRule: true
}

/** WebSocket：有消息边界，所以没有结束符；其余与流式一致 */
const WS: KindCaps = { ...STREAM, terminator: false }

/**
 * UDP：一个数据报就是一帧，边界由协议保证，所以同样没有结束符、没有分帧。
 * 其余能力（模板解析、告警、录制、循环发送）与字节流链路完全一致。
 */
const UDP: KindCaps = { ...STREAM, terminator: false }

export const KIND_CAPS: Record<ConnectionKind, KindCaps> = {
  'tcp-client': STREAM,
  'tcp-server': { ...STREAM, peerTarget: true },
  'ws-client': WS,
  'ws-server': { ...WS, peerTarget: true },
  'udp-client': UDP,
  // 服务端要能「回给某个发件人」，所以开对端选择
  'udp-server': { ...UDP, peerTarget: true },
  serial: STREAM,
  // HTTP Mock 有专属界面（路由表 + 请求日志），不复用报文收发那套
  'http-mock': {
    protoTemplate: false,
    terminator: false,
    encodingSwitch: false,
    frameMock: false,
    recording: false,
    loopSend: false,
    peerTarget: false,
    topicPublish: false,
    pointTable: false,
    regionTable: false,
    subscription: false,
    // Mock 有独立的请求日志与断言视角，报文级字节告警在这里没有对应物
    alertRule: false
  },
  'mqtt-client': {
    ...STREAM,
    terminator: false,
    // Mock 规则匹配裸字节，MQTT 的语义单元是主题+载荷，两者对不上
    frameMock: false,
    topicPublish: true,
    subscription: true
  },
  'modbus-tcp': {
    ...STREAM,
    terminator: false,
    encodingSwitch: false,
    frameMock: false,
    pointTable: true
  },
  'modbus-rtu': {
    ...STREAM,
    terminator: false,
    encodingSwitch: false,
    frameMock: false,
    pointTable: true
  },
  /**
   * 从站模拟：角色与主站对调，所以没有点表、没有循环发送（从站不主动发），
   * 但要能选对端（哪个主站连着）。发送区改成手动置值的快捷入口。
   */
  'modbus-slave': {
    ...STREAM,
    terminator: false,
    encodingSwitch: false,
    frameMock: false,
    loopSend: false,
    peerTarget: false,
    pointTable: false,
    regionTable: true
  }
}

export const STATUS_META: Record<SessionStatus, { label: string; color: string }> = {
  idle: { label: '未启动', color: 'var(--text-2)' },
  connecting: { label: '连接中', color: 'var(--warn)' },
  listening: { label: '监听中', color: 'var(--accent)' },
  connected: { label: '已连接', color: 'var(--accent)' },
  error: { label: '错误', color: 'var(--error)' },
  closed: { label: '已关闭', color: 'var(--text-2)' }
}
