import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as os from 'node:os'
import {
  IPC,
  type CreateSessionRequest,
  type MockConfig,
  type HttpMockConfig,
  type HttpTestRequest,
  type OutgoingFrame,
  type SessionConfig,
  type SessionMetaPatch,
  type HistoryConfig,
  type HistoryHttpQuery,
  type HistoryQuery,
  type GlobalSearchQuery,
  type HistoryContextQuery,
  type WindowState,
  type MqttSubscription,
  type ModbusPoint,
  type ModbusArea,
  type ModbusSlaveRegion,
  type TlsCertInfo,
  type TlsGenerateRequest,
  type TlsMaterial,
  type UpdateSettings
} from '@shared/protocol'
import { SessionManager } from './session-manager'
import { parseCliArgs, runCli } from './cli/run'
import { listSerialPorts } from './adapters/serial'
import { sendHttpTest } from './http-test/client'
import { clearWorkspace, workspacePath } from './persistence'
import { migrateLegacyUserData } from './userDataMigration'
import { historyDbPath } from './history/store'
import { historyFramesToCsv, historyHttpToCsv, historyHttpToHar } from './history/export'
import { certsDirPath, generateAndSave, importFromFiles, inspectCert } from './tls/certStore'
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateSettings,
  getUpdateState,
  initUpdater,
  quitAndInstall,
  setUpdateSettings
} from './updater'

/**
 * 用户数据迁移必须发生在所有 userData 读写之前。
 *
 * 放在模块顶层而不是 whenReady 里：SessionManager 在模块作用域就 new 了 HistoryStore，
 * 而历史库、工作区、更新配置都指向 app.getPath('userData')。若等到 whenReady 再搬，
 * 新目录里可能已经生成了空的 history.db，迁移就会因「目标已存在」整段跳过。
 */
const legacyMigration = migrateLegacyUserData()

let mainWindow: BrowserWindow | null = null

/**
 * 开发者工具是否可用：只在未打包的开发运行里放开。
 *
 * 为什么用 app.isPackaged 而不是自定义环境变量：环境变量会被用户在启动时
 * 覆盖，等于没锁；isPackaged 由 Electron 依据是否运行在 asar 内判定，
 * 装出来的应用无论怎么起都是 false。
 *
 * 为什么要三处一起关（webPreferences.devTools / IPC 处理器 / 键盘拦截）：
 * 三条路径互不相通 —— 菜单走 IPC、F12 与 Ctrl+Shift+I 走 Chromium 内建
 * 快捷键、右键审查元素走上下文菜单。只关一处，另两条照样能开出面板。
 */
const DEV_TOOLS_ENABLED = !app.isPackaged

// 单实例限制：同一时间只允许运行一个应用实例。
// 抢锁失败说明已有实例在运行，本次进程直接退出，并由已存在的实例接管窗口聚焦。
/*
  命令行 / CI 模式。
  必须在单实例锁之前判断：流水线里完全可能同时有一个 GUI 实例开着，
  这时 CLI 仍然要能独立跑完并以退出码汇报结果，不能被「已有一个实例」挡回去。
*/
let cliParseFailed = false
let cliOptions: ReturnType<typeof parseCliArgs> = null
try {
  cliOptions = parseCliArgs(process.argv)
} catch (e) {
  cliParseFailed = true
  console.error(String((e as Error)?.message ?? e))
}

if (cliParseFailed) {
  app.exit(2)
} else if (cliOptions) {
  void runCli(cliOptions)
    .then((code) => app.exit(code))
    .catch((e) => {
      console.error('集合执行失败：' + String((e as Error)?.message ?? e))
      app.exit(2)
    })
} else {
const gotSingleInstanceLock = app.requestSingleInstanceLock()

function focusExistingWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/** 把窗口状态推给渲染层，自绘标题栏据此切换最大化/还原图标 */
function pushWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const state: WindowState = {
    maximized: mainWindow.isMaximized(),
    fullScreen: mainWindow.isFullScreen(),
    focused: mainWindow.isFocused()
  }
  mainWindow.webContents.send(IPC.windowEvent, state)
}

