// 前后端共享的类型契约

export type ConnectionKind =
  | 'tcp-client'
  | 'tcp-server'
  | 'ws-client'
  | 'ws-server'
  | 'udp-client'
  | 'udp-server'
  | 'serial'
  | 'http-mock'
  | 'mqtt-client'
  | 'modbus-tcp'
  | 'modbus-rtu'
  | 'modbus-slave'

export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'connected'
  | 'error'
  | 'closed'

export type Encoding = 'hex' | 'utf8' | 'base64'
export type Direction = 'tx' | 'rx' | 'system'

/**
 * 系统消息级别。用于把「连接生命周期」从普通提示里区分出来：
 * success=已建立、warn=断开或即将重连、error=失败或放弃、info=其他提示。
 */
export type SystemLevel = 'info' | 'success' | 'warn' | 'error'

export type Terminator = '' | 'cr' | 'lf' | 'crlf'

// 粘包/分帧策略
export type FramingMode = 'none' | 'delimiter' | 'length' | 'timeout'

export interface FramingConfig {
  mode: FramingMode
  // delimiter 模式：分隔符（HEX 字符串，如 "0d0a"）
  delimiter?: string
  // length 模式：长度域信息
  lengthFieldOffset?: number
  lengthFieldBytes?: number
  lengthAdjust?: number
  lengthBigEndian?: boolean
  // timeout 模式：静默毫秒
  idleMs?: number
}

export interface SessionConfig {
  // 通用
  host?: string
  port?: number
  url?: string
  path?: string
  serialPath?: string
  baudRate?: number
  dataBits?: number
  stopBits?: number
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'

  // TCP 客户端
  connectTimeoutMs?: number
  autoReconnect?: boolean
  /** 首次重连等待，之后按 2 倍指数递增 */
  reconnectIntervalMs?: number
  /** 单次重连等待上限，默认 30000 */
  reconnectMaxIntervalMs?: number
  /** 最大重连次数，0 = 不限次 */
  reconnectMaxAttempts?: number
  noDelay?: boolean
  keepAlive?: boolean
  heartbeatEnabled?: boolean
  heartbeatIntervalMs?: number
  heartbeatEncoding?: Encoding
  heartbeatContent?: string

  // 串口
  rtscts?: boolean
  xon?: boolean
  xoff?: boolean
  dtr?: boolean
  rts?: boolean

  // WebSocket
  /** WS 客户端断线后自动重连（与 TCP 共用退避参数） */
  subProtocols?: string[]
  headers?: Record<string, string>
  origin?: string
  rejectUnauthorized?: boolean
  pingIntervalMs?: number
  wsSendMode?: 'text' | 'binary'

  // UDP
  /**
   * UDP 是无连接协议：客户端的「目标地址」只是 send 时的默认收件人，
   * 服务端的「绑定端口」才是真正占用的资源。两者都可能同时需要绑定与目标，
   * 所以不复用 host/port，单列一组字段避免语义打架。
   */
  udpBindHost?: string
  udpBindPort?: number
  /** 允许发往广播地址（255.255.255.255 / x.x.x.255） */
  udpBroadcast?: boolean
  /** 加入的组播组地址，留空表示不组播 */
  udpMulticastGroup?: string
  /** 组播 TTL（跳数），默认 1 表示只在本网段 */
  udpTtl?: number
  /** 端口复用：同机多进程监听同一端口（组播抓包常用） */
  udpReuseAddr?: boolean
  /** 对端空闲多久后从列表淘汰（毫秒）。UDP 没有断开事件，只能靠超时 */
  udpPeerIdleMs?: number

  // TCP 服务端
  maxConnections?: number

  // 分帧
  framing?: FramingConfig

  // Mock 自动应答（字节回声，遗留）
  mock?: MockConfig

  // HTTP Mock 服务
  https?: boolean
  /** 证书与私钥的 PEM 正文。存正文而非路径：证书文件被挪走或删掉后服务照样能起 */
  tlsCert?: string
  tlsKey?: string
  /** 证书来源（生成时写入的落盘路径或导入的文件路径），仅用于界面展示与「打开所在目录」 */
  tlsCertPath?: string
  tlsKeyPath?: string
  basePath?: string
  httpMock?: HttpMockConfig

  // MQTT 客户端
  mqtt?: MqttConfig

  // Modbus 主站
  modbus?: ModbusConfig
  // Modbus 从站模拟
  modbusSlave?: ModbusSlaveConfig

  [key: string]: unknown
}

export interface SessionMetrics {
  txBytes: number
  rxBytes: number
  txFrames: number
  rxFrames: number
  peers: number
}

export interface Session {
  id: string
  kind: ConnectionKind
  name: string
  status: SessionStatus
  config: SessionConfig
  createdAt: number
  metrics: SessionMetrics
  /** 应用启动后是否自动连接/监听 */
  autoStart?: boolean
  /** 所属分组名。空字符串或缺省表示「未分组」 */
  group?: string
  /** 自定义标签，用于左栏筛选与看板分类 */
  tags?: string[]
}

export interface Peer {
  id: string
  label: string
  connectedAt: number
}

