import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  IPC,
  type CreateSessionRequest,
  type OutgoingFrame,
  type MockConfig,
  type HttpMockConfig,
  type HttpTestRequest,
  type HttpTestResponse,
  type SessionConfig,
  type SessionMetaPatch,
  type HistoryConfig,
  type HistoryContextQuery,
  type HistoryContextResult,
  type HistoryFrameRow,
  type HistoryHttpQuery,
  type HistoryHttpRow,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStats,
  type GlobalSearchQuery,
  type GlobalSearchResult,
  type AppInfo,
  type MqttSubscription,
  type ModbusPoint,
  type ModbusArea,
  type ModbusSlaveRegion,
  type ModbusSlaveRegionValues,
  type Peer,
  type Session,
  type SessionEvent,
  type TlsCertInfo,
  type TlsGenerateRequest,
  type TlsMaterial,
  type UpdateSettings,
  type UpdateState,
  type WindowState
} from '@shared/protocol'

const api = {
  createSession: (req: CreateSessionRequest): Promise<Session> =>
    ipcRenderer.invoke(IPC.sessionCreate, req),
  startSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionStart, id),
  stopSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionStop, id),
  removeSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionRemove, id),
  sendFrame: (frame: OutgoingFrame): Promise<void> => ipcRenderer.invoke(IPC.sessionSend, frame),
  listSessions: (): Promise<Session[]> => ipcRenderer.invoke(IPC.sessionList),
  listPeers: (id: string): Promise<Peer[]> => ipcRenderer.invoke(IPC.sessionPeers, id),
  kickPeer: (id: string, peerId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionKickPeer, id, peerId),
  updateMock: (id: string, cfg: MockConfig): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionUpdateMock, id, cfg),
  updateHttpMock: (id: string, cfg: HttpMockConfig): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionUpdateHttpMock, id, cfg),
  renameSession: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionRename, id, name),
  updateSessionConfig: (id: string, cfg: SessionConfig): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionUpdateConfig, id, cfg),
  setSessionAutoStart: (id: string, on: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionSetAutoStart, id, on),
  setSessionMeta: (id: string, patch: SessionMetaPatch): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionSetMeta, id, patch),
  historyQueryFrames: (q: HistoryQuery): Promise<HistoryPage<HistoryFrameRow>> =>
    ipcRenderer.invoke(IPC.historyQueryFrames, q),
  historyQueryHttp: (q: HistoryHttpQuery): Promise<HistoryPage<HistoryHttpRow>> =>
    ipcRenderer.invoke(IPC.historyQueryHttp, q),
  historyStats: (): Promise<HistoryStats & { available: boolean; failure: string }> =>
    ipcRenderer.invoke(IPC.historyStats),
  historyConfigGet: (): Promise<HistoryConfig> => ipcRenderer.invoke(IPC.historyConfigGet),
  historyConfigSet: (patch: Partial<HistoryConfig>): Promise<HistoryConfig> =>
    ipcRenderer.invoke(IPC.historyConfigSet, patch),
  historyClear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
  historyClearSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.historyClearSession, id),
  historyVacuum: (): Promise<void> => ipcRenderer.invoke(IPC.historyVacuum),
  historySearch: (q: GlobalSearchQuery): Promise<GlobalSearchResult> =>
    ipcRenderer.invoke(IPC.historySearch, q),
  historyContext: (q: HistoryContextQuery): Promise<HistoryContextResult> =>
    ipcRenderer.invoke(IPC.historyContext, q),
  historySessions: (): Promise<
    Array<{ sessionId: string; sessionName: string; sessionKind: string; count: number }>
  > => ipcRenderer.invoke(IPC.historySessions),
  historyExport: (
    kind: 'frames' | 'http',
    query: HistoryQuery | HistoryHttpQuery,
    defaultName: string,
    format?: 'csv' | 'har'
  ): Promise<{ path: string | null; rows: number }> =>
    ipcRenderer.invoke(IPC.historyExport, kind, query, defaultName, format ?? 'csv'),
  workspaceInfo: (): Promise<{ path: string }> => ipcRenderer.invoke(IPC.workspaceInfo),
  clearWorkspace: (): Promise<void> => ipcRenderer.invoke(IPC.workspaceClear),
  listSerialPorts: (): Promise<string[]> => ipcRenderer.invoke(IPC.serialList),
  saveTextFile: (defaultName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.fileSaveText, defaultName, content),
  openTextFile: (
    title: string,
    extensions: string[]
  ): Promise<{ path: string; content: string } | null> =>
    ipcRenderer.invoke(IPC.fileOpenText, title, extensions),
  // —— TLS 证书（HTTPS Mock 用） ——
  tlsGenerate: (req: TlsGenerateRequest): Promise<TlsMaterial> =>
    ipcRenderer.invoke(IPC.tlsGenerate, req),
  tlsInspect: (certPem: string, keyPem?: string): Promise<TlsCertInfo> =>
    ipcRenderer.invoke(IPC.tlsInspect, certPem, keyPem),
  tlsImport: (): Promise<TlsMaterial | null> => ipcRenderer.invoke(IPC.tlsImport),
  tlsCertsDir: (): Promise<string> => ipcRenderer.invoke(IPC.tlsExport),
  sendHttpTest: (req: HttpTestRequest): Promise<HttpTestResponse> =>
    ipcRenderer.invoke(IPC.httpTestSend, req),
  // —— MQTT ——
  mqttUpdateSubs: (id: string, subs: MqttSubscription[]): Promise<void> =>
    ipcRenderer.invoke(IPC.mqttUpdateSubs, id, subs),
  // —— Modbus ——
  modbusUpdatePoints: (id: string, points: ModbusPoint[]): Promise<void> =>
    ipcRenderer.invoke(IPC.modbusUpdatePoints, id, points),
  modbusReadPoint: (id: string, pointId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.modbusReadPoint, id, pointId),
  modbusWritePoint: (id: string, pointId: string, value: number | boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.modbusWritePoint, id, pointId, value),
  // —— Modbus 从站模拟 ——
  modbusSlaveUpdateRegions: (id: string, regions: ModbusSlaveRegion[]): Promise<void> =>
    ipcRenderer.invoke(IPC.modbusSlaveUpdateRegions, id, regions),
  modbusSlaveWrite: (id: string, area: ModbusArea, addr: number, value: number): Promise<void> =>
    ipcRenderer.invoke(IPC.modbusSlaveWrite, id, area, addr, value),
  modbusSlaveSnapshot: (id: string): Promise<ModbusSlaveRegionValues[]> =>
    ipcRenderer.invoke(IPC.modbusSlaveSnapshot, id),
  // —— 窗口控制（自绘标题栏用）——
  windowMinimize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
  windowToggleMaximize: (): Promise<void> => ipcRenderer.invoke(IPC.windowToggleMaximize),
  windowClose: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  windowState: (): Promise<WindowState> => ipcRenderer.invoke(IPC.windowState),
  onWindowState: (handler: (state: WindowState) => void): (() => void) => {
    const listener = (_e: unknown, state: WindowState): void => handler(state)
    ipcRenderer.on(IPC.windowEvent, listener)
    return () => ipcRenderer.removeListener(IPC.windowEvent, listener)
  },
  /**
   * 界面缩放。webFrame 只能在 preload 里访问（渲染层禁用了 nodeIntegration），
   * 因此缩放在这一层直接落地，不必绕一圈 IPC。范围锁在 0.7–1.6：
   * 再小报文对不齐，再大三栏布局会挤爆。
   */
  setZoom: (factor: number): number => {
    const clamped = Math.min(1.6, Math.max(0.7, factor))
    webFrame.setZoomFactor(clamped)
    return clamped
  },
  getZoom: (): number => webFrame.getZoomFactor(),
  /**
   * 平台标志，同步值。
   *
   * 为什么不用 appInfo()：那是异步 IPC，首帧拿不到，会导致 mac 上自绘的
   * 最小化/最大化/关闭按钮先渲染一帧再消失（和系统红绿灯重叠闪一下）。
   * preload 里 process 是可用的，直接同步传下去最稳。
   */
  platform: process.platform,
  /**
   * 开发者工具是否可用。主进程通过 additionalArguments 传下来，
   * 同步值 —— 渲染层首帧就要决定「帮助」菜单里显不显示这一项，
   * 走异步 IPC 会先画出来再抹掉，闪一下比没有更像故障。
   */
  devToolsEnabled: process.argv.includes('--enable-dev-tools'),
  // —— 应用信息与诊断 ——
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
  toggleDevTools: (): Promise<void> => ipcRenderer.invoke(IPC.appToggleDevTools),
  relaunchApp: (): Promise<void> => ipcRenderer.invoke(IPC.appRelaunch),
  notify: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.appNotify, { title, body }),
  // —— 应用更新 ——
  updateGetState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateGetState),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateCheck),
  updateDownload: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateDownload),
  updateInstall: (): Promise<boolean> => ipcRenderer.invoke(IPC.updateInstall),
  updateSettingsGet: (): Promise<UpdateSettings> => ipcRenderer.invoke(IPC.updateSettingsGet),
  updateSettingsSet: (patch: Partial<UpdateSettings>): Promise<UpdateSettings> =>
    ipcRenderer.invoke(IPC.updateSettingsSet, patch),
  /*
    更新状态用推送而不是让面板轮询：下载进度每秒好几次，轮询要么太慢看着卡顿，
    要么太快白烧 IPC。返回退订函数，面板卸载时解绑。
  */
  onUpdateState: (handler: (state: UpdateState) => void): (() => void) => {
    const listener = (_e: unknown, state: UpdateState): void => handler(state)
    ipcRenderer.on(IPC.updateEvent, listener)
    return () => ipcRenderer.removeListener(IPC.updateEvent, listener)
  },
  revealPath: (which: 'userData' | 'workspace' | 'history'): Promise<void> =>
    ipcRenderer.invoke(IPC.shellOpenPath, which),
  onEvent: (handler: (event: SessionEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: SessionEvent): void => handler(event)
    ipcRenderer.on(IPC.event, listener)
    return () => ipcRenderer.removeListener(IPC.event, listener)
  }
}

contextBridge.exposeInMainWorld('toolbox', api)

export type ToolboxApi = typeof api
