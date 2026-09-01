/// <reference types="vite/client" />
import type {
  AppInfo,
  CreateSessionRequest,
  MockConfig,
  HttpMockConfig,
  HttpTestRequest,
  HttpTestResponse,
  OutgoingFrame,
  Peer,
  Session,
  SessionConfig,
  SessionEvent,
  SessionMetaPatch,
  HistoryConfig,
  HistoryContextQuery,
  HistoryContextResult,
  HistoryFrameRow,
  HistoryHttpQuery,
  HistoryHttpRow,
  HistoryPage,
  HistoryQuery,
  HistoryStats,
  GlobalSearchQuery,
  GlobalSearchResult,
  MqttSubscription,
  ModbusPoint,
  ModbusArea,
  ModbusSlaveRegion,
  ModbusSlaveRegionValues,
  TlsCertInfo,
  TlsGenerateRequest,
  TlsMaterial,
  UpdateSettings,
  UpdateState,
  WindowState
} from '@shared/protocol'

export interface ToolboxApi {
  createSession: (req: CreateSessionRequest) => Promise<Session>
  startSession: (id: string) => Promise<void>
  stopSession: (id: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  sendFrame: (frame: OutgoingFrame) => Promise<void>
  listSessions: () => Promise<Session[]>
  listPeers: (id: string) => Promise<Peer[]>
  kickPeer: (id: string, peerId: string) => Promise<void>
  updateMock: (id: string, cfg: MockConfig) => Promise<void>
  updateHttpMock: (id: string, cfg: HttpMockConfig) => Promise<void>
  renameSession: (id: string, name: string) => Promise<void>
  updateSessionConfig: (id: string, cfg: SessionConfig) => Promise<void>
  setSessionAutoStart: (id: string, on: boolean) => Promise<void>
  setSessionMeta: (id: string, patch: SessionMetaPatch) => Promise<void>
  historyQueryFrames: (q: HistoryQuery) => Promise<HistoryPage<HistoryFrameRow>>
  historyQueryHttp: (q: HistoryHttpQuery) => Promise<HistoryPage<HistoryHttpRow>>
  historyStats: () => Promise<HistoryStats & { available: boolean; failure: string }>
  historyConfigGet: () => Promise<HistoryConfig>
  historyConfigSet: (patch: Partial<HistoryConfig>) => Promise<HistoryConfig>
  historyClear: () => Promise<void>
  historyClearSession: (id: string) => Promise<void>
  historyVacuum: () => Promise<void>
  historySearch: (q: GlobalSearchQuery) => Promise<GlobalSearchResult>
  historyContext: (q: HistoryContextQuery) => Promise<HistoryContextResult>
  historySessions: () => Promise<
    Array<{ sessionId: string; sessionName: string; sessionKind: string; count: number }>
  >
  historyExport: (
    kind: 'frames' | 'http',
    query: HistoryQuery | HistoryHttpQuery,
    defaultName: string,
    /** 'har' 仅对 kind='http' 生效，其余情况退回 CSV */
    format?: 'csv' | 'har'
  ) => Promise<{ path: string | null; rows: number }>
  workspaceInfo: () => Promise<{ path: string }>
  clearWorkspace: () => Promise<void>
  listSerialPorts: () => Promise<string[]>
  saveTextFile: (defaultName: string, content: string) => Promise<string | null>
  openTextFile: (
    title: string,
    extensions: string[]
  ) => Promise<{ path: string; content: string } | null>
  sendHttpTest: (req: HttpTestRequest) => Promise<HttpTestResponse>
  tlsGenerate: (req: TlsGenerateRequest) => Promise<TlsMaterial>
  tlsInspect: (certPem: string, keyPem?: string) => Promise<TlsCertInfo>
  tlsImport: () => Promise<TlsMaterial | null>
  tlsCertsDir: () => Promise<string>
  mqttUpdateSubs: (id: string, subs: MqttSubscription[]) => Promise<void>
  modbusUpdatePoints: (id: string, points: ModbusPoint[]) => Promise<void>
  modbusReadPoint: (id: string, pointId: string) => Promise<void>
  modbusWritePoint: (id: string, pointId: string, value: number | boolean) => Promise<void>
  modbusSlaveUpdateRegions: (id: string, regions: ModbusSlaveRegion[]) => Promise<void>
  modbusSlaveWrite: (id: string, area: ModbusArea, addr: number, value: number) => Promise<void>
  modbusSlaveSnapshot: (id: string) => Promise<ModbusSlaveRegionValues[]>
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowState: () => Promise<WindowState>
  onWindowState: (handler: (state: WindowState) => void) => () => void
  setZoom: (factor: number) => number
  getZoom: () => number
  /** 同步平台标志（'darwin' | 'win32' | 'linux'），首帧即可用 */
  platform: string
  /** 开发者工具是否可用（打包版为 false，菜单项与快捷键都会隐去） */
  devToolsEnabled: boolean
  appInfo: () => Promise<AppInfo>
  toggleDevTools: () => Promise<void>
  relaunchApp: () => Promise<void>
  /** 发系统通知。返回 false 表示系统不支持通知 */
  notify: (title: string, body: string) => Promise<boolean>
  updateGetState: () => Promise<UpdateState>
  updateCheck: () => Promise<UpdateState>
  updateDownload: () => Promise<UpdateState>
  /** 返回 false 表示当前不是「已下载」状态，无法安装 */
  updateInstall: () => Promise<boolean>
  updateSettingsGet: () => Promise<UpdateSettings>
  updateSettingsSet: (patch: Partial<UpdateSettings>) => Promise<UpdateSettings>
  onUpdateState: (handler: (state: UpdateState) => void) => () => void
  revealPath: (which: 'userData' | 'workspace' | 'history') => Promise<void>
  onEvent: (handler: (event: SessionEvent) => void) => () => void
}

declare global {
  interface Window {
    toolbox: ToolboxApi
  }
}

export {}
