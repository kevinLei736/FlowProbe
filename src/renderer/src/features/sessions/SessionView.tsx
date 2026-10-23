import { useMemo, useRef, useState, useEffect } from 'react'
import type { Encoding, RecordingFile, Session } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { KIND_CAPS, KIND_META, STATUS_META, keyHint } from '../../app/meta'
import { Inspector } from './Inspector'
import { MockPanel } from './MockPanel'
import { MqttPanel } from '../mqtt/MqttPanel'
import { ModbusPanel } from '../modbus/ModbusPanel'
import { SlavePanel } from '../modbus/SlavePanel'
import { Select } from '../../components/ui/Select'
import { useSnippets } from '../../store/useSnippets'
import { EDITOR_H_DEFAULT, useLayout } from '../../store/useLayout'
import { VirtualList } from '../../components/VirtualList'
import { ResizeBar } from '../../components/ui/ResizeBar'
import { decodeFrame, formatTs, framesToCsv, framesToText } from './frameExport'
import { useProtoTemplates, templateFitsKind } from '../../store/useProtoTemplates'
import { ProtoFieldTable, resolveParsed } from './ProtoFieldTable'
import { ProtoTemplatePanel } from './ProtoTemplatePanel'
import { SeriesChart } from './SeriesChart'
import { extractSeries, seriesToCsv } from './seriesExtract'
import { ReplayBar } from './ReplayBar'
import { DiffView } from './DiffView'
import { useDiff } from '../../store/useDiff'
import { useTimeSync } from '../../store/useTimeSync'
import { framesToRecording, parseRecording, recordingToJson } from './recording'
import { AlertCenterPanel } from '../alerts/AlertCenterPanel'
import { useAlerts } from '../alerts/useAlerts'
import { MarksPanel } from './MarksPanel'
import { useMarks } from '../../store/useMarks'