export interface Frame {
  id: string
  sessionId: string
  direction: Direction
  peerId?: string
  peerLabel?: string
  ts: number
  size: number
  encoding: Encoding
  rawBase64: string
  text?: string
  /** direction=system 时的级别，用于时间轴着色与「仅看连接日志」过滤 */
  level?: SystemLevel
  /** 标记该系统消息属于连接生命周期（连接/断开/重连/放弃） */
  conn?: boolean
  /** 标记该帧来自录制回放，而非真实链路 */
  replay?: boolean
  /**
   * 报文告警命中标记。
   *
   * 这是渲染层在收帧时打上的注解，主进程不产生该字段——告警规则依赖协议解析模板，
   * 而模板是渲染层的用户数据，放到主进程要多同步一份状态，得不偿失。
   */
  alert?: FrameAlert
  /**
   * 协议专属附加信息。新协议接入时不再往 Frame 上加字段，
   * 统一塞进这里（MQTT 的 topic/qos/retain、Modbus 的 funcCode/addr），
   * 这样历史落库、全局搜索、看板统计都不用改结构。
   */
  meta?: FrameMeta
}

/** 协议专属附加信息。字段全部可选，按需填。 */
export interface FrameMeta {
  /** MQTT 主题 */
  topic?: string
  /** MQTT QoS */
  qos?: 0 | 1 | 2
  /** MQTT retain 标记 */
  retain?: boolean
  /** MQTT 报文 id */
  packetId?: number
  /** MQTT 5 用户属性 */
  userProps?: Record<string, string>
  /** Modbus 功能码 */
  funcCode?: number
  /** Modbus 起始地址 */
  addr?: number
  /** Modbus 数量 */
  quantity?: number
  /** Modbus 从站地址 */
  unitId?: number
  /** Modbus 异常码（有值表示该响应是异常响应） */
  exceptionCode?: number
  /** 自由文本标注，界面上作为报文行的补充说明 */
  note?: string
}

export interface OutgoingFrame {
  sessionId: string
  encoding: Encoding
  content: string
  appendTerminator?: Terminator
  target?: string // 服务端指定对端 peerId；空=广播
  /** MQTT 发布参数。其他协议忽略。 */
  mqtt?: MqttPublishOptions
}

// —— Mock 自动应答 ——
export type MatchType = 'any' | 'contains' | 'equals' | 'regex' | 'hex' | 'startsWith'
export type ResponseType = 'static' | 'template' | 'script'

export interface MockRule {
  id: string
  name: string
  enabled: boolean
  matchType: MatchType
  // 匹配用编码：text 时按字符串匹配，hex 时按十六进制
  matchEncoding: Encoding
  pattern: string
  responseType: ResponseType
  responseEncoding: Encoding
  responseBody: string
  delayMs: number
  appendTerminator?: Terminator
}

export interface FaultInjection {
  enabled: boolean
  dropRate: number // 0..1 收到即丢弃（不应答）
  extraDelayMs: number // 额外附加延迟
}

export interface MockConfig {
  enabled: boolean
  rules: MockRule[]
  fault: FaultInjection
  fallthrough: boolean // 无规则命中时是否回显
}

// —— HTTP Mock 服务 ——
export type HttpMethod =
  | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD' | 'ANY'

export type HttpBodyType = 'json' | 'text' | 'xml' | 'base64'
export type HttpRouteMode = 'template' | 'script'

export interface HttpHeaderKV {
  key: string
  value: string
  enabled?: boolean
}

export interface HttpMockRoute {
  id: string
  name: string
  enabled: boolean
  method: HttpMethod
  // 路径：精确 /a/b、通配 /a/*、占位 /a/:id、正则（以 re: 前缀）
  pathPattern: string
  // 进一步筛选（可空）
  matchQuery?: string // 例如 status=ok
  matchHeader?: string // 例如 x-token: abc
  priority: number
  mode: HttpRouteMode
  // template 模式
  respStatus: number
  respHeaders: HttpHeaderKV[]
  bodyType: HttpBodyType
  respBody: string
  delayMs: number
  // script 模式：handler(req, res) 源码
  script?: string
}

/**
 * 场景对某条路由的响应覆盖。只写需要变的字段，其余沿用路由本身的配置。
 * 这样一条路由可以在「正常 / 超时 / 401 / 500」等场景间一键切换，
 * 而不必反复编辑路由本体。
 */
export interface HttpScenarioOverride {
  /** 该场景下是否禁用此路由（用于模拟接口尚未上线） */
  enabled?: boolean
  respStatus?: number
  bodyType?: HttpBodyType
  respBody?: string
  respHeaders?: HttpHeaderKV[]
  delayMs?: number
  mode?: HttpRouteMode
  script?: string
}

export interface HttpMockScenario {
  id: string
  name: string
  /** 场景说明，例如「模拟登录过期」 */
  note?: string
  /** 按路由 id 索引的覆盖项 */
  overrides: Record<string, HttpScenarioOverride>
  /** 场景级故障注入覆盖（不填则沿用全局设置） */
  fault?: HttpFaultInjection
}

export interface HttpFaultInjection {
  enabled: boolean
  failRate: number // 0..1 概率
  failStatus: number // 命中失败时返回的状态码
  extraDelayMs: number
}

export interface HttpMockConfig {
  enabled: boolean
  routes: HttpMockRoute[]
  fault: HttpFaultInjection
  // 未命中：404 或 代理透传
  fallthrough: 'notFound' | 'proxy'
  proxyTarget?: string // 形如 http://127.0.0.1:8000
  corsEnabled: boolean
  /** 场景库：一套路由挂多套响应，切换即生效 */
  scenarios?: HttpMockScenario[]
  /** 当前生效场景 id；空或找不到时用路由本身的配置（即「默认」场景） */
  activeScenarioId?: string
}