function createWindow(): void {
  /**
   * 窗口最大化曾被系统禁用，根因是 `transparent: true`：
   * Windows 下透明窗口走的是分层窗口（layered window）路径，Electron 会连带
   * 关掉最大化能力（实测 isMaximizable() === false，最大化按钮灰掉）。
   * `backgroundMaterial: 'acrylic'` 单独设置也会踩同一条路径。
   *
   * 解法：不用 transparent 制造毛玻璃，改用
   *   titleBarStyle: 'hidden' + backgroundMaterial: 'acrylic' + 全透明 backgroundColor
   * 这套组合实测 isMaximizable() === true，同时保留 Win11 亚克力背景与原生
   * 边框圆角、贴边分屏（Snap Layouts）。标题栏由渲染层自绘（顶部菜单栏）。
   * 末尾再显式 setMaximizable(true) 兜底，避免不同 Windows 版本行为差异。
   */
  const isMac = process.platform === 'darwin'

  /**
   * 毛玻璃背景在两个平台是两套 API，不能混用：
   * - Windows：backgroundMaterial: 'acrylic'（vibrancy 在 Windows 上无效）
   * - macOS：vibrancy: 'under-window'（backgroundMaterial 在 mac 上无效）
   *
   * 标题栏同理。mac 用 'hiddenInset' 而不是 'hidden'：后者会把红绿灯按钮
   * 顶到最左上角，正好压住自绘菜单栏的 Logo；'hiddenInset' 会把它们内缩，
   * 再配合渲染层给 brand 区留出的左内边距，两者就不打架了。
   */
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    backgroundColor: '#00000000',
    ...(isMac ? { vibrancy: 'under-window' as const } : { backgroundMaterial: 'acrylic' as const }),
    // mac 的圆角与阴影由系统绘制，透明标题栏下需要它才不会出现直角黑边
    ...(isMac ? { transparent: false, trafficLightPosition: { x: 12, y: 10 } } : {}),
    maximizable: true,
    fullscreenable: true,
    title: 'FlowProbe',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // devTools: false 让 Chromium 连内建快捷键与审查元素菜单一起失效
      devTools: DEV_TOOLS_ENABLED,
      // 用启动参数把开关同步给 preload：渲染层首帧就要决定菜单里显不显示这一项，
      // 走异步 IPC 会先渲染出来再消失，闪一下反而更像 bug
      additionalArguments: DEV_TOOLS_ENABLED ? ['--enable-dev-tools'] : []
    }
  })

  mainWindow.setMaximizable(true)
  // 自绘菜单栏后不再需要系统菜单，同时避免 Alt 唤出空菜单
  Menu.setApplicationMenu(null)

  // 逐个注册而不是循环：Electron 的 on() 是按事件名重载的，联合类型匹配不到重载
  const w = mainWindow
  w.on('maximize', pushWindowState)
  w.on('unmaximize', pushWindowState)
  w.on('enter-full-screen', pushWindowState)
  w.on('leave-full-screen', pushWindowState)
  w.on('restore', pushWindowState)
  w.on('focus', pushWindowState)
  w.on('blur', pushWindowState)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    pushWindowState()
  })

  /**
   * 拦掉 Chromium 内建的开发者工具快捷键。
   * devTools: false 已经能挡住大部分入口，但不同 Electron 版本对这些组合键的
   * 处理并不一致，这里显式吃掉按键，行为才在所有版本上一致。
   */
  if (!DEV_TOOLS_ENABLED) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const k = (input.key || '').toLowerCase()
      const ctrlish = input.control || input.meta
      const devCombo = ctrlish && input.shift && (k === 'i' || k === 'j' || k === 'c')
      if (k === 'f12' || devCombo) event.preventDefault()
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const manager = new SessionManager((event) => {
  mainWindow?.webContents.send(IPC.event, event)
})

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // 用户再次启动应用时，聚焦已有窗口而不是开新实例
  app.on('second-instance', () => focusExistingWindow())

  app.whenReady().then(() => {
    ipcMain.handle(IPC.sessionCreate, (_e, req: CreateSessionRequest) => manager.create(req))
    ipcMain.handle(IPC.sessionStart, (_e, id: string) => manager.start(id))
    ipcMain.handle(IPC.sessionStop, (_e, id: string) => manager.stop(id))
    ipcMain.handle(IPC.sessionRemove, (_e, id: string) => manager.remove(id))
    ipcMain.handle(IPC.sessionSend, (_e, frame: OutgoingFrame) => manager.send(frame))
    ipcMain.handle(IPC.sessionList, () => manager.list())
    ipcMain.handle(IPC.sessionPeers, (_e, id: string) => manager.peers(id))
    ipcMain.handle(IPC.sessionKickPeer, (_e, id: string, peerId: string) =>
      manager.kickPeer(id, peerId)
    )
    ipcMain.handle(IPC.sessionUpdateMock, (_e, id: string, cfg: MockConfig) =>
      manager.updateMock(id, cfg)
    )
    ipcMain.handle(IPC.sessionUpdateHttpMock, (_e, id: string, cfg: HttpMockConfig) =>
      manager.updateHttpMock(id, cfg)
    )
    ipcMain.handle(IPC.sessionRename, (_e, id: string, name: string) => manager.rename(id, name))
    ipcMain.handle(IPC.sessionUpdateConfig, (_e, id: string, cfg: SessionConfig) =>
      manager.updateConfig(id, cfg)
    )
    ipcMain.handle(IPC.sessionSetAutoStart, (_e, id: string, on: boolean) =>
      manager.setAutoStart(id, on)
    )
    ipcMain.handle(IPC.sessionSetMeta, (_e, id: string, patch: SessionMetaPatch) =>
      manager.setMeta(id, patch)
    )
    // —— 报文历史（SQLite） ——
    ipcMain.handle(IPC.historyQueryFrames, (_e, q: HistoryQuery) => manager.history.queryFrames(q))
    ipcMain.handle(IPC.historyQueryHttp, (_e, q: HistoryHttpQuery) => manager.history.queryHttp(q))
    ipcMain.handle(IPC.historyStats, () => ({
      ...manager.history.stats(),
      available: manager.history.available(),
      failure: manager.history.failureReason()
    }))
    ipcMain.handle(IPC.historyConfigGet, () => manager.history.getConfig())
    ipcMain.handle(IPC.historyConfigSet, (_e, patch: Partial<HistoryConfig>) =>
      manager.history.setConfig(patch)
    )
    ipcMain.handle(IPC.historyClear, () => manager.history.clearAll())
    ipcMain.handle(IPC.historyClearSession, (_e, id: string) => manager.history.clearSession(id))
    ipcMain.handle(IPC.historyVacuum, () => manager.history.vacuum())
    ipcMain.handle(IPC.historySessions, () => manager.history.listSessions())
    ipcMain.handle(IPC.historySearch, (_e, q: GlobalSearchQuery) => manager.history.search(q))
    ipcMain.handle(IPC.historyContext, (_e, q: HistoryContextQuery) => manager.history.context(q))
    /**
     * 历史导出。查询与序列化都在主进程完成：
     * 十万行报文若先经 IPC 搬到渲染层再拼字符串，会白白复制一份大对象。
     */
    ipcMain.handle(
      IPC.historyExport,
      async (
        _e,
        kind: 'frames' | 'http',
        query: HistoryQuery | HistoryHttpQuery,
        defaultName: string,
        format: 'csv' | 'har' = 'csv'
      ): Promise<{ path: string | null; rows: number }> => {
        const capped = { ...query, limit: 50000, offset: 0 }
        // 行数取查询结果长度，不能数换行：报文正文里本身可能带换行，数出来会偏大
        let rows = 0
        let content = ''
        // HAR 只对 HTTP 请求有意义：报文是裸字节流，套不进请求/响应模型
        const asHar = format === 'har' && kind === 'http'
        if (kind === 'frames') {
          const page = manager.history.queryFrames(capped as HistoryQuery)
          rows = page.rows.length
          content = historyFramesToCsv(page.rows)
        } else {
          const page = manager.history.queryHttp(capped as HistoryHttpQuery)
          rows = page.rows.length
          content = asHar
            ? historyHttpToHar(page.rows, app.getVersion())
            : historyHttpToCsv(page.rows)
        }
        if (!mainWindow) return { path: null, rows }
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: '导出历史',
          defaultPath: defaultName,
          filters: asHar
            ? [{ name: 'HAR 1.2', extensions: ['har'] }, { name: '所有文件', extensions: ['*'] }]
            : [
                { name: 'CSV 表格', extensions: ['csv'] },
                { name: '所有文件', extensions: ['*'] }
              ]
        })
        if (canceled || !filePath) return { path: null, rows }
        /*
          只有 CSV 才加 BOM：Excel 不带 BOM 会把中文认成乱码。
          JSON 加 BOM 反而是坏事 —— DevTools 与多数解析器会在首字符处直接报错。
        */
        await writeFile(filePath, asHar ? content : '\uFEFF' + content, 'utf8')
        return { path: filePath, rows }
      }
    )
    // —— 窗口控制（自绘标题栏）——
    ipcMain.handle(IPC.windowMinimize, () => mainWindow?.minimize())
    ipcMain.handle(IPC.windowToggleMaximize, () => {
      if (!mainWindow) return
      // mac 上 maximize() 的观感是「缩放到合适大小」而非铺满，且与绿灯的全屏语义混淆。
      // 这里统一成：已最大化就还原，否则最大化，交给 Electron 各平台自己的实现。
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    })
    ipcMain.handle(IPC.windowClose, () => mainWindow?.close())
    ipcMain.handle(
      IPC.windowState,
      (): WindowState => ({
        maximized: mainWindow?.isMaximized() === true,
        fullScreen: mainWindow?.isFullScreen() === true,
        focused: mainWindow?.isFocused() === true
      })
    )
    // —— 应用级信息与诊断 ——
    ipcMain.handle(IPC.appInfo, () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath('userData'),
      workspacePath: workspacePath(),
      historyPath: historyDbPath(),
      lanIps: Object.values(os.networkInterfaces())
        .flatMap((list) => list ?? [])
        .filter((info) => info.family === 'IPv4' && !info.internal)
        .map((info) => info.address)
    }))
    // 打包版直接静默返回：渲染层已经不显示入口，这里是兜底（IPC 通道对渲染层始终可达）
    ipcMain.handle(IPC.appToggleDevTools, () => {
      if (!DEV_TOOLS_ENABLED) return
      mainWindow?.webContents.toggleDevTools()
    })
    // —— 应用更新（M31）——
    // 状态查询与变更分开：界面首次挂载要立刻拿到当前状态（可能是上次检查的结果），
    // 之后的变化由 updateEvent 推送，避免面板自己轮询
    ipcMain.handle(IPC.updateGetState, () => getUpdateState())
    ipcMain.handle(IPC.updateCheck, () => checkForUpdate())
    ipcMain.handle(IPC.updateDownload, () => downloadUpdate())
    ipcMain.handle(IPC.updateInstall, () => quitAndInstall())
    ipcMain.handle(IPC.updateSettingsGet, () => getUpdateSettings())
    ipcMain.handle(IPC.updateSettingsSet, (_e, patch: Partial<UpdateSettings>) =>
      setUpdateSettings(patch)
    )
    ipcMain.handle(IPC.appRelaunch, () => {
      app.relaunch()
      app.exit(0)
    })
    /*
      系统通知。给定时巡检用：任务在后台跑，用户很可能正看着别的窗口，
      界面里的红点根本看不到，只有系统级通知能把人叫回来。

      标题与正文由渲染层给，但这里不做转发式的任意通知：只在支持通知的系统上发，
      点击通知时把窗口提到前台（否则用户点了没反应，会以为通知是坏的）。
    */
    ipcMain.handle(IPC.appNotify, (_e, payload: { title: string; body: string }) => {
      if (!Notification.isSupported()) return false
      const n = new Notification({
        title: payload.title,
        body: payload.body,
        silent: false
      })
      n.on('click', () => {
        if (!mainWindow) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      })
      n.show()
      return true
    })
    // 打开本地目录/文件（工作区、历史库所在位置）。只接受主进程已知路径，
    // 不接受渲染层传任意字符串，避免变成任意路径打开器
    ipcMain.handle(IPC.shellOpenPath, (_e, which: 'userData' | 'workspace' | 'history') => {
      const target =
        which === 'workspace'
          ? workspacePath()
          : which === 'history'
            ? historyDbPath()
            : app.getPath('userData')
      return shell.showItemInFolder(target)
    })
    // —— MQTT ——
    ipcMain.handle(IPC.mqttUpdateSubs, (_e, id: string, subs: MqttSubscription[]) =>
      manager.updateMqttSubs(id, subs)
    )
    // —— Modbus ——
    ipcMain.handle(IPC.modbusUpdatePoints, (_e, id: string, points: ModbusPoint[]) =>
      manager.updateModbusPoints(id, points)
    )
    ipcMain.handle(IPC.modbusReadPoint, (_e, id: string, pointId: string) =>
      manager.readModbusPoint(id, pointId)
    )
    ipcMain.handle(
      IPC.modbusWritePoint,
      (_e, id: string, pointId: string, value: number | boolean) =>
        manager.writeModbusPoint(id, pointId, value)
    )
    // —— Modbus 从站模拟 ——
    ipcMain.handle(IPC.modbusSlaveUpdateRegions, (_e, id: string, regions: ModbusSlaveRegion[]) =>
      manager.updateSlaveRegions(id, regions)
    )
    ipcMain.handle(
      IPC.modbusSlaveWrite,
      (_e, id: string, area: ModbusArea, addr: number, value: number) =>
        manager.writeSlaveRegister(id, area, addr, value)
    )
    ipcMain.handle(IPC.modbusSlaveSnapshot, (_e, id: string) => manager.slaveSnapshot(id))
    ipcMain.handle(IPC.workspaceInfo, () => ({ path: workspacePath() }))
    ipcMain.handle(IPC.workspaceClear, () => clearWorkspace())
    ipcMain.handle(IPC.serialList, () => listSerialPorts())
    ipcMain.handle(IPC.httpTestSend, (_e, req: HttpTestRequest) => sendHttpTest(req))
    // 导出文本文件（测试报告等）：由主进程弹出保存对话框并落盘
    ipcMain.handle(
      IPC.fileSaveText,
      async (_e, defaultName: string, content: string): Promise<string | null> => {
        if (!mainWindow) return null
        // 按默认文件名的后缀把对应类型排到第一个，用户不用手动切筛选器
        const ext = (defaultName.split('.').pop() ?? '').toLowerCase()
        const known: Record<string, { name: string; extensions: string[] }> = {
          md: { name: 'Markdown', extensions: ['md'] },
          json: { name: 'JSON', extensions: ['json'] },
          csv: { name: 'CSV 表格', extensions: ['csv'] },
          txt: { name: '纯文本', extensions: ['txt'] }
        }
        const rest = Object.entries(known)
          .filter(([k]) => k !== ext)
          .map(([, v]) => v)
        const filters = [
          ...(known[ext] ? [known[ext]] : []),
          ...rest,
          { name: '所有文件', extensions: ['*'] }
        ]
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: '保存文件',
          defaultPath: defaultName,
          filters
        })
        if (canceled || !filePath) return null
        // CSV 加 UTF-8 BOM，Excel 打开中文才不会乱码
        const payload = filePath.toLowerCase().endsWith('.csv') ? '\uFEFF' + content : content
        await writeFile(filePath, payload, 'utf8')
        return filePath
      }
    )

    // 读取文本文件（导入录制、集合等）：主进程弹出打开对话框并读盘
    ipcMain.handle(
      IPC.fileOpenText,
      async (
        _e,
        title: string,
        extensions: string[]
      ): Promise<{ path: string; content: string } | null> => {
        if (!mainWindow) return null
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
          title,
          properties: ['openFile'],
          filters: [
            { name: extensions.join('/').toUpperCase(), extensions },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
        if (canceled || filePaths.length === 0) return null
        const target = filePaths[0]
        // 去掉可能存在的 UTF-8 BOM，否则 JSON.parse 会失败
        const raw = await readFile(target, 'utf8')
        return { path: target, content: raw.replace(/^\uFEFF/, '') }
      }
    )

    // —— TLS 证书 ——
    // 生成自签证书并落盘到 userData/certs
    ipcMain.handle(IPC.tlsGenerate, async (_e, req: TlsGenerateRequest): Promise<TlsMaterial> =>
      generateAndSave(req)
    )

    // 体检已有证书（解析 + 有效期 + 私钥匹配）
    ipcMain.handle(
      IPC.tlsInspect,
      async (_e, certPem: string, keyPem?: string): Promise<TlsCertInfo> =>
        inspectCert(certPem, keyPem)
    )

    /**
     * 导入现成的证书对。
     *
     * 两次对话框而不是一次多选：多选拿到的是一个无序数组，靠扩展名猜哪个是 key
     * 在 .pem/.pem 这种同名场景下会猜错，而猜错的表现是握手失败——很难联想到是选错了文件。
     */
    ipcMain.handle(IPC.tlsImport, async (): Promise<TlsMaterial | null> => {
      if (!mainWindow) return null
      const pick = async (title: string, exts: string[]): Promise<string | null> => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
          title,
          properties: ['openFile'],
          filters: [
            { name: exts.join('/').toUpperCase(), extensions: exts },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
        return canceled || filePaths.length === 0 ? null : filePaths[0]
      }
      const certPath = await pick('选择证书文件（.crt / .pem / .cer）', ['crt', 'pem', 'cer'])
      if (!certPath) return null
      const keyPath = await pick('选择私钥文件（.key / .pem）', ['key', 'pem'])
      if (!keyPath) return null
      try {
        return importFromFiles(certPath, keyPath)
      } catch (e) {
        return {
          certPem: '',
          keyPem: '',
          certPath,
          keyPath,
          info: { ok: false, error: '读取失败：' + (e as Error).message }
        }
      }
    })

    // 导出证书正文（供导入系统信任库）；返回证书目录供「打开所在目录」使用
    ipcMain.handle(IPC.tlsExport, async (): Promise<string> => certsDirPath())

    // 历史库先开，恢复会话时产生的系统消息也能落库
    manager.initHistory()

    // 改名后的数据迁移结果只在真的搬过东西时打一行日志：
  // 用户报「升级后会话没了」时，这行是判断迁移有没有生效的唯一线索
  if (legacyMigration.migrated) {
    console.log('[migration] 已从旧数据目录迁移：' + legacyMigration.from + ' → ' + legacyMigration.copied.join(', '))
  } else if (legacyMigration.error) {
    console.warn('[migration] 旧数据目录迁移失败：' + legacyMigration.error)
  }

  // 更新器只读配置、注册状态，真正的网络检查延迟到窗口起来之后（见 initUpdater 注释）
    initUpdater()

    // 先恢复上次的会话，再开窗口；渲染进程首帧就能拿到完整列表
    manager.restore()

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    manager.disposeAll()
    if (process.platform !== 'darwin') app.quit()
  })
}

}
