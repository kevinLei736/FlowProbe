import { useEffect, useRef, useState } from 'react'
import type {
  ConnectionKind,
  FramingMode,
  ModbusConfig,
  ModbusSlaveConfig,
  MqttConfig,
  SessionConfig
} from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { KIND_META, keyHint } from '../../app/meta'
import { defaultHttpMockConfig } from '../../features/http-mock/defaults'
import { Select } from '../../components/ui/Select'
import { ResizableTextarea } from '../../components/ui/ResizableTextarea'

const KINDS: ConnectionKind[] = [
  'tcp-client',
  'tcp-server',
  'ws-client',
  'ws-server',
  'udp-client',
  'udp-server',
  'serial',
  'http-mock',
  'mqtt-client',
  'modbus-tcp',
  'modbus-rtu',
  'modbus-slave'
]

/**
 * MQTT / Modbus 的默认配置在渲染层再写一份。
 * 主进程里也有一份 default 工厂，但那两个文件依赖 node 模块，渲染层不能引，
 * 与其为了共享几十行常量把工厂挪到 shared 再让主进程绕一层，
 * 不如在建会话时给一份完整初值——主进程收到配置后会用自己的默认值补齐缺项，
 * 两边不一致也不会出错。
 */
function initialMqtt(): MqttConfig {
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

function initialModbus(transport: ModbusConfig['transport']): ModbusConfig {
  return {
    transport,
    host: '127.0.0.1',
    port: 502,
    unitId: 1,
    timeoutMs: 1000,
    retries: 1,
    gapMs: 20,
    wordOrder: 'be',
    byteOrder: 'be',
    mergeGap: 8,
    points: []
  }
}

/**
 * 从站默认数据区。
 *
 * 为什么建会话就给一套示例区而不是留空：从站空着等于「任何地址都非法」，
 * 新建后第一次连主站必然全是异常，用户会以为功能坏了。给一套能立刻读出数的区，
 * 主站接上去就有数据，再按需改。
 */
function initialSlave(transport: ModbusSlaveConfig['transport']): ModbusSlaveConfig {
  return {
    transport,
    host: '0.0.0.0',
    port: 502,
    unitId: 1,
    acceptAnyUnit: false,
    responseDelayMs: 0,
    dropRate: 0,
    exception: { enabled: false, code: 4, funcs: [] },
    maxClients: 8,
    regions: [
      {
        id: 'rg-holding',
        name: '保持寄存器 0-19',
        area: 'holding',
        start: 0,
        count: 20,
        initial: 0,
        animate: 'ramp',
        animateMs: 1000,
        animateMin: 0,
        animateMax: 1000,
        animateStep: 7,
        enabled: true
      },
      {
        id: 'rg-input',
        name: '输入寄存器 0-9',
        area: 'input',
        start: 0,
        count: 10,
        initial: 0,
        readOnly: true,
        animate: 'sine',
        animateMs: 500,
        animateMin: 200,
        animateMax: 800,
        enabled: true
      },
      {
        id: 'rg-coil',
        name: '线圈 0-15',
        area: 'coil',
        start: 0,
        count: 16,
        initial: 0,
        animate: 'none',
        enabled: true
      },
      {
        id: 'rg-discrete',
        name: '离散输入 0-15',
        area: 'discrete',
        start: 0,
        count: 16,
        initial: 0,
        readOnly: true,
        animate: 'toggle',
        animateMs: 2000,
        enabled: true
      }
    ]
  }
}

export function NewSessionDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const createSession = useStore((s) => s.createSession)
  const [kind, setKind] = useState<ConnectionKind>('tcp-client')
  const [name, setName] = useState('')
  /**
   * 表单校验提示。
   *
   * 端口原来是直接 Number() 塞进配置的：输入「abc」会变成 NaN，
   * 会话照建不误，直到点启动才抛出 listen(NaN) 之类的底层错误。
   * 把问题拦在创建这一刻，用户才知道该改哪个框。
   */
  const [formError, setFormError] = useState('')

  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('9000')
  const [url, setUrl] = useState('ws://127.0.0.1:8080')
  const [subProtocols, setSubProtocols] = useState('')
  const [wsHeaders, setWsHeaders] = useState('')
  // Header 框高度做成状态：受控高度才不会被 flex 布局回压（原生 resize 在此失效）
  const [wsHeaderH, setWsHeaderH] = useState(96)
  const [pingIntervalMs, setPingIntervalMs] = useState('0')
  const [wsSendMode, setWsSendMode] = useState<'text' | 'binary'>('text')

  // UDP
  const [udpHost, setUdpHost] = useState('127.0.0.1')
  const [udpPort, setUdpPort] = useState('9100')
  const [udpBindHost, setUdpBindHost] = useState('0.0.0.0')
  const [udpBindPort, setUdpBindPort] = useState('0')
  const [udpBroadcast, setUdpBroadcast] = useState(false)
  const [udpMulticastGroup, setUdpMulticastGroup] = useState('')
  const [udpTtl, setUdpTtl] = useState('1')
  const [udpReuseAddr, setUdpReuseAddr] = useState(true)
  const [udpPeerIdleMs, setUdpPeerIdleMs] = useState('60000')

  // 串口
  const [serialPorts, setSerialPorts] = useState<string[]>([])
  const [serialPath, setSerialPath] = useState('COM1')
  const [baudRate, setBaudRate] = useState('115200')
  const [dataBits, setDataBits] = useState('8')
  const [stopBits, setStopBits] = useState('1')
  const [parity, setParity] = useState('none')
  const [flow, setFlow] = useState('none')
  const [dtr, setDtr] = useState(true)
  const [rts, setRts] = useState(true)

  // 高级
  const [showAdv, setShowAdv] = useState(false)
  const [autoReconnect, setAutoReconnect] = useState(true)
  const [reconnectIntervalMs, setReconnectIntervalMs] = useState('1000')
  const [reconnectMaxIntervalMs, setReconnectMaxIntervalMs] = useState('30000')
  const [reconnectMaxAttempts, setReconnectMaxAttempts] = useState('0')
  const [connectTimeoutMs, setConnectTimeoutMs] = useState('5000')
  const [noDelay, setNoDelay] = useState(true)
  const [maxConnections, setMaxConnections] = useState('0')
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false)
  const [heartbeatContent, setHeartbeatContent] = useState('PING')
  const [heartbeatIntervalMs, setHeartbeatIntervalMs] = useState('5000')
  const [framingMode, setFramingMode] = useState<FramingMode>('none')
  const [delimiter, setDelimiter] = useState('0d0a')

  // Modbus 从站模拟。
  // 声明位置刻意提到下面这批 isXxx 标志之前：isSerial 要读 slTransport
  // 判断「从站选了 RTU 也得显示串口表单」，const 的块级作用域不允许倒着用。
  const [slTransport, setSlTransport] = useState('tcp')
  const [slHost, setSlHost] = useState('0.0.0.0')
  // 默认 5020 而非 502：502 是特权端口，本机自测常因权限起不来
  const [slPort, setSlPort] = useState('5020')
  const [slUnitId, setSlUnitId] = useState('1')
  const [slAnyUnit, setSlAnyUnit] = useState(false)

  const isTcpClient = kind === 'tcp-client'
  const isTcpServer = kind === 'tcp-server'
  const isTcp = isTcpClient || isTcpServer
  const isMqtt = kind === 'mqtt-client'
  const isModbusTcp = kind === 'modbus-tcp'
  const isModbusRtu = kind === 'modbus-rtu'
  const isSlave = kind === 'modbus-slave'
  const isModbus = isModbusTcp || isModbusRtu
  // Modbus RTU 走串口，串口那组表单要一起显示出来（从站选了 RTU 同理）
  const isSerial = kind === 'serial' || isModbusRtu || (isSlave && slTransport === 'rtu')
  const isWsClient = kind === 'ws-client'
  const isUdpClient = kind === 'udp-client'
  const isUdpServer = kind === 'udp-server'
  const isUdp = isUdpClient || isUdpServer
  const isHttpMock = kind === 'http-mock'
  // 会主动向外拨号的会话才有「断线重连」；服务端只负责监听
  const canReconnect = isTcpClient || isWsClient || isMqtt || (isSerial && !isModbusRtu)
  const hasAdvanced = (isTcp || isSerial || isWsClient) && !isModbus

  // MQTT
  const [mqttUrl, setMqttUrl] = useState('mqtt://127.0.0.1:1883')
  const [mqttClientId, setMqttClientId] = useState('toolbox-' + Math.random().toString(16).slice(2, 8))
  const [mqttVersion, setMqttVersion] = useState('4')
  const [mqttUser, setMqttUser] = useState('')
  const [mqttPass, setMqttPass] = useState('')
  const [mqttKeepalive, setMqttKeepalive] = useState('60')
  const [mqttClean, setMqttClean] = useState(true)
  const [mqttTopic, setMqttTopic] = useState('')

  // Modbus
  const [mbHost, setMbHost] = useState('127.0.0.1')
  const [mbPort, setMbPort] = useState('502')
  const [mbUnitId, setMbUnitId] = useState('1')
  const [mbTimeout, setMbTimeout] = useState('1000')
  const [mbWordOrder, setMbWordOrder] = useState('be')
  const [mbByteOrder, setMbByteOrder] = useState('be')
  const [mbOverTcp, setMbOverTcp] = useState(false)


  const [autoStart, setAutoStart] = useState(false)
  const [httpPort, setHttpPort] = useState('3000')
  const [httpHttps, setHttpHttps] = useState(false)
  const [httpCors, setHttpCors] = useState(true)

  const refreshPorts = (): void => {
    window.toolbox.listSerialPorts().then((ports) => {
      setSerialPorts(ports)
      if (ports.length && !ports.includes(serialPath)) setSerialPath(ports[0])
    })
  }

  useEffect(() => {
    if (isSerial) refreshPorts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSerial])

  /** 创建前校验：把「建完才发现连不上」的问题提前到表单里 */
  const validate = (): string => {
    const portOk = (raw: string): boolean => {
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 && n < 65536
    }
    if (isTcp && !host.trim()) return '请填写目标地址（服务端则填监听地址）'
    if (isTcp && !portOk(port)) return '端口需为 1–65535 的整数'
    if (isWsClient && !/^wss?:\/\//i.test(url.trim())) {
      return 'WebSocket 地址需以 ws:// 或 wss:// 开头'
    }
    if (kind === 'ws-server' && !portOk(port)) return 'WebSocket 监听端口需为 1–65535 的整数'
    if (isUdpClient) {
      if (!udpHost.trim()) return '请填写 UDP 目标地址'
      if (!portOk(udpPort)) return 'UDP 目标端口需为 1–65535 的整数'
      const bind = Number(udpBindPort)
      if (udpBindPort.trim() !== '' && bind !== 0 && !portOk(udpBindPort)) {
        return '本地绑定端口需为 0（随机）或 1–65535'
      }
    }
    if (isUdpServer) {
      const effective = Number(udpBindPort) || Number(udpPort)
      if (!Number.isInteger(effective) || effective <= 0 || effective >= 65536) {
        return 'UDP 监听端口需为 1–65535 的整数'
      }
    }
    if (isHttpMock && !portOk(httpPort)) return 'HTTP Mock 端口需为 1–65535 的整数'
    if (isSerial && !serialPath.trim()) return '请选择串口'
    if (isModbusTcp && !mbHost.trim()) return '请填写 Modbus 主机地址'
    if (isModbusTcp && !portOk(mbPort)) return 'Modbus 端口需为 1–65535 的整数'
    if (isSlave && slTransport !== 'rtu' && !portOk(slPort)) {
      return '从站监听端口需为 1–65535 的整数'
    }
    if (isMqtt && !/^(mqtt|mqtts|ws|wss):\/\//i.test(mqttUrl.trim())) {
      return 'MQTT 地址需以 mqtt://、mqtts://、ws:// 或 wss:// 开头'
    }
    return ''
  }

  const submit = async (): Promise<void> => {
    const error = validate()
    if (error) {
      setFormError(error)
      return
    }
    setFormError('')
    const config: SessionConfig = {}
    if (isTcp) {
      config.host = host
      config.port = Number(port)
      config.noDelay = noDelay
      config.framing = { mode: framingMode, delimiter }
    }
    if (isTcpClient) {
      config.autoReconnect = autoReconnect
      config.reconnectIntervalMs = Number(reconnectIntervalMs)
      config.reconnectMaxIntervalMs = Number(reconnectMaxIntervalMs)
      config.reconnectMaxAttempts = Number(reconnectMaxAttempts)
      config.connectTimeoutMs = Number(connectTimeoutMs)
      config.heartbeatEnabled = heartbeatEnabled
      config.heartbeatContent = heartbeatContent
      config.heartbeatEncoding = 'utf8'
      config.heartbeatIntervalMs = Number(heartbeatIntervalMs)
    }
    if (isTcpServer) config.maxConnections = Number(maxConnections)
    if (isUdp) {
      // 刻意不写 framing：数据报自带边界，配置项本身在 UDP 上没有意义，
      // 写个 none 只会让检查器多出一行无用参数
      config.udpBroadcast = udpBroadcast
      config.udpMulticastGroup = udpMulticastGroup.trim()
      config.udpTtl = Number(udpTtl) || 1
      config.udpReuseAddr = udpReuseAddr
    }
    if (isUdpClient) {
      config.host = udpHost
      config.port = Number(udpPort)
      config.udpBindHost = udpBindHost
      config.udpBindPort = Number(udpBindPort) || 0
      config.heartbeatEnabled = heartbeatEnabled
      config.heartbeatContent = heartbeatContent
      config.heartbeatEncoding = 'utf8'
      config.heartbeatIntervalMs = Number(heartbeatIntervalMs)
    }
    if (isUdpServer) {
      config.host = udpBindHost
      config.port = Number(udpBindPort) || Number(udpPort)
      config.udpBindHost = udpBindHost
      config.udpBindPort = Number(udpBindPort) || Number(udpPort)
      config.udpPeerIdleMs = Number(udpPeerIdleMs) || 0
    }
    if (kind === 'ws-client' || kind === 'ws-server') {
      const protos = subProtocols.split(',').map((s) => s.trim()).filter(Boolean)
      if (protos.length) config.subProtocols = protos
      config.wsSendMode = wsSendMode
    }
    if (kind === 'ws-client') {
      config.url = url
      config.pingIntervalMs = Number(pingIntervalMs)
      config.autoReconnect = autoReconnect
      config.reconnectIntervalMs = Number(reconnectIntervalMs)
      config.reconnectMaxIntervalMs = Number(reconnectMaxIntervalMs)
      config.reconnectMaxAttempts = Number(reconnectMaxAttempts)
      const headers: Record<string, string> = {}
      wsHeaders.split('\n').forEach((line) => {
        const idx = line.indexOf(':')
        if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      })
      if (Object.keys(headers).length) config.headers = headers
    }
    if (kind === 'ws-server') {
      config.port = Number(port)
      config.path = '/'
      config.maxConnections = Number(maxConnections)
    }
    if (isSerial) {
      config.autoReconnect = autoReconnect
      config.reconnectIntervalMs = Number(reconnectIntervalMs)
      config.reconnectMaxIntervalMs = Number(reconnectMaxIntervalMs)
      config.reconnectMaxAttempts = Number(reconnectMaxAttempts)
      config.serialPath = serialPath
      config.baudRate = Number(baudRate)
      config.dataBits = Number(dataBits)
      config.stopBits = Number(stopBits)
      config.parity = parity as SessionConfig['parity']
      config.rtscts = flow === 'rtscts'
      config.xon = flow === 'xonxoff'
      config.xoff = flow === 'xonxoff'
      config.dtr = dtr
      config.rts = rts
      config.framing = { mode: framingMode, delimiter }
    }
    if (isHttpMock) {
      config.port = Number(httpPort)
      config.https = httpHttps
      config.httpMock = { ...defaultHttpMockConfig(), corsEnabled: httpCors }
      if (httpHttps) {
        /**
         * 勾了 HTTPS 就顺手把证书生成好。
         *
         * 之前这里只写 `https = true`，而证书字段是空的——会话建完一启动必定失败，
         * 错误还是 OpenSSL 的英文底层报错。既然本地调试的答案几乎总是「自签证书」，
         * 就别让用户先撞一次墙再去找面板。生成失败也不拦创建，面板里还能补。
         */
        try {
          const m = await window.toolbox.tlsGenerate({
            hosts: ['localhost', '127.0.0.1'],
            days: 825,
            name: name.trim() || 'mock'
          })
          config.tlsCert = m.certPem
          config.tlsKey = m.keyPem
          config.tlsCertPath = m.certPath
          config.tlsKeyPath = m.keyPath
        } catch {
          // 忽略：证书面板里可以手动生成或导入
        }
      }
    }
    if (isMqtt) {
      const mqtt = initialMqtt()
      mqtt.url = mqttUrl
      mqtt.clientId = mqttClientId
      mqtt.protocolVersion = mqttVersion === '5' ? 5 : 4
      mqtt.keepalive = Number(mqttKeepalive) || 0
      mqtt.cleanStart = mqttClean
      if (mqttUser) mqtt.username = mqttUser
      if (mqttPass) mqtt.password = mqttPass
      // 建会话时填了主题就直接预置一条订阅，连上即收，省一步手动配置
      if (mqttTopic.trim()) {
        mqtt.subscriptions = [
          { id: Math.random().toString(36).slice(2), filter: mqttTopic.trim(), qos: 0, enabled: true }
        ]
      }
      config.url = mqttUrl
      config.mqtt = mqtt
      config.autoReconnect = autoReconnect
      config.reconnectIntervalMs = Number(reconnectIntervalMs)
      config.reconnectMaxIntervalMs = Number(reconnectMaxIntervalMs)
      config.reconnectMaxAttempts = Number(reconnectMaxAttempts)
    }
    if (isSlave) {
      const slave = initialSlave(slTransport as ModbusSlaveConfig['transport'])
      slave.host = slHost
      slave.port = Number(slPort) || 5020
      slave.unitId = Number(slUnitId) || 1
      slave.acceptAnyUnit = slAnyUnit
      config.modbusSlave = slave
      if (slTransport !== 'rtu') {
        config.host = slHost
        config.port = slave.port
      }
    }
    if (isModbus) {
      const modbus = initialModbus(
        isModbusRtu ? 'rtu' : mbOverTcp ? 'rtu-over-tcp' : 'tcp'
      )
      modbus.host = mbHost
      modbus.port = Number(mbPort) || 502
      modbus.unitId = Number(mbUnitId) || 1
      modbus.timeoutMs = Number(mbTimeout) || 1000
      modbus.wordOrder = mbWordOrder as 'be' | 'le'
      modbus.byteOrder = mbByteOrder as 'be' | 'le'
      config.modbus = modbus
      if (!isModbusRtu) {
        config.host = mbHost
        config.port = modbus.port
      }
    }
    const finalName = name.trim() || defaultName(kind, config)
    await createSession(kind, finalName, config, autoStart)
    onClose()
  }

  // Esc 关闭、Ctrl/⌘+Enter 创建：对话框里手不用离开键盘
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void submitRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.title}>新建连接</div>

        <label style={styles.label}>连接类型</label>
        <div style={styles.kinds}>
          {KINDS.map((k) => (
            <button
              key={k}
              style={{ ...styles.kindBtn, ...(k === kind ? styles.kindActive : {}) }}
              onClick={() => {
                setKind(k)
                setFormError('')
              }}
            >
              <span style={{ ...styles.kindIcon, ...(k === kind ? styles.kindIconOn : {}) }}>{KIND_META[k].icon}</span>
              {KIND_META[k].label}
            </button>
          ))}
        </div>

        <label style={styles.label}>会话名称（可选）</label>
        <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="自动命名" />

        {isTcp && (
          <div style={styles.row}>
            <div style={styles.col}>
              <label style={styles.label}>{isTcpServer ? '监听地址' : '目标地址'}</label>
              <input style={styles.input} value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div style={{ ...styles.col, maxWidth: 120 }}>
              <label style={styles.label}>端口</label>
              <input style={styles.input} value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>
        )}

        {kind === 'ws-client' && (
          <>
            <label style={styles.label}>URL (ws:// 或 wss://)</label>
            <input style={styles.input} value={url} onChange={(e) => setUrl(e.target.value)} />
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>子协议(逗号分隔)</label>
                <input style={styles.input} value={subProtocols} onChange={(e) => setSubProtocols(e.target.value)} placeholder="可选" />
              </div>
              <div style={{ ...styles.col, maxWidth: 130 }}>
                <label style={styles.label}>Ping 间隔(ms)</label>
                <input style={styles.input} value={pingIntervalMs} onChange={(e) => setPingIntervalMs(e.target.value)} />
              </div>
            </div>
            <label style={styles.label}>自定义 Header（每行一条 Key: Value）</label>
            {/* 换成受控高度的可拉伸输入：原生 resize 在这个 flex 列弹窗里会被布局压回去，
                手柄看着能拖却没反应。鉴权 token 往往很长，默认给足几行并允许继续拉高。 */}
            <ResizableTextarea
              value={wsHeaders}
              onChange={setWsHeaders}
              height={wsHeaderH}
              onHeightChange={setWsHeaderH}
              min={72}
              max={320}
              placeholder={'Authorization: Bearer xxx\nX-Device-Id: 1001'}
            />
            <div style={styles.col}>
              <label style={styles.label}>发送模式</label>
              <Select
                style={styles.select}
                value={wsSendMode}
                onChange={(v) => setWsSendMode(v as 'text' | 'binary')}
                options={[
                  { value: 'text', label: '文本帧' },
                  { value: 'binary', label: '二进制帧' }
                ]}
              />
            </div>
          </>
        )}

        {kind === 'ws-server' && (
          <>
            <label style={styles.label}>监听端口</label>
            <input style={styles.input} value={port} onChange={(e) => setPort(e.target.value)} />
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>子协议(逗号分隔)</label>
                <input style={styles.input} value={subProtocols} onChange={(e) => setSubProtocols(e.target.value)} placeholder="可选" />
              </div>
              <div style={{ ...styles.col, maxWidth: 130 }}>
                <label style={styles.label}>最大连接(0=不限)</label>
                <input style={styles.input} value={maxConnections} onChange={(e) => setMaxConnections(e.target.value)} />
              </div>
            </div>
            <div style={styles.col}>
              <label style={styles.label}>发送模式</label>
              <Select
                style={styles.select}
                value={wsSendMode}
                onChange={(v) => setWsSendMode(v as 'text' | 'binary')}
                options={[
                  { value: 'text', label: '文本帧' },
                  { value: 'binary', label: '二进制帧' }
                ]}
              />
            </div>
          </>
        )}

        {isSerial && (
          <>
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>串口号</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Select
                    style={{ ...styles.select, flex: 1 }}
                    value={serialPath}
                    onChange={setSerialPath}
                    options={
                      serialPorts.length === 0
                        ? [{ value: serialPath, label: serialPath }]
                        : serialPorts.map((p) => ({ value: p, label: p }))
                    }
                  />
                  <button style={styles.refresh} onClick={refreshPorts} title="刷新端口">⟳</button>
                </div>
              </div>
              <div style={{ ...styles.col, maxWidth: 140 }}>
                <label style={styles.label}>波特率</label>
                <Select
                  style={styles.select}
                  value={baudRate}
                  onChange={setBaudRate}
                  searchable={false}
                  options={['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map((b) => ({
                    value: b,
                    label: b
                  }))}
                />
              </div>
            </div>
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>数据位</label>
                <Select
                  style={styles.select}
                  value={dataBits}
                  onChange={setDataBits}
                  options={['5', '6', '7', '8'].map((d) => ({ value: d, label: d }))}
                />
              </div>
              <div style={styles.col}>
                <label style={styles.label}>停止位</label>
                <Select
                  style={styles.select}
                  value={stopBits}
                  onChange={setStopBits}
                  options={['1', '2'].map((d) => ({ value: d, label: d }))}
                />
              </div>
              <div style={styles.col}>
                <label style={styles.label}>校验位</label>
                <Select
                  style={styles.select}
                  value={parity}
                  onChange={setParity}
                  options={[
                    { value: 'none', label: '无校验 none' },
                    { value: 'even', label: '偶校验 even' },
                    { value: 'odd', label: '奇校验 odd' },
                    { value: 'mark', label: '恒 1 mark' },
                    { value: 'space', label: '恒 0 space' }
                  ]}
                />
              </div>
            </div>
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>流控</label>
                <Select
                  style={styles.select}
                  value={flow}
                  onChange={setFlow}
                  options={[
                    { value: 'none', label: '无' },
                    { value: 'rtscts', label: 'RTS/CTS' },
                    { value: 'xonxoff', label: 'XON/XOFF' }
                  ]}
                />
              </div>
              <label style={{ ...styles.check, alignSelf: 'flex-end' }}>
                <input type="checkbox" checked={dtr} onChange={(e) => setDtr(e.target.checked)} /> DTR
              </label>
              <label style={{ ...styles.check, alignSelf: 'flex-end' }}>
                <input type="checkbox" checked={rts} onChange={(e) => setRts(e.target.checked)} /> RTS
              </label>
            </div>
          </>
        )}

        {hasAdvanced && (
          <>
            <button style={styles.advToggle} onClick={() => setShowAdv((v) => !v)}>
              {showAdv ? '▾' : '▸'} 高级设置
            </button>
            {showAdv && (
              <div style={styles.adv}>
                {(isTcp || isSerial) && (
                <div style={styles.row}>
                  <div style={styles.col}>
                    <label style={styles.label}>分帧策略</label>
                    <Select
                      style={styles.select}
                      value={framingMode}
                      onChange={(v) => setFramingMode(v as FramingMode)}
                      options={[
                        { value: 'none', label: '不分帧' },
                        { value: 'delimiter', label: '按分隔符' },
                        { value: 'length', label: '按长度域' },
                        { value: 'timeout', label: '按静默超时' }
                      ]}
                    />
                  </div>
                  {framingMode === 'delimiter' && (
                    <div style={styles.col}>
                      <label style={styles.label}>分隔符(HEX)</label>
                      <input style={styles.input} value={delimiter} onChange={(e) => setDelimiter(e.target.value)} />
                    </div>
                  )}
                </div>
                )}

                {isTcp && (
                  <label style={styles.check}>
                    <input type="checkbox" checked={noDelay} onChange={(e) => setNoDelay(e.target.checked)} />
                    禁用 Nagle (TCP_NODELAY)
                  </label>
                )}

                {isTcpClient && (
                  <div style={styles.col}>
                    <label style={styles.label}>连接超时(ms)</label>
                    <input style={styles.input} value={connectTimeoutMs} onChange={(e) => setConnectTimeoutMs(e.target.value)} />
                  </div>
                )}

                {canReconnect && (
                  <>
                    <label style={styles.check}>
                      <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
                      {isSerial ? '断开后自动重开串口' : '断线自动重连'}
                    </label>
                    {autoReconnect && (
                      <>
                        <div style={styles.row}>
                          <div style={styles.col}>
                            <label style={styles.label}>首次等待(ms)</label>
                            <input style={styles.input} value={reconnectIntervalMs} onChange={(e) => setReconnectIntervalMs(e.target.value)} />
                          </div>
                          <div style={styles.col}>
                            <label style={styles.label}>等待上限(ms)</label>
                            <input style={styles.input} value={reconnectMaxIntervalMs} onChange={(e) => setReconnectMaxIntervalMs(e.target.value)} />
                          </div>
                          <div style={{ ...styles.col, maxWidth: 120 }}>
                            <label style={styles.label}>次数(0=不限)</label>
                            <input style={styles.input} value={reconnectMaxAttempts} onChange={(e) => setReconnectMaxAttempts(e.target.value)} />
                          </div>
                        </div>
                        <div style={styles.advHint}>
                          等待时长按 2 倍递增并封顶：{reconnectIntervalMs}ms → {Number(reconnectIntervalMs) * 2}ms →{' '}
                          {Number(reconnectIntervalMs) * 4}ms … 最长 {reconnectMaxIntervalMs}ms，避免对端长期不在时刷屏
                        </div>
                      </>
                    )}
                  </>
                )}

                {isTcpClient && (
                  <>
                    <label style={styles.check}>
                      <input type="checkbox" checked={heartbeatEnabled} onChange={(e) => setHeartbeatEnabled(e.target.checked)} />
                      启用心跳
                    </label>
                    {heartbeatEnabled && (
                      <div style={styles.row}>
                        <div style={styles.col}>
                          <label style={styles.label}>心跳内容</label>
                          <input style={styles.input} value={heartbeatContent} onChange={(e) => setHeartbeatContent(e.target.value)} />
                        </div>
                        <div style={{ ...styles.col, maxWidth: 120 }}>
                          <label style={styles.label}>间隔(ms)</label>
                          <input style={styles.input} value={heartbeatIntervalMs} onChange={(e) => setHeartbeatIntervalMs(e.target.value)} />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {isTcpServer && (
                  <div style={styles.col}>
                    <label style={styles.label}>最大连接数(0=不限)</label>
                    <input style={styles.input} value={maxConnections} onChange={(e) => setMaxConnections(e.target.value)} />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {isMqtt && (
          <>
            <label style={styles.label}>Broker 地址</label>
            <input style={styles.input} value={mqttUrl} onChange={(e) => setMqttUrl(e.target.value)} placeholder="mqtt://127.0.0.1:1883" />
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>客户端 ID</label>
                <input style={styles.input} value={mqttClientId} onChange={(e) => setMqttClientId(e.target.value)} />
              </div>
              <div style={{ ...styles.col, maxWidth: 120 }}>
                <label style={styles.label}>协议版本</label>
                <Select
                  style={styles.select}
                  value={mqttVersion}
                  onChange={setMqttVersion}
                  options={[
                    { value: '4', label: '3.1.1' },
                    { value: '5', label: '5.0' }
                  ]}
                />
              </div>
            </div>
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>用户名</label>
                <input style={styles.input} value={mqttUser} onChange={(e) => setMqttUser(e.target.value)} placeholder="可选" />
              </div>
              <div style={styles.col}>
                <label style={styles.label}>密码</label>
                <input style={styles.input} type="password" value={mqttPass} onChange={(e) => setMqttPass(e.target.value)} placeholder="可选" />
              </div>
              <div style={{ ...styles.col, maxWidth: 110 }}>
                <label style={styles.label}>保活(s)</label>
                <input style={styles.input} value={mqttKeepalive} onChange={(e) => setMqttKeepalive(e.target.value)} />
              </div>
            </div>
            <label style={styles.label}>初始订阅主题（可选，支持 + 与 #）</label>
            <input style={{ ...styles.input, fontFamily: 'var(--font-mono)' }} value={mqttTopic} onChange={(e) => setMqttTopic(e.target.value)} placeholder="sensor/+/temperature" />
            <label style={styles.check}>
              <input type="checkbox" checked={mqttClean} onChange={(e) => setMqttClean(e.target.checked)} />
              清理会话（关闭后 Broker 会保留离线消息）
            </label>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              创建后可在会话内「MQTT 设置」面板增删订阅、配置遗嘱消息，改订阅不会断开连接。
            </div>
          </>
        )}

        {isModbus && (
          <>
            {isModbusTcp && (
              <>
                <div style={styles.row}>
                  <div style={styles.col}>
                    <label style={styles.label}>从站地址</label>
                    <input style={styles.input} value={mbHost} onChange={(e) => setMbHost(e.target.value)} />
                  </div>
                  <div style={{ ...styles.col, maxWidth: 110 }}>
                    <label style={styles.label}>端口</label>
                    <input style={styles.input} value={mbPort} onChange={(e) => setMbPort(e.target.value)} />
                  </div>
                </div>
                <label style={styles.check}>
                  <input type="checkbox" checked={mbOverTcp} onChange={(e) => setMbOverTcp(e.target.checked)} />
                  RTU over TCP（串口透传网关，报文带 CRC 而非 MBAP）
                </label>
              </>
            )}
            <div style={styles.row}>
              <div style={{ ...styles.col, maxWidth: 130 }}>
                <label style={styles.label}>Unit ID</label>
                <input style={styles.input} value={mbUnitId} onChange={(e) => setMbUnitId(e.target.value)} />
              </div>
              <div style={{ ...styles.col, maxWidth: 130 }}>
                <label style={styles.label}>响应超时(ms)</label>
                <input style={styles.input} value={mbTimeout} onChange={(e) => setMbTimeout(e.target.value)} />
              </div>
              <div style={styles.col}>
                <label style={styles.label}>字序</label>
                <Select
                  style={styles.select}
                  value={mbWordOrder}
                  onChange={setMbWordOrder}
                  options={[
                    { value: 'be', label: '高字在前 (AB CD)' },
                    { value: 'le', label: '低字在前 (CD AB)' }
                  ]}
                />
              </div>
              <div style={styles.col}>
                <label style={styles.label}>字节序</label>
                <Select
                  style={styles.select}
                  value={mbByteOrder}
                  onChange={setMbByteOrder}
                  options={[
                    { value: 'be', label: '大端' },
                    { value: 'le', label: '小端' }
                  ]}
                />
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              创建后在会话内「点表」面板填写地址与类型即可开始轮询，工程值与原始 HEX 并排显示，字序不对一眼能看出来。
            </div>
          </>
        )}

        {isSlave && (
          <>
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>传输方式</label>
                <Select
                  style={styles.select}
                  value={slTransport}
                  onChange={setSlTransport}
                  options={[
                    { value: 'tcp', label: 'Modbus TCP（监听）' },
                    { value: 'rtu-over-tcp', label: 'RTU over TCP（监听）' },
                    { value: 'rtu', label: 'Modbus RTU（串口应答）' }
                  ]}
                />
              </div>
              <div style={{ ...styles.col, maxWidth: 120 }}>
                <label style={styles.label}>本机 Unit ID</label>
                <input style={styles.input} value={slUnitId} onChange={(e) => setSlUnitId(e.target.value)} />
              </div>
            </div>
            {slTransport !== 'rtu' && (
              <div style={styles.row}>
                <div style={styles.col}>
                  <label style={styles.label}>监听地址</label>
                  <input
                    style={styles.input}
                    value={slHost}
                    title="0.0.0.0 = 所有网卡；只允许本机访问可填 127.0.0.1"
                    onChange={(e) => setSlHost(e.target.value)}
                  />
                </div>
                <div style={{ ...styles.col, maxWidth: 120 }}>
                  <label style={styles.label}>监听端口</label>
                  <input style={styles.input} value={slPort} onChange={(e) => setSlPort(e.target.value)} />
                </div>
              </div>
            )}
            <label style={styles.check}>
              <input type="checkbox" checked={slAnyUnit} onChange={(e) => setSlAnyUnit(e.target.checked)} />
              接受任意从站地址（一个从站冒充整条总线）
            </label>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              创建后自带一套示例数据区（保持寄存器递增、输入寄存器正弦、线圈可写），主站接上就能读到数。
              端口默认 5020 而非 502：502 属特权端口，本机自测常因权限起不来。
            </div>
          </>
        )}

        {isUdp && (
          <>
            {isUdpClient && (
              <div style={styles.row}>
                <div style={styles.col}>
                  <label style={styles.label}>默认目标地址</label>
                  <input style={styles.input} value={udpHost} onChange={(e) => setUdpHost(e.target.value)} />
                </div>
                <div style={{ ...styles.col, maxWidth: 120 }}>
                  <label style={styles.label}>目标端口</label>
                  <input style={styles.input} value={udpPort} onChange={(e) => setUdpPort(e.target.value)} />
                </div>
              </div>
            )}
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>本地绑定地址</label>
                <input style={styles.input} value={udpBindHost} onChange={(e) => setUdpBindHost(e.target.value)} />
              </div>
              <div style={{ ...styles.col, maxWidth: 140 }}>
                <label style={styles.label}>{isUdpServer ? '监听端口' : '本地端口(0=随机)'}</label>
                <input style={styles.input} value={udpBindPort} onChange={(e) => setUdpBindPort(e.target.value)} />
              </div>
            </div>
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>组播组地址（可选）</label>
                <input style={styles.input} value={udpMulticastGroup} onChange={(e) => setUdpMulticastGroup(e.target.value)} placeholder="如 239.0.0.1" />
              </div>
              <div style={{ ...styles.col, maxWidth: 110 }}>
                <label style={styles.label}>组播 TTL</label>
                <input style={styles.input} value={udpTtl} onChange={(e) => setUdpTtl(e.target.value)} />
              </div>
              {isUdpServer && (
                <div style={{ ...styles.col, maxWidth: 150 }}>
                  <label style={styles.label}>对端空闲淘汰(ms)</label>
                  <input style={styles.input} value={udpPeerIdleMs} onChange={(e) => setUdpPeerIdleMs(e.target.value)} />
                </div>
              )}
            </div>
            <label style={styles.check}>
              <input type="checkbox" checked={udpBroadcast} onChange={(e) => setUdpBroadcast(e.target.checked)} />
              允许发送广播（255.255.255.255 / 网段广播地址）
            </label>
            <label style={styles.check}>
              <input type="checkbox" checked={udpReuseAddr} onChange={(e) => setUdpReuseAddr(e.target.checked)} />
              端口复用（同机多进程监听同一端口，抓组播常用）
            </label>
            {isUdpClient && (
              <label style={styles.check}>
                <input type="checkbox" checked={heartbeatEnabled} onChange={(e) => setHeartbeatEnabled(e.target.checked)} />
                定时心跳包
              </label>
            )}
            {isUdpClient && heartbeatEnabled && (
              <div style={styles.row}>
                <div style={styles.col}>
                  <label style={styles.label}>心跳内容</label>
                  <input style={styles.input} value={heartbeatContent} onChange={(e) => setHeartbeatContent(e.target.value)} />
                </div>
                <div style={{ ...styles.col, maxWidth: 130 }}>
                  <label style={styles.label}>间隔(ms)</label>
                  <input style={styles.input} value={heartbeatIntervalMs} onChange={(e) => setHeartbeatIntervalMs(e.target.value)} />
                </div>
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              UDP 无连接：启动只代表套接字就绪，不代表对端在线。数据报自带边界，因此没有分帧与结束符设置。
              {isUdpServer ? '服务端的对端列表按来源地址派生，空闲超时后自动移除，发送时可广播给全部对端或指定其中一个。' : '客户端固定发往默认目标；收到的回包会显示来源地址。'}
            </div>
          </>
        )}

        {isHttpMock && (
          <>
            <div style={styles.row}>
              <div style={styles.col}>
                <label style={styles.label}>监听端口</label>
                <input style={styles.input} value={httpPort} onChange={(e) => setHttpPort(e.target.value)} />
              </div>
            </div>
            <label style={styles.check}>
              <input type="checkbox" checked={httpHttps} onChange={(e) => setHttpHttps(e.target.checked)} />
              启用 HTTPS（自动生成自签证书，可在「证书」面板更换）
            </label>
            <label style={styles.check}>
              <input type="checkbox" checked={httpCors} onChange={(e) => setHttpCors(e.target.checked)} />
              自动处理 CORS（允许跨域）
            </label>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              默认监听 0.0.0.0（本机与局域网都可访问），端口和监听地址可在会话内「监听设置」随时修改。创建后可在「路由配置」编辑接口规则，内置健康检查与按 id 查询示例；HTTPS 证书在「证书」面板管理。
            </div>
          </>
        )}

        <label style={{ ...styles.check, marginTop: 12 }}>
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
          下次打开应用时自动连接
        </label>

        {formError && <div style={styles.formError}>{formError}</div>}
        <div style={styles.actions}>
          <button style={styles.cancel} onClick={onClose}>取消</button>
          <button style={styles.confirm} onClick={submit}>{`创建 (${keyHint('Ctrl+Enter')})`}</button>
        </div>
      </div>
    </div>
  )
}

function defaultName(kind: ConnectionKind, c: SessionConfig): string {
  if (kind === 'tcp-client' || kind === 'tcp-server') return `${KIND_META[kind].label} ${c.host}:${c.port}`
  if (kind === 'ws-client') return `WS ${c.url}`
  if (kind === 'ws-server') return `WS 服务端 :${c.port}`
  if (kind === 'udp-client') return `UDP 客户端 ${c.host}:${c.port}`
  if (kind === 'udp-server') return `UDP 服务端 :${c.udpBindPort ?? c.port}`
  if (kind === 'http-mock') return `HTTP Mock :${c.port}`
  if (kind === 'mqtt-client') return `MQTT ${c.mqtt?.url ?? c.url ?? ''}`
  if (kind === 'modbus-tcp') return `Modbus ${c.modbus?.host}:${c.modbus?.port} #${c.modbus?.unitId}`
  if (kind === 'modbus-rtu') return `Modbus RTU ${c.serialPath} #${c.modbus?.unitId}`
  if (kind === 'modbus-slave')
    return c.modbusSlave?.transport === 'rtu'
      ? `Modbus 从站 ${c.serialPath} #${c.modbusSlave?.unitId}`
      : `Modbus 从站 :${c.modbusSlave?.port} #${c.modbusSlave?.unitId}`
  return `串口 ${c.serialPath}`
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 50 },
  dialog: {
    width: 600,
    maxHeight: '90vh',
    overflowY: 'auto',
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)',
    boxShadow: 'var(--shadow-lg)',
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  },
  title: { fontSize: 'var(--fs-lg)', fontWeight: 600, marginBottom: 6 },
  label: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', marginTop: 8, marginBottom: 2 },
  kinds: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 },
  kindBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 10px',
    background: 'var(--bg-2)',
    color: 'var(--text-1)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-md)',
    fontSize: 'var(--fs-sm)',
    textAlign: 'left'
  },
  /**
   * 选中态。原来只把底色换成 --selected-bg（深色下仅 7% 白叠加），
   * 与未选中的 --bg-2 几乎分不出来。这里改用强选中档 + 明确描边 +
   * 文字提亮到 text-0，三个通道一起表达，扫一眼就知道选了哪个。
   */
  kindActive: {
    background: 'var(--selected-strong-bg)',
    border: '1px solid var(--selected-strong-border)',
    color: 'var(--text-0)',
    fontWeight: 500
  },
  kindIcon: {
    width: 20,
    height: 20,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    background: 'var(--bg-0)',
    borderRadius: 'var(--r-sm)',
    color: 'var(--text-1)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-xs)'
  },
  kindIconOn: { background: 'var(--btn-bg)', color: 'var(--btn-fg)' },
  input: {
    height: 'var(--control-h)',
    padding: '0 var(--control-px)',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-md)',
    minWidth: 0,
    outline: 'none'
  },
  select: { width: '100%' },
  /** Header / 脚本这类多行输入：给足初始高度并可拉伸，别让用户对着一条缝写 */
  textarea: {
    minHeight: 88,
    padding: '9px var(--control-px)',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    lineHeight: 'var(--lh-normal)',
    fontFamily: 'var(--font-mono)',
    resize: 'vertical',
    outline: 'none'
  },
  refresh: {
    padding: '0 12px',
    background: 'var(--btn2-bg)',
    color: 'var(--accent)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-md)',
    fontSize: 'var(--fs-lg)'
  },
  row: { display: 'flex', gap: 10 },
  col: { display: 'flex', flexDirection: 'column', flex: 1, gap: 2 },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--text-1)', marginTop: 8 },
  advToggle: {
    marginTop: 10,
    padding: '6px 0',
    background: 'transparent',
    color: 'var(--accent)',
    border: 'none',
    textAlign: 'left',
    fontSize: 'var(--fs-sm)'
  },
  adv: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 12,
    background: 'var(--bg-0)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-md)'
  },
  advHint: { fontSize: 'var(--fs-xs)', lineHeight: 1.6, color: 'var(--text-2)', marginTop: 2 },
  formError: {
    marginTop: 12,
    padding: '6px 9px',
    fontSize: 'var(--fs-sm)',
    color: 'var(--error)',
    border: '1px solid var(--error)',
    borderRadius: 'var(--r-sm)',
    background: 'transparent'
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  cancel: {
    height: 'var(--control-h)',
    padding: '0 16px',
    background: 'var(--btn2-bg)',
    color: 'var(--btn2-fg)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    fontWeight: 500
  },
  confirm: {
    height: 'var(--control-h)',
    padding: '0 18px',
    background: 'var(--btn-bg)',
    color: 'var(--btn-fg)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    fontWeight: 500
  }
}