// HTTP 请求日志（作为 Frame 之外的结构化事件）
export interface HttpLogEntry {
  id: string
  sessionId: string
  ts: number
  method: string
  path: string
  query: string
  status: number
  durationMs: number
  reqHeaders: Record<string, string>
  reqBody?: string
  respHeaders: Record<string, string>
  respBody?: string
  matchedRoute?: string
  /** 命中时生效的场景名（默认场景为空） */
  scenario?: string
}

// —— HTTP 接口测试工具（API Client） ——
export type HttpTestBodyType = 'none' | 'json' | 'text' | 'xml' | 'form' | 'binary'
export type HttpAuthType = 'none' | 'basic' | 'bearer' | 'apikey'

export interface HttpAuth {
  type: HttpAuthType
  username?: string
  password?: string
  token?: string
  apiKeyName?: string
  apiKeyValue?: string
  apiKeyIn?: 'header' | 'query'
}

export interface HttpTestRequest {
  method: string
  url: string
  query: HttpHeaderKV[]
  headers: HttpHeaderKV[]
  bodyType: HttpTestBodyType
  body: string // form 时为多行 key=value；binary 时为 base64
  auth: HttpAuth
  timeoutMs?: number
  followRedirects?: boolean
  rejectUnauthorized?: boolean
}

export interface HttpTestResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  bodyBase64: string
  bodyText: string
  sizeBytes: number
  durationMs: number
  redirects: number
  error?: string
}

// 断言
export type AssertTarget = 'status' | 'time' | 'jsonPath' | 'text' | 'regex'
export interface HttpAssertion {
  id: string
  enabled: boolean
  target: AssertTarget
  path?: string // jsonPath 时的路径，如 data.id
  op: 'eq' | 'neq' | 'contains' | 'lt' | 'gt' | 'exists' | 'match'
  expected: string
}
export interface AssertionResult {
  id: string
  passed: boolean
  detail: string
}

// 变量提取规则：把响应中的值写入运行时变量，供后续请求引用
export type ExtractSource = 'body' | 'header' | 'status'
export interface HttpExtractRule {
  id: string
  enabled: boolean
  source: ExtractSource
  // body 时为 JSON 路径（data.token / list[0].id）；header 时为响应头名
  path?: string
  varName: string
}

// 保存的接口请求条目
export interface SavedHttpRequest {
  id: string
  name: string
  request: HttpTestRequest
  assertions: HttpAssertion[]
  extracts?: HttpExtractRule[]
}
export interface HttpEnvironment {
  id: string
  name: string
  variables: HttpHeaderKV[]
}

// —— 接口集合定时巡检（M28.2）——

/** 通知策略：每次都通知 / 仅失败时通知 / 从不通知 */
export type MonitorNotify = 'always' | 'fail' | 'never'

/**
 * 一个巡检任务。
 *
 * requestIds 为空表示「集合里全部请求」——这样后续往集合里加接口，
 * 巡检会自动覆盖新接口，不需要回来改任务。
 */
export interface MonitorTask {
  id: string
  name: string
  /** 参与巡检的请求 id；空数组=全部 */
  requestIds: string[]
  /** 使用的环境 id；空=当前激活环境 */
  envId: string | null
  /** 间隔秒数，最小 10 秒 */
  intervalSec: number
  enabled: boolean
  /** 步骤间隔毫秒 */
  delayMs: number
  stopOnFail: boolean
  notify: MonitorNotify
  /** 连续失败达到该次数才通知，用于压掉网络抖动造成的偶发告警。1=立即通知 */
  failThreshold: number
  lastRunAt?: number
  lastPassed?: boolean
  /** 连续失败计数，成功即归零 */
  failStreak?: number
}

/** 一次巡检结果的留档。步骤明细只留必要字段，避免历史无限膨胀 */
export interface MonitorRun {
  id: string
  taskId: string
  taskName: string
  startedAt: number
  totalMs: number
  ran: number
  stepPass: number
  stepFail: number
  assertTotal: number
  assertPass: number
  /** 失败步骤的摘要，用于列表直接看出「哪个接口挂了」 */
  failures: Array<{ name: string; status: number; detail: string }>
}

// —— 报文断言告警（M28.3）——

/** 告警取值来源：解析后的字段 / 报文文本 / 校验结果 */
export type AlertSource = 'field' | 'text' | 'checksum'

/** 判定运算。前八个用于数值字段，后三个用于文本 */
export type AlertOp =
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'ne'
  | 'between'
  | 'outside'
  | 'contains'
  | 'notContains'
  | 'regex'

export type AlertSeverity = 'warn' | 'error'

/**
 * 一条报文告警规则。
 *
 * sessionId 为空表示「按会话类型生效」，这样换一台设备重建会话不用重配规则；
 * 指定 sessionId 则只盯这一个会话，适合临时排查。
 */
export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  /** 只作用于该会话；null = 作用于 kinds 指定的所有会话 */
  sessionId: string | null
  /** sessionId 为 null 时的生效范围；空数组 = 不限连接类型 */
  kinds: ConnectionKind[]
  direction: 'any' | 'tx' | 'rx'
  source: AlertSource
  /** source=field 时用哪个模板解析；'auto' = 按前缀自动匹配 */
  templateId?: string
  /** source=field 时的字段名（与模板里的字段名一致） */
  field?: string
  op: AlertOp
  /** 阈值 / 关键字。between、outside 用 value~value2 表示闭区间 */
  value?: string
  value2?: string
  severity: AlertSeverity
  /** 命中后高亮报文行 */
  highlight: boolean
  /** 命中后发系统通知 */
  notify: boolean
  /** 命中后自动断开该会话，用于「出问题就停下来保留现场」 */
  stopSession: boolean
  /**
   * 冷却秒数。高频链路上一条异常报文往往连着来几百条，
   * 没有冷却会把通知与告警中心瞬间刷爆，反而看不到第一条。0 = 不冷却。
   */
  cooldownSec: number
  /** 累计命中次数，仅用于列表里判断规则是否真的在生效 */
  hits?: number
  lastFiredAt?: number
}