export function SessionView({
  session,
  /**
   * 分屏时的角色。'single' = 独占中栏（原行为）；
   * 'left'/'right' = 分屏的一侧。
   *
   * 为什么要传进来而不是让组件自己读 useLayout：同一个组件在分屏时被实例化两次，
   * 自己读状态没法区分「我是哪一侧」。
   */
  pane = 'single'
}: {
  session: Session
  pane?: 'single' | 'left' | 'right'
}): JSX.Element {
  const frames = useStore((s) => s.framesBySession[session.id] ?? [])
  const peers = useStore((s) => s.peersBySession[session.id] ?? [])
  const start = useStore((s) => s.start)
  const stop = useStore((s) => s.stop)
  const remove = useStore((s) => s.remove)
  const send = useStore((s) => s.send)
  const clearFrames = useStore((s) => s.clearFrames)
  const inspectorWanted = useLayout((s) => s.inspectorVisible)
  const toggleInspector = useLayout((s) => s.toggleInspector)
  /**
   * 分屏时两侧都不显示检查器。
   *
   * 检查器固定 280px 宽。半宽的栏里再切掉 280px，报文区连一行 HEX 都排不下，
   * 中文标题会被压成竖排。分屏本来就是「并排看报文」的动作，参数详情回单栏再看。
   */
  const inSplitPane = pane !== 'single'
  const inspectorVisible = inspectorWanted && !inSplitPane
  const picking = useDiff((s) => s.picking)
  const setPicking = useDiff((s) => s.setPicking)
  const picks = useDiff((s) => s.picks)
  const togglePick = useDiff((s) => s.toggle)
  const diffOpen = useDiff((s) => s.open)
  const setDiffOpen = useDiff((s) => s.setOpen)
  // 已挑选的报文 id 做成 Set：报文行是虚拟列表里高频重渲染的组件，
  // 逐行 picks.some(...) 会把 O(n) 变成 O(n²)。
  const pickedIds = useMemo(() => new Set(picks.map((k) => k.frameId)), [picks])
  const syncOn = useTimeSync((s) => s.enabled)
  const syncSource = useTimeSync((s) => s.source)
  const syncTs = useTimeSync((s) => s.ts)
  const syncToken = useTimeSync((s) => s.token)
  const emitSync = useTimeSync((s) => s.emit)

  // Modbus 是纯二进制协议，按 TEXT 显示只会是一串控制字符，
  // 所以收发两侧的默认编码都按会话类型给，而不是一律 UTF-8。
  const binaryFirst = session.kind === 'modbus-tcp' || session.kind === 'modbus-rtu'
  const [encoding, setEncoding] = useState<Encoding>(binaryFirst ? 'hex' : 'utf8')
  const [terminator, setTerminator] = useState<'' | 'cr' | 'lf' | 'crlf'>(
    binaryFirst ? '' : 'crlf'
  )
  const [input, setInput] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [viewFormat, setViewFormat] = useState<Encoding>(binaryFirst ? 'hex' : 'utf8')
  const [filter, setFilter] = useState('')
  const [connOnly, setConnOnly] = useState(false)
  const [target, setTarget] = useState('')
  const [mockOpen, setMockOpen] = useState(false)
  const [mqttOpen, setMqttOpen] = useState(false)
  const [modbusOpen, setModbusOpen] = useState(false)
  const [slaveOpen, setSlaveOpen] = useState(false)
  // MQTT 的「发到哪」是发送动作的一部分，不是会话配置，所以放在发送区而非设置面板
  const [pubTopic, setPubTopic] = useState('')
  const [pubQos, setPubQos] = useState('0')
  const [pubRetain, setPubRetain] = useState(false)
  const mockOn = Boolean((session.config.mock as { enabled?: boolean } | undefined)?.enabled)
  const snippets = useSnippets((s) => s.snippets)
  const addSnippet = useSnippets((s) => s.add)
  const protoTemplates = useProtoTemplates((s) => s.templates)
  const protoSel = useProtoTemplates((s) => s.selBySession[session.id] ?? '')
  const selectProto = useProtoTemplates((s) => s.select)
  const [protoPanelOpen, setProtoPanelOpen] = useState(false)
  const [alertPanelOpen, setAlertPanelOpen] = useState(false)
  const alertRules = useAlerts((s) => s.rules)
  const [marksOpen, setMarksOpen] = useState(false)
  const marks = useMarks((s) => s.marks)
  const toggleMark = useMarks((s) => s.toggle)
  const ensureMark = useMarks((s) => s.ensure)
  /**
   * 本会话已标记的 frameId 集合。
   *
   * 和 pickedIds 同理做成 Set：星标要在虚拟列表的每一行上判断，
   * 逐行 marks.some(...) 在几万条报文下会把渲染压成 O(n²)。
   */
  const markedIds = useMemo(
    () => new Set(marks.filter((m) => m.sessionId === session.id).map((m) => m.frameId)),
    [marks, session.id]
  )
  // 书签面板发出的「跳回这条」请求。只有请求指向本会话时才认领
  const locateReq = useMarks((s) => s.locateReq)
  const [chartOpen, setChartOpen] = useState(false)
  const [recording, setRecording] = useState<RecordingFile | null>(null)
  const [recError, setRecError] = useState('')
  // 展开状态用「例外集合」表示：expandAll 为基准，集合里的行取反。
  // 这样切换「全部展开」不需要遍历上万条数据。
  const [expandAll, setExpandAll] = useState(true)
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const editorH = useLayout((s) => s.editorH)
  const setEditorH = useLayout((s) => s.setEditorH)
  const [loopOn, setLoopOn] = useState(false)
  const [loopMs, setLoopMs] = useState('1000')
  const loopRef = useRef<NodeJS.Timeout | null>(null)

  const meta = KIND_META[session.kind]
  /**
   * 本模块支持哪些功能，全部来自能力矩阵而不是散落的 kind 判断。
   * 这样「结束符只属于流式协议」「Mock 只属于字节流」这些边界只在一处定义。
   */
  const caps = KIND_CAPS[session.kind]
  const status = STATUS_META[session.status]
  // connecting 也算「已占用」：此时再点一次启动会开出第二条链路
  const running =
    session.status === 'connected' ||
    session.status === 'listening' ||
    session.status === 'connecting'
  // 是否有「对端」概念：直接读能力矩阵，避免每加一种服务端都要来这里补 kind 判断
  const isServer = caps.peerTarget
  const isMqtt = session.kind === 'mqtt-client'
  const isModbus = session.kind === 'modbus-tcp' || session.kind === 'modbus-rtu'
  const mqttSubCount = isMqtt
    ? (session.config.mqtt?.subscriptions ?? []).filter((x) => x.enabled).length
    : 0
  const modbusPointCount = isModbus ? (session.config.modbus?.points ?? []).length : 0
  const slaveRegionCount = caps.regionTable ? (session.config.modbusSlave?.regions ?? []).length : 0

  const toggleRow = (id: string): void => {
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const visibleFrames = useMemo(() => {
    let list = frames
    // 只看连接生命周期：排查「什么时候断的」时不用在报文里翻
    if (connOnly) list = list.filter((f) => f.conn === true)
    if (filter) {
      const kw = filter.toLowerCase()
      list = list.filter((f) => (f.text ?? '').toLowerCase().includes(kw))
    }
    return list
  }, [frames, filter, connOnly])

  const connCount = useMemo(() => frames.filter((f) => f.conn === true).length, [frames])

  // 只有分屏的两侧才参与联动；单栏时没有「另一侧」，跟随毫无意义
  const inSplit = pane === 'left' || pane === 'right'
  const following = inSplit && syncOn && syncSource !== null && syncSource !== pane
  /**
   * 跟随侧要滚到的行：第一条时间不早于对侧顶部时间的报文。
   *
   * 两侧报文数量、疏密都不同，按下标对齐会完全错位，只能按时间找位置。
   * 列表本身按时间升序，所以用二分而不是逐条扫——十万条报文里逐条找会卡住滚动。
   */
  const syncTarget = useMemo(() => {
    if (!following || visibleFrames.length === 0) return null
    let lo = 0
    let hi = visibleFrames.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (visibleFrames[mid].ts < syncTs) lo = mid + 1
      else hi = mid
    }
    return { index: lo, token: syncToken }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, syncToken, syncTs, visibleFrames])

  /**
   * 书签跳转的滚动目标。
   *
   * 与分屏联动共用 VirtualList 的 scrollTo，但书签优先：跳转是用户刚发出的明确指令，
   * 而联动是被动跟随，让联动把刚跳过去的位置又拽走会显得程序没听话。
   */
  const locateTarget = useMemo(() => {
    if (!locateReq || locateReq.sessionId !== session.id) return null
    const i = visibleFrames.findIndex((f) => f.id === locateReq.frameId)
    return i < 0 ? null : { index: i, token: locateReq.token }
  }, [locateReq, session.id, visibleFrames])

  /*
    定位失败要明说。

    报文缓冲是内存态，清屏、重启或超出 5 万条上限之后原报文就不在了；
    此时「跳回会话」如果什么都不做，用户只会觉得按钮坏了。所以这里把
    「请求指向本会话但找不到那一行」单独识别出来，给一句能指路的提示
    （报文本身在历史库里，Ctrl+H 能查到）。
  */
  const locateMiss =
    locateReq !== null && locateReq.sessionId === session.id && locateTarget === null
  const [locateMissDismissed, setLocateMissDismissed] = useState(0)
  const showLocateMiss = locateMiss && locateMissDismissed !== locateReq!.token

  /**
   * 只保留适用于当前连接类型的模板。
   *
   * 之前所有模板对所有会话可见，于是串口会话的解析下拉里也躺着「Modbus 读保持寄存器」，
   * 选中后字段名（从站地址、起始地址）与实际报文毫无关系。过滤放在这里而不是 store，
   * 是因为「可用范围」是会话视角的概念，模板本身仍然完整可编辑。
   */
  const kindTemplates = useMemo(
    () => protoTemplates.filter((t) => templateFitsKind(t, session.kind)),
    [protoTemplates, session.kind]
  )

  /**
   * 对本会话生效的启用规则数。
   *
   * 统计放在按钮上而不是只在告警中心里显示：用户配完规则回到会话，
   * 第一个疑问总是「它到底管不管这个连接」——把数字摆在眼前比让人回去核对范围有效。
   */
  const activeAlertCount = useMemo(
    () =>
      alertRules.filter(
        (r) =>
          r.enabled &&
          (r.sessionId
            ? r.sessionId === session.id
            : r.kinds.length === 0 || r.kinds.includes(session.kind))
      ).length,
    [alertRules, session.id, session.kind]
  )

  // 是否有字段被标记绘制曲线：决定工具栏「曲线」按钮是否出现
  const hasChartField = useMemo(
    () => kindTemplates.some((t) => t.fields.some((f) => f.chart === true)),
    [kindTemplates]
  )

  // 只在曲线面板打开时抽取，避免高吞吐下白算一遍
  const series = useMemo(
    () => (chartOpen && protoSel ? extractSeries(frames, kindTemplates, protoSel) : []),
    [chartOpen, protoSel, frames, kindTemplates]
  )

  const exportSeries = async (): Promise<void> => {
    if (series.length === 0) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await window.toolbox.saveTextFile(session.name + '-曲线-' + stamp + '.csv', seriesToCsv(series))
  }

  const sendContent = (content: string, enc: Encoding = encoding, term = terminator): void => {
    if (!content) return
    send({
      sessionId: session.id,
      encoding: enc,
      content,
      appendTerminator: term,
      target: isServer && target ? target : undefined,
      ...(isMqtt
        ? {
            mqtt: {
              topic: pubTopic,
              qos: Number(pubQos) as 0 | 1 | 2,
              retain: pubRetain
            }
          }
        : {})
    })
  }

  const doSend = (): void => {
    if (!input) return
    sendContent(input)
  }

  useEffect(() => {
    if (loopOn) {
      const ms = Math.max(50, Number(loopMs) || 1000)
      loopRef.current = setInterval(() => {
        if (input) sendContent(input)
      }, ms)
    }
    return () => {
      if (loopRef.current) clearInterval(loopRef.current)
      loopRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopOn, loopMs, input, encoding, terminator, target, pubTopic, pubQos, pubRetain])

  /** 导出当前过滤后的报文。CSV 便于用表格分析，TXT 保留时间轴阅读顺序。 */
  const exportFrames = async (format: 'csv' | 'txt'): Promise<void> => {
    if (visibleFrames.length === 0) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const content =
      format === 'csv' ? framesToCsv(visibleFrames) : framesToText(visibleFrames, viewFormat)
    await window.toolbox.saveTextFile(session.name + '-报文-' + stamp + '.' + format, content)
  }

  /** 把当前过滤后的报文存成录制文件，便于以后原时序重放 */
  const saveRecording = async (): Promise<void> => {
    if (visibleFrames.length === 0) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const rec = framesToRecording(visibleFrames, session.name, session.kind)
    await window.toolbox.saveTextFile(session.name + '-录制-' + stamp + '.json', recordingToJson(rec))
  }

  /** 载入录制文件，成功后展开回放控制条 */
  const loadRecording = async (): Promise<void> => {
    setRecError('')
    const picked = await window.toolbox.openTextFile('打开录制文件', ['json'])
    if (!picked) return
    const parsed = parseRecording(picked.content)
    if (typeof parsed === 'string') {
      setRecError(parsed)
      return
    }
    setRecording(parsed)
  }

  /**
   * 加/取消书签。
   *
   * 快照在这里就地生成而不是等打开面板再算：报文缓冲会被清屏和上限淘汰，
   * 标记那一刻不把内容留下来，之后就只剩一个查不到的 id。
   */
  const markInput = (f: { id: string; ts: number; direction: string; size: number }): Parameters<typeof toggleMark>[0] => ({
    sessionId: session.id,
    sessionName: session.name,
    sessionKind: session.kind,
    frameId: f.id,
    ts: f.ts,
    direction: f.direction as 'tx' | 'rx' | 'system',
    size: f.size ?? 0,
    snapshotHex: decodeFrame(f as never, 'hex'),
    snapshotText: decodeFrame(f as never, 'utf8')
  })

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      doSend()
    }
  }

  return (
    <div style={{ ...styles.wrap, gridTemplateColumns: inspectorVisible ? '1fr 280px' : '1fr' }}>
      <div style={styles.center}>
        <header style={styles.topbar}>
          <span style={{ ...styles.dot, background: status.color }} />
          <span style={styles.title} title={session.name}>{session.name}</span>
          {/* 分屏后横向空间只有一半，类型徽标与状态文字是可推断信息（左栏与标签上都有），
              优先让位给报文计数与启停按钮，否则头部会被挤成竖排文字 */}
          {!inSplitPane && <span style={styles.badge}>{meta.label}</span>}
          {!inSplitPane && <span style={styles.status}>{status.label}</span>}
          <span style={styles.spacer} />
          {!inSplitPane && <span style={styles.metric}>↑ {session.metrics.txBytes} B</span>}
          {!inSplitPane && <span style={styles.metric}>↓ {session.metrics.rxBytes} B</span>}
          <span style={styles.metric}>
            {filter ? visibleFrames.length + '/' + frames.length : frames.length} 条
          </span>
          {!inSplitPane && (
            <button style={styles.ghost} title="显示/隐藏检查器" onClick={toggleInspector}>{inspectorVisible ? '隐藏检查器' : '检查器'}</button>
          )}
          {running ? (
            <button style={styles.stopBtn} onClick={() => stop(session.id)}>停止</button>
          ) : (
            <button style={styles.startBtn} onClick={() => start(session.id)}>启动</button>
          )}
        </header>

        <div style={styles.toolbar}>
          <span style={styles.toolLabel}>显示</span>
          <Seg value={viewFormat} onChange={setViewFormat} options={[['utf8', 'TEXT'], ['hex', 'HEX'], ['base64', 'B64']]} />
          <label style={styles.check}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
          {inSplit && (
            <label style={styles.check} title="一侧滚动时另一侧自动对齐到同一时刻">
              <input
                type="checkbox"
                checked={syncOn}
                onChange={(e) => useTimeSync.getState().setEnabled(e.target.checked)}
              />
              时间轴联动
            </label>
          )}
          <input style={styles.filter} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤关键字..." />
          {!inSplitPane && (
            <label style={styles.check} title="只显示连接、断开、重连等连接生命周期日志">
              <input type="checkbox" checked={connOnly} onChange={(e) => setConnOnly(e.target.checked)} />
              仅连接日志{connCount > 0 ? ' (' + connCount + ')' : ''}
            </label>
          )}
          <span style={styles.spacer} />
          {!inSplitPane && caps.protoTemplate && <span style={styles.toolLabel}>解析</span>}
          {!inSplitPane && caps.protoTemplate && (
          <Select
            size="sm"
            style={{ minWidth: 132 }}
            value={protoSel}
            title="按协议模板把报文渲染成字段表"
            onChange={(v) => selectProto(session.id, v)}
            options={[
              { value: '', label: '关闭' },
              { value: 'auto', label: '自动匹配' },
              ...kindTemplates.map((t) => ({ value: t.id, label: t.name, group: '模板' }))
            ]}
          />
          )}
          {!inSplitPane && caps.protoTemplate && protoSel && (
            <label style={styles.check} title="取消后只展开你点开的报文">
              <input type="checkbox" checked={expandAll} onChange={(e) => { setExpandAll(e.target.checked); setToggled(new Set()) }} />
              全部展开
            </label>
          )}
          {!inSplitPane && caps.protoTemplate && protoSel && hasChartField && (
            <button
              style={{ ...styles.ghost, ...(chartOpen ? { background: 'var(--selected-bg)', color: 'var(--text-0)' } : {}) }}
              title="把标记了曲线的数值字段随时间画出来"
              onClick={() => setChartOpen((v) => !v)}
            >
              曲线{chartOpen ? ' ●' : ''}
            </button>
          )}
          {!inSplitPane && caps.protoTemplate && (
            <button
              style={styles.ghost}
              // 说清「只管本模块」：用户之前会疑惑为什么这里看不到别的模板
              title={'编辑 ' + meta.label + ' 可用的协议解析模板'}
              onClick={() => setProtoPanelOpen(true)}
            >
              模板
            </button>
          )}
          {!inSplitPane && caps.alertRule && (
            <button
              style={{ ...styles.ghost, ...(activeAlertCount > 0 ? { background: 'var(--selected-bg)', color: 'var(--text-0)' } : {}) }}
              title={
                activeAlertCount > 0
                  ? '本会话有 ' + activeAlertCount + ' 条告警规则生效，点击管理'
                  : '给解析字段或报文文本设阈值，命中即高亮并通知'
              }
              onClick={() => setAlertPanelOpen(true)}
            >
              告警{activeAlertCount > 0 ? ' (' + activeAlertCount + ')' : ''}
            </button>
          )}
          <button
            style={{ ...styles.ghost, ...(picking || diffOpen ? { background: 'var(--selected-bg)', color: 'var(--text-0)' } : {}) }}
            title="挑选两条报文做字节级对比（可跨会话）"
            onClick={() => {
              // 已经攒够两条时再点就是「看结果」，否则是「进入/退出挑选」。
              // 这样一个按钮覆盖了挑→比的完整动作，不用再加第二个按钮。
              if (picks.length === 2 && !diffOpen) setDiffOpen(true)
              else setPicking(!picking)
            }}
          >
            对比{picks.length > 0 ? ' ' + picks.length + '/2' : picking ? ' ●' : ''}
          </button>
          <button
            style={{ ...styles.ghost, ...(markedIds.size > 0 ? { background: 'var(--selected-bg)', color: 'var(--text-0)' } : {}) }}
            title="报文书签与标注：把可疑报文连同一句说明留下来，清屏与重启都不丢"
            onClick={() => setMarksOpen(true)}
          >
            标注{markedIds.size > 0 ? ' (' + markedIds.size + ')' : ''}
          </button>
          <span style={styles.spacer} />
          {/* 以下都是「配置与导出」类低频操作。分屏时收起：
              半宽栏放不下十来个按钮，硬排会把工具栏堆成三四行，报文区所剩无几。
              退出分屏即恢复，不是功能删减。 */}
          {!inSplitPane && caps.subscription && (
            <button style={styles.ghost} title="订阅列表、遗嘱消息与连接参数" onClick={() => setMqttOpen(true)}>
              MQTT 设置{mqttSubCount > 0 ? ' (' + mqttSubCount + ')' : ''}
            </button>
          )}
          {!inSplitPane && caps.pointTable && (
            <button style={styles.ghost} title="点表、实时值与链路参数" onClick={() => setModbusOpen(true)}>
              点表{modbusPointCount > 0 ? ' (' + modbusPointCount + ')' : ''}
            </button>
          )}
          {!inSplitPane && caps.regionTable && (
            <button
              style={styles.ghost}
              title="数据区定义、实时值置数与故障注入"
              onClick={() => setSlaveOpen(true)}
            >
              数据区{slaveRegionCount > 0 ? ' (' + slaveRegionCount + ')' : ''}
            </button>
          )}
          {!inSplitPane && caps.frameMock && (
            <button
              style={{ ...styles.ghost, ...(mockOn ? { background: 'var(--selected-bg)', color: 'var(--text-0)' } : {}) }}
              title="按收到的报文内容匹配规则并自动回包（报文级模拟，不是 HTTP Mock）"
              onClick={() => setMockOpen(true)}
            >
              规则应答{mockOn ? ' ●' : ''}
            </button>
          )}
          {!inSplitPane && caps.recording && (
            <>
              <button style={styles.ghost} title="把当前报文存成录制文件，之后可按原时序重放" onClick={() => void saveRecording()}>录制</button>
              <button style={{ ...styles.ghost, ...(recording ? { background: 'var(--selected-bg)', color: 'var(--text-0)' } : {}) }} title="打开录制文件并回放" onClick={() => void loadRecording()}>回放</button>
            </>
          )}
          {/* 导出与录制解耦：任何模块的报文都值得导出，但不是每个模块都支持按原时序重放 */}
          {!inSplitPane && (
            <>
              <button style={styles.ghost} title="导出为 CSV（可用表格分析）" onClick={() => void exportFrames('csv')}>导出 CSV</button>
              <button style={styles.ghost} title="导出为纯文本（保留时间轴顺序）" onClick={() => void exportFrames('txt')}>导出 TXT</button>
            </>
          )}
          <button style={styles.ghost} onClick={() => clearFrames(session.id)}>清屏</button>
          {!inSplitPane && <button style={styles.ghost} onClick={() => remove(session.id)}>删除会话</button>}
        </div>

        {visibleFrames.length === 0 ? (
          <div style={{ ...styles.timeline, ...styles.empty }}>暂无数据</div>
        ) : (
          <VirtualList
            items={visibleFrames}
            keyOf={(f) => f.id}
            estimate={22}
            stickToBottom={autoScroll && !following}
            style={styles.timeline}
            padTop={8}
            padBottom={8}
            scrollTo={locateTarget ?? syncTarget}
            onTopIndex={
              // 只有「不在跟随」的一侧才广播，否则两侧会互相推着滚个不停
              inSplit && syncOn && !following
                ? (i) => {
                    const f = visibleFrames[i]
                    if (f) emitSync(pane as 'left' | 'right', f.ts)
                  }
                : undefined
            }
          >
            {(f) => (
              <FrameRow
                frame={f}
                viewFormat={viewFormat}
                parsed={protoSel ? resolveParsed(f, kindTemplates, protoSel) : null}
                expanded={expandAll !== toggled.has(f.id)}
                onToggle={() => toggleRow(f.id)}
                onTopicClick={(topic) => setFilter(topic)}
                picking={picking}
                picked={pickedIds.has(f.id)}
                marked={markedIds.has(f.id)}
                onMark={() => toggleMark(markInput(f))}
                onNote={() => {
                  ensureMark(markInput(f))
                  setMarksOpen(true)
                }}
                onPick={() =>
                  togglePick({
                    sessionId: session.id,
                    sessionName: session.name,
                    frameId: f.id,
                    ts: f.ts,
                    direction: f.direction,
                    size: f.size,
                    rawBase64: f.rawBase64
                  })
                }
              />
            )}
          </VirtualList>
        )}

        {showLocateMiss && (
          <div style={styles.recError}>
            这条报文已不在当前缓冲里（清屏、重启或超出条数上限都会让它消失）。标注内容仍完整保留；原始报文可用 Ctrl+H 在历史库中检索。
            <button
              style={styles.recErrClose}
              onClick={() => setLocateMissDismissed(locateReq!.token)}
            >
              ✕
            </button>
          </div>
        )}

        {recError && (
          <div style={styles.recError}>
            载入录制失败：{recError}
            <button style={styles.recErrClose} onClick={() => setRecError('')}>✕</button>
          </div>
        )}

        {recording && (
          <ReplayBar recording={recording} sessionId={session.id} onClose={() => setRecording(null)} />
        )}

        {chartOpen && protoSel && (
          <SeriesChart series={series} onClose={() => setChartOpen(false)} onExport={() => void exportSeries()} />
        )}

        {/* 对比面板只在焦点侧（或未分屏时）渲染一份：两条报文可能来自不同会话，
            两侧各画一份是重复信息，还会把报文区压到看不清。 */}
        {diffOpen && pane !== 'right' && <DiffView onClose={() => setDiffOpen(false)} />}

        {/* 高度由用户拖出来并记住：原来 textarea 是 flex 可收缩项，
            原生 resize 手柄写的高度会在下一次布局被压回去，看着能拉其实拉不动 */}
        <ResizeBar height={editorH} onChange={setEditorH} onReset={() => setEditorH(EDITOR_H_DEFAULT)} />
        <div style={{ ...styles.editor, height: editorH }}>
          <div style={styles.editorTools}>
            {/* 明确标出当前模块：同一套发送区在不同协议下可用项不同，先告诉用户「你在哪个模块」 */}
            <span style={styles.moduleTag} title={meta.label + ' 发送区'}>{meta.label}</span>
            {caps.encodingSwitch ? (
              <Seg value={encoding} onChange={setEncoding} options={[['utf8', 'TEXT'], ['hex', 'HEX'], ['base64', 'B64']]} />
            ) : (
              <span style={styles.fixedTag} title="该协议为纯二进制帧，按文本发送只会得到乱码，因此编码固定为 HEX">HEX 固定</span>
            )}
            {caps.terminator && (
            <Select
              size="sm"
              style={{ width: 118 }}
              value={terminator}
              onChange={(v) => setTerminator(v as '' | 'cr' | 'lf' | 'crlf')}
              title="以换行分帧的流式协议才需要结束符"
              options={[
                { value: '', label: '无结束符' },
                { value: 'cr', label: '追加 CR' },
                { value: 'lf', label: '追加 LF' },
                { value: 'crlf', label: '追加 CRLF' }
              ]}
            />
            )}
            {caps.topicPublish && (
              <>
                <input
                  style={{ ...styles.select, width: 200, fontFamily: 'var(--font-mono)' }}
                  value={pubTopic}
                  placeholder="发布主题 device/1/cmd"
                  title="发布主题。不填则无法发布"
                  onChange={(e) => setPubTopic(e.target.value)}
                />
                <Select
                  size="sm"
                  style={{ width: 92 }}
                  value={pubQos}
                  onChange={setPubQos}
                  title="发布 QoS"
                  options={[
                    { value: '0', label: 'QoS 0' },
                    { value: '1', label: 'QoS 1' },
                    { value: '2', label: 'QoS 2' }
                  ]}
                />
                <label style={styles.check} title="Broker 保留该主题的最后一条消息，新订阅者立即收到">
                  <input type="checkbox" checked={pubRetain} onChange={(e) => setPubRetain(e.target.checked)} />
                  Retain
                </label>
              </>
            )}
            {caps.peerTarget && (
              <Select
                size="sm"
                style={{ minWidth: 132 }}
                value={target}
                onChange={setTarget}
                title="选择发送目标"
                options={[
                  { value: '', label: '广播全部' },
                  ...peers.map((p) => ({ value: p.id, label: p.label, group: '已连接对端' }))
                ]}
              />
            )}
            {caps.loopSend && (
              <>
                <label style={styles.check}>
                  <input type="checkbox" checked={loopOn} onChange={(e) => setLoopOn(e.target.checked)} />
                  循环
                </label>
                <input style={{ ...styles.select, width: 64 }} value={loopMs} onChange={(e) => setLoopMs(e.target.value)} title="循环间隔(ms)" />
              </>
            )}
            <span style={styles.spacer} />
            <button style={styles.ghost} onClick={() => { if (input) addSnippet({ name: input.slice(0, 12) || '片段', encoding, content: input, appendTerminator: terminator }) }}>存为片段</button>
            <button style={styles.sendBtn} onClick={doSend}>{`发送 (${keyHint('Ctrl+Enter')})`}</button>
          </div>
          {snippets.length > 0 && (
            <div style={styles.snippets}>
              <span style={styles.snipLabel}>片段</span>
              {snippets.map((s) => (
                <button key={s.id} style={styles.snip} title={s.content} onClick={() => sendContent(s.content, s.encoding, s.appendTerminator)}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <textarea
            // 关掉对角线提示：这里的拉伸由上方分隔条负责，留着提示会让人去拽右下角
            data-no-resize-hint
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={encoding === 'hex' ? '输入 HEX，例如 AA 01 02' : '输入要发送的内容...'}
          />
        </div>
      </div>

      {inspectorVisible && <Inspector session={session} />}
      {mockOpen && <MockPanel session={session} onClose={() => setMockOpen(false)} />}
      {mqttOpen && <MqttPanel session={session} onClose={() => setMqttOpen(false)} />}
      {modbusOpen && <ModbusPanel session={session} onClose={() => setModbusOpen(false)} />}
      {slaveOpen && <SlavePanel session={session} onClose={() => setSlaveOpen(false)} />}
      {protoPanelOpen && <ProtoTemplatePanel kind={session.kind} onClose={() => setProtoPanelOpen(false)} />}
      {marksOpen && (
        <MarksPanel
          onClose={() => setMarksOpen(false)}
          onLocate={(sid, fid) => {
            useMarks.getState().requestLocate(sid, fid)
            // 跳转前先关面板：不关的话滚过去的那一行正好被面板挡着
            setMarksOpen(false)
          }}
        />
      )}
      {alertPanelOpen && (
        <AlertCenterPanel
          initialTab="rules"
          presetSessionId={session.id}
          onClose={() => setAlertPanelOpen(false)}
        />
      )}
    </div>
  )
}

function FrameRow({
  frame,
  viewFormat,
  parsed,
  expanded,
  onToggle,
  onTopicClick,
  picking,
  picked,
  onPick,
  marked,
  onMark,
  onNote
}: {
  frame: any
  viewFormat: Encoding
  parsed?: ReturnType<typeof resolveParsed>
  expanded?: boolean
  onToggle?: () => void
  onTopicClick?: (topic: string) => void
  picking?: boolean
  picked?: boolean
  onPick?: () => void
  marked?: boolean
  onMark?: () => void
  /** 点星标旁的「注」：确保已标记并打开面板直接写字 */
  onNote?: () => void
}): JSX.Element {
  const ts = useMemo(() => formatTs(frame.ts), [frame.ts])
  if (frame.direction === 'system') {
    const level = (frame.level ?? 'info') as string
    const color =
      level === 'success'
        ? 'var(--conn-ok)'
        : level === 'warn'
          ? 'var(--conn-warn)'
          : level === 'error'
            ? 'var(--conn-error)'
            : 'var(--text-2)'
    return (
      <div className="frame-line" style={rowStyles.system}>
        {/* 系统日志没有原始字节，不能参与字节对比；
            但仍占一个位，否则挑选模式下时间列会左右跳动。 */}
        {picking && <span style={rowStyles.pickHole} />}
        {/* 星标同理占位。系统日志本身也值得标（「就是这里断的」），所以不是空洞而是真按钮 */}
        {onMark && (
          <span
            className="frame-mark"
            data-on={marked ? '1' : '0'}
            style={{ ...rowStyles.star, ...(marked ? rowStyles.starOn : {}) }}
            title={marked ? '取消书签' : '加书签'}
            onClick={onMark}
            onContextMenu={(e) => {
              e.preventDefault()
              onNote?.()
            }}
          >
            {marked ? '★' : '☆'}
          </span>
        )}
        <span style={rowStyles.ts}>{ts}</span>
        {frame.replay && <span style={rowStyles.replayTag}>回放</span>}
        {frame.conn && <span style={{ ...rowStyles.connTag, color, borderColor: color }}>连接</span>}
        <span style={{ ...rowStyles.sysText, color }}>· {frame.text}</span>
      </div>
    )
  }
  const isTx = frame.direction === 'tx'
  const ckBad = parsed?.checksum && !parsed.checksum.ok
  /*
    告警高亮做成整行左侧色条 + 淡染底，而不是把整行文字染红：
    报文内容本身是要逐字读的，染色会压掉 HEX/文本的可读性；
    色条在快速下滑时也更容易扫到。
  */
  const alert = frame.alert as { ruleName: string; severity: string; detail: string } | undefined
  const alertStyle = alert
    ? alert.severity === 'error'
      ? rowStyles.alertError
      : rowStyles.alertWarn
    : undefined
  return (
    <div className="frame-line" style={{ ...(picked ? rowStyles.pickedWrap : {}), ...(alertStyle ?? {}) }}>
      <div style={rowStyles.row}>
        {picking && (
          <span
            style={{ ...rowStyles.pick, ...(picked ? rowStyles.pickOn : {}) }}
            title={picked ? '取消选择' : '选作对比的一条（最多两条）'}
            onClick={onPick}
          >
            {picked ? '✓' : ''}
          </span>
        )}
        {onMark && (
          <span
            className="frame-mark"
            data-on={marked ? '1' : '0'}
            style={{ ...rowStyles.star, ...(marked ? rowStyles.starOn : {}) }}
            title={marked ? '取消书签（右键或点「注」写标注）' : '加书签：把这条留下来，清屏与重启都不丢'}
            onClick={onMark}
            onContextMenu={(e) => {
              // 右键直接进标注：加书签之后紧接着要写「为什么」，两步合成一个动作
              e.preventDefault()
              onNote?.()
            }}
          >
            {marked ? '★' : '☆'}
          </span>
        )}
        <span style={rowStyles.ts}>{ts}</span>
        {frame.replay && <span style={rowStyles.replayTag}>回放</span>}
        <span style={{ ...rowStyles.arrow, color: isTx ? 'var(--tx)' : 'var(--rx)' }}>{isTx ? '▶ TX' : '◀ RX'}</span>
        <span style={rowStyles.size}>{frame.size}B</span>
        {frame.peerLabel && <span style={rowStyles.peer}>{frame.peerLabel}</span>}
        <MetaTags meta={frame.meta} onTopicClick={onTopicClick} />
        <span style={rowStyles.content}>{decodeFrame(frame, viewFormat)}</span>
        {alert && (
          <span
            style={{
              ...rowStyles.alertTag,
              color: alert.severity === 'error' ? 'var(--error)' : 'var(--warn)',
              borderColor: alert.severity === 'error' ? 'var(--error)' : 'var(--warn)'
            }}
            title={alert.ruleName + '：' + alert.detail}
          >
            ⚠ {alert.detail}
          </span>
        )}
        {parsed && (
          <button
            style={{ ...rowStyles.parseBtn, ...(ckBad ? { color: 'var(--conn-error)', borderColor: 'var(--conn-error)' } : {}) }}
            title={expanded ? '收起字段表' : '展开字段表：' + parsed.templateName}
            onClick={onToggle}
          >
            {expanded ? '▾' : '▸'} {parsed.templateName}{ckBad ? ' ⚠' : ''}
          </button>
        )}
      </div>
      {parsed && expanded && <ProtoFieldTable parsed={parsed} />}
    </div>
  )
}

/**
 * 协议附加信息徽标。
 *
 * MQTT 与 Modbus 的关键上下文（主题、QoS、功能码、异常）不属于报文字节，
 * 但排查时几乎每条都要看。放进 meta 后统一在这里渲染，
 * 新协议只要往 meta 填字段就能显示，不用再改时间轴。
 */
function MetaTags({
  meta,
  onTopicClick
}: {
  meta?: Record<string, unknown>
  onTopicClick?: (topic: string) => void
}): JSX.Element | null {
  if (!meta) return null
  const topic = typeof meta.topic === 'string' ? meta.topic : ''
  const qos = typeof meta.qos === 'number' ? meta.qos : null
  const func = typeof meta.funcCode === 'number' ? meta.funcCode : null
  const addr = typeof meta.addr === 'number' ? meta.addr : null
  const exc = typeof meta.exceptionCode === 'number' ? meta.exceptionCode : null
  const note = typeof meta.note === 'string' ? meta.note : ''
  return (
    <>
      {topic && (
        <span
          style={rowStyles.topic}
          title={'主题 ' + topic + '（点击按此主题过滤）'}
          onClick={() => onTopicClick?.(topic)}
        >
          {topic}
        </span>
      )}
      {qos !== null && <span style={rowStyles.metaTag}>Q{qos}</span>}
      {meta.retain === true && <span style={rowStyles.metaTag}>R</span>}
      {func !== null && (
        <span style={rowStyles.metaTag} title="Modbus 功能码">
          FC{String(func).padStart(2, '0')}
        </span>
      )}
      {addr !== null && (
        <span style={rowStyles.metaTag} title="起始地址">
          @{addr}
        </span>
      )}
      {exc !== null && (
        <span style={{ ...rowStyles.metaTag, color: 'var(--conn-error)' }} title="Modbus 异常响应">
          E{exc}
        </span>
      )}
      {note && <span style={rowStyles.note}>{note}</span>}
    </>
  )
}

function Seg<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: [T, string][]
}): JSX.Element {
  return (
    <div style={styles.seg}>
      {options.map(([v, label]) => (
        <button
          key={v}
          style={{ ...styles.segBtn, ...(v === value ? styles.segActive : {}) }}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    flex: 1,
    display: 'grid',
    gridTemplateRows: 'minmax(0, 1fr)',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden'
  },
  center: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    borderRight: '1px solid var(--border)'
  },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-1)'
  },
  dot: { width: 9, height: 9, borderRadius: 9, flexShrink: 0 },
  // minWidth:0 + 省略号：分屏后头部宽度只有一半，长会话名不截断会把
  // 整行 flex 项挤到最小宽度，中文就被折成竖排
  title: { minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontWeight: 600 },
  badge: {
    flexShrink: 0,
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-1)',
    background: 'var(--btn2-bg)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    padding: '2px 6px'
  },
  status: { flexShrink: 0, whiteSpace: 'nowrap', fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  spacer: { flex: 1 },
  metric: { flexShrink: 0, whiteSpace: 'nowrap', fontSize: 'var(--fs-sm)', color: 'var(--text-1)', fontFamily: 'var(--font-mono)' },
  startBtn: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    padding: '6px 14px',
    background: 'var(--btn-bg)',
    color: 'var(--btn-fg)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-md)'
  },
  stopBtn: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    padding: '6px 14px',
    background: 'transparent',
    color: 'var(--error)',
    border: '1px solid var(--error)',
    borderRadius: 'var(--r-md)'
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
    flexWrap: 'wrap',
    padding: '8px 14px',
    borderBottom: '1px solid var(--border)'
  },
  toolLabel: { flexShrink: 0, whiteSpace: 'nowrap', fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  check: { display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, whiteSpace: 'nowrap', fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  filter: {
    // 窄栏里过滤框是唯一「可以变窄」的项，让它吸收剩余压缩量
    flex: '1 1 90px',
    minWidth: 60,
    padding: '4px 8px',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    width: 140,
    outline: 'none'
  },
  ghost: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    padding: '5px 10px',
    background: 'var(--btn2-bg)',
    color: 'var(--text-1)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)'
  },
  timeline: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    overscrollBehavior: 'contain',
    padding: '0 14px',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-sm)',
    lineHeight: 1.7
  },
  empty: { color: 'var(--text-2)', padding: 20, textAlign: 'center' },
  recError: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, padding: '6px 14px', fontSize: 'var(--fs-xs)', color: 'var(--conn-error)', borderTop: '1px solid var(--border)' },
  recErrClose: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-2)', border: 'none', fontSize: 'var(--fs-sm)' },
  editor: {
    // flexShrink: 0 是这次修复的关键：发送区高度由拖拽条决定，
    // 允许收缩就等于允许布局算法把用户拉出来的高度吃掉
    flexShrink: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--bg-1)'
  },
  editorTools: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0, padding: '8px 14px' },
  select: {
    background: 'var(--field-bg)',
    color: 'var(--text-0)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    padding: '4px 6px',
    fontSize: 'var(--fs-sm)'
  },
  sendBtn: {
    padding: '6px 16px',
    background: 'var(--btn-bg)',
    color: 'var(--btn-fg)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-md)'
  },
  textarea: {
    width: '100%',
    // 吃掉发送区剩余空间：拖拽条把整块拉高，输入框跟着长高
    flex: '1 1 0',
    minHeight: 0,
    resize: 'none',
    padding: '10px 14px',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: 'none',
    borderTop: '1px solid var(--border)',
    outline: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-md)'
  },
  seg: { display: 'flex', background: 'var(--bg-inset)', padding: 2, gap: 2, borderRadius: 'var(--r-sm)', overflow: 'hidden' },
  segBtn: {
    padding: '4px 10px',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-xs)',
    fontFamily: 'var(--font-mono)'
  },
  segActive: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  snippets: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0, maxHeight: 76, overflowY: 'auto', padding: '0 14px 10px' },
  snipLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  // 模块标识：底色比普通徽标再深一档，让「我在哪个模块」先入眼
  moduleTag: {
    flexShrink: 0,
    padding: '3px 9px',
    background: 'var(--selected-strong-bg)',
    color: 'var(--text-0)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-xs)',
    fontWeight: 500
  },
  // 不可切换项用弱化文字表达，而不是一个点不动的下拉，避免误以为坏了
  fixedTag: {
    flexShrink: 0,
    padding: '3px 8px',
    background: 'var(--bg-inset)',
    color: 'var(--text-2)',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-xs)',
    fontFamily: 'var(--font-mono)'
  },
  snip: { padding: '3px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 12, fontSize: 'var(--fs-xs)' }
}