/** 报文行上的告警标记（渲染层注解） */
export interface FrameAlert {
  ruleId: string
  ruleName: string
  severity: AlertSeverity
  detail: string
}

/** 一次告警命中的留档。快照存 HEX，便于事后原样回看 */
export interface AlertEvent {
  id: string
  ruleId: string
  ruleName: string
  severity: AlertSeverity
  sessionId: string
  sessionName: string
  frameId: string
  ts: number
  direction: Direction
  /** 触发说明，如「温度 82.4 > 80」 */
  detail: string
  snapshotHex: string
  snapshotText?: string
}

// —— 报文标注与书签 ——

/**
 * 一条报文书签。
 *
 * 为什么要把 hex/text/ts 这些「报文本身已经有」的信息复制进来：
 * 报文缓冲是内存态，清屏或重启之后 frameId 就查不到对应报文了。只存 id 的书签
 * 在重启后会变成一排点不开的空行 —— 而书签最主要的用途恰恰是「过一会儿再回来看」。
 * 所以这里存的是自洽的快照，能否跳回实时时间轴只是加分项。
 */
export interface FrameMark {
  id: string
  sessionId: string
  /** 会话名快照。会话被删掉后书签仍要能说清它当时属于谁 */
  sessionName: string
  sessionKind: ConnectionKind
  /** 报文 id。仅用于跳回当前缓冲，找不到不影响书签可读 */
  frameId: string
  ts: number
  direction: Direction
  size: number
  /** 用户写的标注，可为空（只加星不写字也是合理用法） */
  note: string
  /** 报文快照，截断到 128 字节：书签是索引不是归档，全文在历史库里 */
  snapshotHex: string
  snapshotText?: string
  createdAt: number
}

// —— 报文录制与回放 ——

/** 录制文件里的一条报文。相对时间存 offsetMs，回放时按它排时序。 */
export interface RecordedFrame {
  /** 相对录制起点的毫秒偏移 */
  offsetMs: number
  direction: Direction
  encoding: Encoding
  rawBase64: string
  text?: string
  size: number
  peerLabel?: string
  level?: SystemLevel
  conn?: boolean
}

/** 录制文件结构（.json，版本化以便后续兼容） */
export interface RecordingFile {
  /**
   * 文件格式标识。
   *
   * 保留旧值 debug-toolbox-recording 是为了兼容改名之前导出的录制文件：
   * 这个字段是加载时的准入判断依据，只认新值等于让用户手里的旧文件全部失效。
   * 新导出一律写 flowprobe-recording，读取时两者都接受。
   */
  format: 'flowprobe-recording' | 'debug-toolbox-recording'
  version: 1
  /** 录制来源会话名与类型，仅作提示 */
  sessionName: string
  sessionKind: ConnectionKind
  /** 录制起点的绝对时间戳 */
  startedAt: number
  /** 录制总时长（毫秒） */
  durationMs: number
  frames: RecordedFrame[]
  note?: string
}

// —— 协议解析模板（把裸字节渲染成字段表） ——
export type ProtoFieldType =
  | 'uint8' | 'uint16' | 'uint32'
  | 'int8' | 'int16' | 'int32'
  | 'float32' | 'float64'
  | 'hex' | 'ascii' | 'bcd' | 'bits'

export type ProtoChecksum = 'none' | 'sum8' | 'xor8' | 'crc16-modbus'

export interface ProtoField {
  id: string
  name: string
  type: ProtoFieldType
  /** hex/ascii/bcd/bits 的字节长度；留空或 0 表示「吃掉剩余字节」 */
  length?: number
  /** 多字节整型/浮点的字节序，默认大端 */
  bigEndian?: boolean
  /** 工程值换算：显示值 = 原始值 * scale + offset */
  scale?: number
  offset?: number
  unit?: string
  /** 枚举映射，形如 "0=关机,1=运行,2=故障" */
  enumMap?: string
  note?: string
  /** 勾选后该数值字段随时间绘制成曲线（仅数值类型有效） */
  chart?: boolean
}

export interface ProtoTemplate {
  id: string
  name: string
  /**
   * 模板归属的连接类型。留空或空数组 = 通用模板，所有会话都能用。
   *
   * 为什么需要它：Modbus 的「从站地址 / 起始地址」这类字段只在 Modbus 链路上成立，
   * 却会出现在串口、WebSocket 的解析下拉里，用户误选后解析结果全是噪声。
   * 把归属写进模板本身，解析下拉与自动匹配都只在本模块的模板里挑，模块边界才清晰。
   */
  kinds?: ConnectionKind[]
  /** 仅解析以该 HEX 前缀开头的报文，留空表示不限（如 "AA55"） */
  matchPrefixHex?: string
  /** 仅解析指定方向的报文 */
  direction?: 'any' | 'tx' | 'rx'
  /** 末尾校验方式，校验范围为首字节到校验位之前 */
  checksum?: ProtoChecksum
  fields: ProtoField[]
}


// —— MQTT 客户端 ——

/** 一条订阅。随会话落盘，启动后自动订阅 enabled 的条目。 */
export interface MqttSubscription {
  id: string
  /** 主题过滤器，支持 + 单层与 # 多层通配 */
  filter: string
  qos: 0 | 1 | 2
  enabled: boolean
  /** MQTT 5：No Local，不接收自己发布的消息 */
  noLocal?: boolean
  /** MQTT 5：Retain As Published */
  retainAsPublished?: boolean
  /** MQTT 5：Retain Handling，0 发送保留消息 / 1 仅新订阅时发送 / 2 不发送 */
  retainHandling?: 0 | 1 | 2
}

/** 遗嘱消息：客户端异常掉线时由 Broker 代为发布 */
export interface MqttWill {
  enabled: boolean
  topic: string
  payload: string
  /** 载荷编码，与发送编辑器一致 */
  encoding: Encoding
  qos: 0 | 1 | 2
  retain: boolean
}

/** 发布参数 */
export interface MqttPublishOptions {
  topic: string
  qos: 0 | 1 | 2
  retain: boolean
  /** MQTT 5 */
  contentType?: string
  responseTopic?: string
  correlationData?: string
  userProps?: Record<string, string>
}

export interface MqttConfig {
  /** mqtt:// mqtts:// ws:// wss:// */
  url: string
  clientId: string
  username?: string
  password?: string
  /** 秒。0 表示关闭保活 */
  keepalive: number
  /** 3.1.1 用 cleanSession，5.0 用 cleanStart，语义一致 */
  cleanStart: boolean
  /** 4 = MQTT 3.1.1，5 = MQTT 5.0 */
  protocolVersion: 4 | 5
  connectTimeoutMs: number
  /** TLS 相关，仅 mqtts / wss 生效 */
  rejectUnauthorized?: boolean
  caPath?: string
  certPath?: string
  keyPath?: string
  servername?: string
  will?: MqttWill
  subscriptions: MqttSubscription[]
  /** MQTT 5 会话过期时间（秒），0 = 断开即过期 */
  sessionExpiryInterval?: number
}

// —— Modbus 主站 ——

export type ModbusTransport = 'tcp' | 'rtu' | 'rtu-over-tcp'

/** 支持的功能码。读 4 个 + 写 4 个，覆盖绝大多数现场需求。 */
export type ModbusFunc = 1 | 2 | 3 | 4 | 5 | 6 | 15 | 16

export type ModbusPointType =
  | 'uint16' | 'int16'
  | 'uint32' | 'int32'
  | 'float32' | 'float64'
  | 'bits' | 'string'

/**
 * 点表条目。工控现场的核心工作面就是这张表：
 * 名称、地址、类型、换算、单位，读出来直接是工程值。
 */
export interface ModbusPoint {
  id: string
  name: string
  /** 读功能码：1 线圈 / 2 离散输入 / 3 保持寄存器 / 4 输入寄存器 */
  func: 1 | 2 | 3 | 4
  /** 起始地址（0 基） */
  addr: number
  /** 读取数量：寄存器个数或位个数。string/多字类型据此决定长度 */
  quantity: number
  type: ModbusPointType
  /** 工程值 = 原始值 * scale + offset */
  scale?: number
  offset?: number
  unit?: string
  /** 是否允许从界面写入 */
  writable?: boolean
  /** 轮询间隔（毫秒），0 = 不轮询，仅手动读 */
  pollMs: number
  enabled: boolean
  note?: string
  /** 勾选后该点位进数值曲线 */
  chart?: boolean
}

export interface ModbusConfig {
  transport: ModbusTransport
  /** tcp / rtu-over-tcp */
  host?: string
  port?: number
  /** rtu：复用 SessionConfig 顶层的串口字段 */
  unitId: number
  timeoutMs: number
  retries: number
  /** 两次请求之间的最小间隔，防止把从站打爆 */
  gapMs: number
  /**
   * 32 位量的字序与字节序。工控设备在这里分歧极大：
   * 同样的 float32 有 ABCD / CDAB / BADC / DCBA 四种排法，
   * 写死必然踩坑，所以两个维度都开放配置。
   */
  wordOrder: 'be' | 'le'
  byteOrder: 'be' | 'le'
  /** 地址相邻的点位合并成一次批量读的最大间隔，0 = 不合并 */
  mergeGap: number
  points: ModbusPoint[]
}

/** 点位实时值。渲染层据此刷新点表格。 */
export interface ModbusPointValue {
  pointId: string
  ts: number
  /** 工程值。bits 类型给 0/1 数组，string 给字符串 */
  value: number | number[] | string | null
  /** 原始寄存器值（HEX），便于对照排查字序问题 */
  rawHex: string
  error?: string
}

export interface ModbusException {
  code: number
  name: string
  message: string
}

// —— Modbus 从站模拟 ——

export type ModbusArea = 'coil' | 'discrete' | 'holding' | 'input'

/**
 * 数据区定义。
 *
 * 为什么要显式声明区域而不是「全 65536 个地址都存在」：
 * 真实设备只实现一小段地址，读越界会回 0x02 非法数据地址。而「地址填错了」
 * 恰恰是点表配置最常见的错误。若从站对任何地址都乐观返回 0，主站侧的地址错误
 * 就被静默吞掉了 —— 那这个从站就失去了自测点表的意义。
 */