const rowStyles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', gap: 10, alignItems: 'baseline' },
  system: { display: 'flex', gap: 10, color: 'var(--text-2)', alignItems: 'baseline' },
  sysText: { fontStyle: 'italic' },
  connTag: { flexShrink: 0, fontSize: 'var(--fs-micro)', lineHeight: '14px', padding: '0 4px', border: '1px solid', borderRadius: 'var(--r-xs)', fontStyle: 'normal' },
  ts: { color: 'var(--text-2)', flexShrink: 0 },
  arrow: { flexShrink: 0, width: 34 },
  size: { color: 'var(--text-2)', flexShrink: 0, width: 42, textAlign: 'right' },
  peer: { color: 'var(--warn)', flexShrink: 0, fontSize: 'var(--fs-xs)' },
  content: { color: 'var(--text-0)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  replayTag: { flexShrink: 0, fontSize: 'var(--fs-micro)', lineHeight: '14px', padding: '0 4px', border: '1px solid transparent', borderRadius: 'var(--r-xs)', color: 'var(--text-2)', fontStyle: 'normal' },
  topic: { flexShrink: 0, maxWidth: 220, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--accent)', fontSize: 'var(--fs-xs)', cursor: 'pointer' },
  metaTag: { flexShrink: 0, fontSize: 'var(--fs-micro)', lineHeight: '14px', padding: '0 4px', background: 'var(--bg-inset)', color: 'var(--text-2)', borderRadius: 'var(--r-xs)', fontFamily: 'var(--font-mono)' },
  note: { flexShrink: 0, fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  pick: {
    flexShrink: 0,
    width: 14,
    height: 14,
    lineHeight: '13px',
    textAlign: 'center',
    fontSize: 'var(--fs-micro)',
    borderRadius: 'var(--r-xs)',
    border: '1px solid var(--field-border)',
    color: 'var(--text-2)',
    cursor: 'pointer',
    userSelect: 'none'
  },
  pickOn: { background: 'var(--selected-strong-bg)', color: 'var(--text-0)', borderColor: 'transparent' },
  pickHole: { flexShrink: 0, width: 14 },
  /*
    星标固定 13px 宽并常驻占位（靠 opacity 显隐而不是条件渲染）：
    如果按 hover 插入 DOM，鼠标经过时整行会横向抖一下，读 HEX 时非常晃眼。
  */
  star: {
    flexShrink: 0,
    width: 13,
    textAlign: 'center',
    color: 'var(--text-3)',
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: 'var(--fs-sm)',
    lineHeight: 1
  },
  starOn: { color: 'var(--warn)' },
  pickedWrap: { background: 'var(--selected-bg)', borderRadius: 'var(--r-xs)' },
  /*
    左侧 2px 色条用 boxShadow 内阴影画，而不是 borderLeft：
    虚拟列表按固定行高估算滚动位置，加真实边框会让每一行宽出 2px 并触发重排。
  */
  alertWarn: {
    background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
    boxShadow: 'inset 2px 0 0 0 var(--warn)',
    borderRadius: 'var(--r-xs)'
  },
  alertError: {
    background: 'color-mix(in srgb, var(--error) 12%, transparent)',
    boxShadow: 'inset 2px 0 0 0 var(--error)',
    borderRadius: 'var(--r-xs)'
  },
  alertTag: {
    flexShrink: 0,
    maxWidth: 260,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    padding: '0 5px',
    fontSize: 'var(--fs-micro)',
    lineHeight: '16px',
    border: '1px solid',
    borderRadius: 'var(--r-xs)'
  },
  parseBtn: { flexShrink: 0, marginLeft: 'auto', padding: '0 6px', fontSize: 'var(--fs-micro)', lineHeight: '16px', background: 'var(--btn2-bg)', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 'var(--r-xs)', fontFamily: 'var(--font-mono)' }
}