export interface ModbusSlaveRegion {
  id: string
  name: string
  area: ModbusArea
  /** 起始地址（0 基，与主站点表同一套口径） */
  start: number
  /** 地址个数：位区为位数，寄存器区为字数 */
  count: number
  /** 建区时的填充值。位区取 0/1，寄存器区取 0..65535 */
  initial?: number
  /** 只读：主站写入时回 0x02，用于模拟输入类或受保护寄存器 */
  readOnly?: boolean
  /**
   * 自动变化。没有真实设备时，静止不动的寄存器测不出曲线、告警与轮询节奏，
   * 所以内建几种最常用的波形，让数据自己动起来。
   */
  animate?: 'none' | 'ramp' | 'sine' | 'random' | 'toggle'
  /** 变化周期（毫秒），下限 100 */
  animateMs?: number
  animateMin?: number
  animateMax?: number
  /** ramp 每步增量 */
  animateStep?: number
  enabled: boolean
  note?: string
}

export interface ModbusSlaveConfig {
  transport: ModbusTransport
  /** tcp / rtu-over-tcp 的监听地址与端口 */
  host?: string
  port?: number
  /** rtu：复用 SessionConfig 顶层的串口字段 */
  unitId: number
  /**
   * 接受任意从站地址。串口总线上挂多台设备时，用一个从站冒充整条总线比建 N 个会话省事；
   * 也便于确认「主站到底在问哪个从站地址」。
   */
  acceptAnyUnit?: boolean
  /** 人为延迟应答，用于验证主站的超时与重试逻辑 */
  responseDelayMs?: number
  /** 按比例丢弃请求（0–1），模拟链路不稳导致的偶发超时 */
  dropRate?: number
  /** 强制返回异常码，用于验证主站的异常处理分支 */
  exception?: { enabled: boolean; code: number; funcs?: number[] }
  /** tcp 模式下的最大并发主站连接数 */
  maxClients?: number
  regions: ModbusSlaveRegion[]
}

/** 某个数据区的当前值，供界面刷新寄存器表格 */
export interface ModbusSlaveRegionValues {
  regionId: string
  ts: number
  /** 位区给 0/1 数组，寄存器区给 0..65535 数组 */
  values: number[]
}

export interface CreateSessionRequest {
  kind: ConnectionKind
  name: string
  config: SessionConfig
  autoStart?: boolean
  group?: string
  tags?: string[]
  /** 从工作区恢复时沿用原 id，避免每次启动 id 变化 */
  id?: string
}

// —— 报文历史（SQLite 落库） ——

/** 历史库配置。存在库内 meta 表，与工作区配置分离。 */
export interface HistoryConfig {
  /** 总开关。关闭后不再写入，但已有数据保留 */
  enabled: boolean
  /** 保留天数，超过即在启动与定时清理时删除；0 = 不按时间清理 */
  retentionDays: number
  /** 报文条数上限，超出删除最旧；0 = 不限 */
  maxFrames: number
  /** 是否连同报文原始字节一起存。关掉只存文本摘要，库体积小很多 */
  storePayload: boolean
}

/** 历史报文行。session 名与类型来自快照，会话删掉后依然可读 */
export interface HistoryFrameRow {
  id: number
  sessionId: string
  sessionName: string
  sessionKind: ConnectionKind | string
  sessionGroup: string
  ts: number
  direction: Direction
  size: number
  encoding: Encoding
  rawBase64: string
  text: string
  peerLabel: string
  level?: SystemLevel
  conn: boolean
}

/** 历史 HTTP 请求行 */
export interface HistoryHttpRow {
  id: number
  sessionId: string
  sessionName: string
  ts: number
  method: string
  path: string
  query: string
  status: number
  durationMs: number
  reqBody: string
  respBody: string
  matchedRoute: string
  scenario: string
}

export interface HistoryQuery {
  /** 限定会话；空表示全部 */
  sessionIds?: string[]
  /** 时间区间（毫秒时间戳），闭区间 */
  from?: number
  to?: number
  /** 限定方向；空表示全部 */
  directions?: Direction[]
  /** 只看连接生命周期日志 */
  connOnly?: boolean
  /** 文本关键字（对报文文本做 LIKE 匹配） */
  keyword?: string
  /** 字节数下限/上限 */
  minSize?: number
  maxSize?: number
  limit?: number
  offset?: number
  /** 默认 desc（最新在前） */
  order?: 'asc' | 'desc'
}

export interface HistoryHttpQuery {
  sessionIds?: string[]
  from?: number
  to?: number
  /** 状态码族，如 [2, 4] 表示 2xx 与 4xx */
  statusFamilies?: number[]
  method?: string
  keyword?: string
  /** 耗时下限（毫秒），用于找慢请求 */
  minDurationMs?: number
  limit?: number
  offset?: number
  order?: 'asc' | 'desc'
}

export interface HistoryPage<T> {
  rows: T[]
  /** 满足条件的总行数，用于分页 */
  total: number
}

/** 库概况，用于设置面板与容量提示 */
export interface HistoryStats {
  enabled: boolean
  frames: number
  httpLogs: number
  sessions: number
  /** 数据库文件字节数 */
  fileBytes: number
  oldestTs: number | null
  newestTs: number | null
  /** 最近若干天的每日条数，用于设置面板小柱图 */
  byDay: Array<{ day: string; count: number }>
  /** 各会话条数排行 */
  bySession: Array<{ sessionId: string; sessionName: string; count: number }>
  path: string
}

// —— 全局搜索 ——

/** 全局搜索请求。scanLimit 限制回溯深度，避免在超大库上做无界全表扫描 */
export interface GlobalSearchQuery {
  keyword: string
  /** 只搜最近多少条记录；0 或省略 = 不限（大库上会慢） */
  scanLimit?: number
  /** 每一类结果最多返回几条 */
  perKind?: number
  /** 限定会话；空 = 全部 */
  sessionIds?: string[]
  /** 时间下限（毫秒时间戳） */
  from?: number
}

/** 一条搜索命中。frame 与 http 共用一个形状，界面按 kind 分别渲染 */
export interface SearchHit {
  kind: 'frame' | 'http'
  /** 历史库行 id，用于跳转定位 */
  id: number
  sessionId: string
  sessionName: string
  sessionKind: string
  ts: number
  /** 命中行摘要（已截断，含前后文） */
  snippet: string
  /** 关键字在 snippet 中的起始下标，-1 表示未定位 */
  matchAt: number
  matchLen: number
  /** frame 专用 */
  direction?: Direction
  size?: number
  /** http 专用 */
  method?: string
  status?: number
  path?: string
}

export interface GlobalSearchResult {
  keyword: string
  frames: SearchHit[]
  https: SearchHit[]
  /** 满足条件的总命中数（不受 perKind 限制），用于「还有 N 条」提示 */
  frameTotal: number
  httpTotal: number
  /** 命中分布：每个会话各有多少条，用于结果侧的会话聚合 */
  bySession: Array<{ sessionId: string; sessionName: string; count: number }>
  /** 本次实际扫描的行数与耗时，界面上如实告知搜索范围 */
  scanned: number
  elapsedMs: number
  /** 是否因为 scanLimit 而只搜了一部分 */
  truncated: boolean
}

// —— 历史上下文（搜索命中回跳） ——

/**
 * 取某条历史记录在原会话时间轴上的前后文。
 *
 * 为什么需要单独一个查询而不复用 historyQueryFrames：分页查询是「按条件筛一批」，
 * 而这里要的是「以某一行为锚点、向前后各取 N 条」。用分页实现得先算出锚点在
 * 结果集里的 offset，而 offset 会随后续写入漂移；直接按锚点的 (ts, id) 双向取
 * 才是稳定的。
 */
export interface HistoryContextQuery {
  kind: 'frame' | 'http'
  /** 锚点行在历史库中的 id */
  id: number
  /** 向前取多少条（时间更早），默认 50 */
  before?: number
  /** 向后取多少条（时间更晚），默认 50 */
  after?: number
}

export interface HistoryContextResult {
  kind: 'frame' | 'http'
  /** 锚点行 id。界面据此高亮并滚动居中 */
  focusId: number
  /** 锚点在返回数组中的下标；-1 表示锚点行已被清理掉 */
  focusIndex: number
  sessionId: string
  /** 会话名与类型取自历史快照，原会话删掉后仍可读 */
  sessionName: string
  sessionKind: string
  /** kind='frame' 时有值，按时间升序 */
  frames: HistoryFrameRow[]
  /** kind='http' 时有值，按时间升序 */
  https: HistoryHttpRow[]
  /** 更早/更晚方向是否还有记录，用于「继续加载」按钮的可用性 */
  hasBefore: boolean
  hasAfter: boolean
  /** 该会话在历史库中的总条数，给用户一个「上下文占全量多少」的参照 */
  sessionTotal: number
}

/** 会话组织信息补丁：只传要改的字段 */
export interface SessionMetaPatch {
  group?: string
  tags?: string[]
}

export type SessionEvent =
  | { type: 'status'; sessionId: string; status: SessionStatus; detail?: string }
  | { type: 'frame'; frame: Frame }
  | { type: 'metrics'; sessionId: string; metrics: SessionMetrics }
  | { type: 'peer'; sessionId: string; peer: Peer; connected: boolean }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'httpLog'; log: HttpLogEntry }
  | { type: 'modbusValues'; sessionId: string; values: ModbusPointValue[] }
  | { type: 'mqttSubAck'; sessionId: string; filter: string; granted: number; reason?: string }
  | { type: 'modbusSlaveValues'; sessionId: string; regions: ModbusSlaveRegionValues[] }


/** 窗口状态：自绘标题栏需要据此切换最大化/还原图标 */
export interface WindowState {
  maximized: boolean
  fullScreen: boolean
  focused: boolean
}

/**
 * 关于面板与诊断用的运行时信息。
 *
 * 刻意不含 Electron / Chromium / Node 版本：这三项对使用者没有可操作性
 * （知道了也做不了什么），只在开发排错时有用，而开发排错看的是源码不是关于面板。
 * version 仍要保留 —— HAR 导出会把它写进 creator.version 作为工具署名。
 */
export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  userData: string
  workspacePath: string
  historyPath: string
  /** 本机局域网 IPv4 地址，供服务端类工具提示「远程该用哪个地址访问」 */
  lanIps: string[]
}

/**
 * 证书概况。
 *
 * 解析放在主进程：渲染层没有 node:crypto，把 X.509 解析搬到渲染层要么引一个
 * 纯 JS ASN.1 库，要么自己再写一遍——而主进程本来就要用它校验证书能不能起服务。
 */
export interface TlsCertInfo {
  ok: boolean
  /** 解析或校验失败的原因（中文），ok=false 时有值 */
  error?: string
  subject?: string
  issuer?: string
  /** 是否自签（issuer === subject） */
  selfSigned?: boolean
  validFrom?: number
  validTo?: number
  /** 距过期天数，负数表示已过期 */
  daysLeft?: number
  /** SAN 列表，形如 DNS:localhost / IP:127.0.0.1 */
  altNames?: string[]
  fingerprint256?: string
  /** 私钥与证书是否匹配。配错对是 HTTPS 起不来最常见的原因 */
  keyMatch?: boolean
}

export interface TlsGenerateRequest {
  hosts: string[]
  days: number
  /** 落盘文件名前缀，缺省用会话 id */
  name?: string
}

export interface TlsMaterial {
  certPem: string
  keyPem: string
  certPath: string
  keyPath: string
  info: TlsCertInfo
}

/**
 * 应用更新。
 *
 * 状态机刻意做成扁平的一个 phase 字段而不是若干布尔量（checking / available /
 * downloading…）：布尔量组合会出现「既在检查又在下载」这类不可能的状态，而界面
 * 拿到互斥的 phase 就能直接决定显示什么按钮，不用在渲染层再推一遍。
 */
export type UpdatePhase =
  | 'idle'
  /**
   * 更新通道不可用。
   *
   * 现在只有一种成因：这是源码运行（或安装包里没有 app-update.yml），
   * 而不是「用户还没填地址」—— 地址已由打包配置固定，界面上没有可填的东西。
   */
  | 'unconfigured'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** 当前运行版本 */
  currentVersion: string
  /** 服务器上的新版本号，phase 为 available/downloading/downloaded 时有值 */
  newVersion?: string
  /** 发布说明（原样透传，可能是 HTML 或纯文本） */
  releaseNotes?: string
  releaseDate?: string
  /** 0–100，仅 downloading 阶段有值 */
  percent?: number
  /** 已下载 / 总字节 */
  transferred?: number
  total?: number
  /** 字节每秒 */
  bytesPerSecond?: number
  /** 失败原因（中文），phase=error 时有值 */
  error?: string
  /** 上次检查完成时间 */
  checkedAt?: number
}

/**
 * 更新设置。存 userData/update.json。
 *
 * 这里只有两个开关，没有服务器地址 —— 这是一次刻意的收缩。
 *
 * 早先版本把更新源做成运行时可配（自建目录 / GitHub 仓库 + 下载代理），
 * 出发点是「换服务器不用重新打包」。但代价是把一件本该由发布方决定一次的事
 * 摊给了每个使用者：他要自己判断填哪种来源、仓库名怎么写、代理该选哪个，
 * 而任何一处填错的表现都是同一个 404，无从自查。
 *
 * 现在更新地址由打包时的 electron-builder.yml `publish.url` 唯一决定，
 * 随安装包生成 app-update.yml，客户端只管去那一个地址看有没有新版本。
 * 界面上因此不再有任何地址输入框。
 */
export interface UpdateSettings {
  /** 启动后自动检查一次 */
  autoCheck: boolean
  /** 发现新版本后自动下载。默认关：下载完要重启才生效，而重启会掐断正在跑的会话 */
  autoDownload: boolean
}

export const IPC = {
  sessionCreate: 'session:create',
  sessionStart: 'session:start',
  sessionStop: 'session:stop',
  sessionRemove: 'session:remove',
  sessionSend: 'session:send',
  sessionList: 'session:list',
  sessionPeers: 'session:peers',
  sessionKickPeer: 'session:kickPeer',
  sessionUpdateMock: 'session:updateMock',
  sessionUpdateHttpMock: 'session:updateHttpMock',
  sessionRename: 'session:rename',
  sessionUpdateConfig: 'session:updateConfig',
  sessionSetAutoStart: 'session:setAutoStart',
  sessionSetMeta: 'session:setMeta',
  historyQueryFrames: 'history:queryFrames',
  historyQueryHttp: 'history:queryHttp',
  historyStats: 'history:stats',
  historyConfigGet: 'history:configGet',
  historyConfigSet: 'history:configSet',
  historyClear: 'history:clear',
  historyClearSession: 'history:clearSession',
  historyVacuum: 'history:vacuum',
  historyExport: 'history:export',
  historySessions: 'history:sessions',
  historySearch: 'history:search',
  historyContext: 'history:context',
  workspaceInfo: 'workspace:info',
  workspaceClear: 'workspace:clear',
  httpTestSend: 'http:testSend',
  serialList: 'serial:list',
  fileSaveText: 'file:saveText',
  fileOpenText: 'file:openText',
  // —— TLS 证书 ——
  tlsGenerate: 'tls:generate',
  tlsInspect: 'tls:inspect',
  tlsImport: 'tls:import',
  tlsExport: 'tls:export',
  // —— MQTT ——
  mqttSubscribe: 'mqtt:subscribe',
  mqttUnsubscribe: 'mqtt:unsubscribe',
  mqttUpdateSubs: 'mqtt:updateSubs',
  // —— Modbus ——
  modbusReadPoint: 'modbus:readPoint',
  modbusWritePoint: 'modbus:writePoint',
  modbusUpdatePoints: 'modbus:updatePoints',
  // —— Modbus 从站模拟 ——
  modbusSlaveUpdateRegions: 'modbusSlave:updateRegions',
  modbusSlaveWrite: 'modbusSlave:write',
  modbusSlaveSnapshot: 'modbusSlave:snapshot',
  // —— 窗口与应用级（系统功能） ——
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowState: 'window:state',
  windowEvent: 'window:event',
  appInfo: 'app:info',
  // —— 应用更新（M31） ——
  updateGetState: 'update:getState',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateSettingsGet: 'update:settingsGet',
  updateSettingsSet: 'update:settingsSet',
  updateEvent: 'update:event',
  appToggleDevTools: 'app:toggleDevTools',
  appRelaunch: 'app:relaunch',
  appNotify: 'app:notify',
  shellOpenPath: 'shell:openPath',
  event: 'session:event'
} as const
