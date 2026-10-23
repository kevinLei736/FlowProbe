import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { useTheme } from '../store/useTheme'
import { useLayout } from '../store/useLayout'
import { useDiff } from '../store/useDiff'
import { useTimeSync } from '../store/useTimeSync'
import { useTabs } from '../store/useTabs'
import { useSessionOrg } from '../store/useSessionOrg'
import { DashboardView } from '../features/dashboard/DashboardView'
import { HistoryView } from '../features/history/HistoryView'
import { GlobalSearchPanel, type SearchJump } from '../features/search/GlobalSearchPanel'
import { HistoryContextView, type ContextTarget } from '../features/history/HistoryContextView'
import { Sidebar } from '../components/Sidebar'
import { MenuBar } from '../components/menu/MenuBar'
import { buildMenus } from '../components/menu/menuModel'
import { AboutDialog } from '../components/dialogs/AboutDialog'
import { ShortcutsDialog } from '../components/dialogs/ShortcutsDialog'
import { GuidePanel } from '../features/help/GuidePanel'
import { UpdateDialog } from '../features/help/UpdateDialog'
import type { UpdatePhase } from '@shared/protocol'
import { PromptDialog } from '../components/dialogs/PromptDialog'
import { exportConfig, importConfigViaDialog } from '../features/workspace/configIo'
import { SessionView } from '../features/sessions/SessionView'
import { SessionTabs, TAB_MIME } from '../features/sessions/SessionTabs'
import { HttpMockView } from '../features/http-mock/HttpMockView'
import { NewSessionDialog } from '../features/sessions/NewSessionDialog'
import { EmptyState } from '../components/EmptyState'
import { ToolsPanel } from '../features/tools/ToolsPanel'
import { ApiClientPanel } from '../features/http-test/ApiClientPanel'
import { MonitorPanel } from '../features/http-test/MonitorPanel'
import { useMonitor } from '../features/http-test/useMonitor'
import { useMonitorScheduler } from '../features/http-test/useMonitorScheduler'
import { AlertCenterPanel } from '../features/alerts/AlertCenterPanel'
import { useAlerts } from '../features/alerts/useAlerts'
import { MarksPanel } from '../features/sessions/MarksPanel'
import { useMarks } from '../store/useMarks'
import { CommandPalette } from '../components/CommandPalette'
import { SplitPane } from '../components/SplitPane'
import { KIND_META } from './meta'

/** 会话处于「已建立/已监听」时视作运行中，菜单据此启用启动或断开 */
const RUNNING = new Set(['connected', 'listening', 'connecting'])

export function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const initTheme = useTheme((s) => s.init)
  const initLayout = useLayout((s) => s.init)
  const initOrg = useSessionOrg((s) => s.init)
  const sidebarVisible = useLayout((s) => s.sidebarVisible)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)
  const toggleInspector = useLayout((s) => s.toggleInspector)
  const inspectorVisible = useLayout((s) => s.inspectorVisible)
  const density = useLayout((s) => s.density)
  const setDensity = useLayout((s) => s.setDensity)
  const themeMode = useTheme((s) => s.mode)
  const setThemeMode = useTheme((s) => s.setMode)
  const timeSyncOn = useTimeSync((s) => s.enabled)
  const picking = useDiff((s) => s.picking)
  const diffOpen = useDiff((s) => s.open)
  const splitId = useLayout((s) => s.splitId)
  const splitRatio = useLayout((s) => s.splitRatio)
  const focusPane = useLayout((s) => s.focusPane)
  const setSplit = useLayout((s) => s.setSplit)
  const setSplitRatio = useLayout((s) => s.setSplitRatio)
  const setFocusPane = useLayout((s) => s.setFocusPane)

  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const storeReady = useStore((s) => s.sessionsLoaded)
  const tabIds = useTabs((s) => s.ids)
  const previewId = useTabs((s) => s.previewId)
  const initTabs = useTabs((s) => s.init)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [apiOpen, setApiOpen] = useState(false)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [marksOpen, setMarksOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [dashboardOpen, setDashboardOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  /*
    更新状态提到外壳来订阅，而不是等更新面板挂载才订阅：
    「有新版本」这条结论要显示在顶部菜单项上，而菜单在面板打开之前就已经在那儿了。
  */
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle')
  const [renameOpen, setRenameOpen] = useState(false)
  // 从全局搜索跳进历史页时携带的落点，返回会话后清空
  const [historySeed, setHistorySeed] = useState<{
    keyword: string
    tab: 'frames' | 'http'
    sessionId: string
  } | null>(null)
  // 搜索命中行的上下文视图。它是浮层而不是整页，因为看完前后文往往还要回搜索结果继续挑下一条
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null)
  // 标签拖到中栏右半边时的提示。只在拖拽过程中出现，平时不占任何空间
  const [dropHint, setDropHint] = useState(false)

  /**
   * 是否有浮层正在前台。
   *
   * 全局快捷键是挂在 window 上的：弹窗打开时按 Ctrl+W，会同时被弹窗和外壳
   * 收到 —— 用户以为在操作弹窗，背后却关掉了一个标签页。这里用 ref 记录，
   * 避免把十几个开关塞进快捷键 effect 的依赖里。
   */
  const modalOpenRef = useRef(false)
  const paletteOpenRef = useRef(false)
  paletteOpenRef.current = paletteOpen
  modalOpenRef.current = Boolean(
    dialogOpen ||
      toolsOpen ||
      apiOpen ||
      monitorOpen ||
      alertsOpen ||
      marksOpen ||
      paletteOpen ||
      aboutOpen ||
      shortcutsOpen ||
      guideOpen ||
      updateOpen ||
      renameOpen ||
      contextTarget
  )

  /*
    巡检调度挂在外壳而不是接口测试面板：巡检的全部意义就是「界面关着也在跑」。
    绑在面板上的话，一关面板监控即停，等于没做。
  */
  useMonitorScheduler()
  const monitorUnread = useMonitor((s) => s.unread)
  /*
    告警规则要在「任何面板都没打开」时也生效——判定挂在收帧路径上，
    而规则数据原本只在告警中心挂载时才 load。这里在外壳启动时就恢复，
    否则重启应用后第一次收帧会因为规则表是空的而静默跳过。
  */
  const loadAlerts = useAlerts((s) => s.load)
  const alertUnread = useAlerts((s) => s.unread)
  /*
    书签同样在外壳启动时恢复，而不是等书签面板挂载：
    报文行上的星标要显示「这条已标过」，那份数据必须先在内存里。
  */
  const loadMarks = useMarks((s) => s.load)
  const markCount = useMarks((s) => s.marks.length)
  useEffect(() => {
    loadAlerts()
    loadMarks()
  }, [loadAlerts, loadMarks])

  // 更新状态：先取一次当前值（可能是启动时自动检查的结果），再订阅后续变化
  useEffect(() => {
    void window.toolbox.updateGetState().then((s) => setUpdatePhase(s.phase))
    return window.toolbox.onUpdateState((s) => setUpdatePhase(s.phase))
  }, [])
  // 左栏红点合并两类未读：对用户是同一件事「有什么不对的」
  const attention = monitorUnread + alertUnread

  useEffect(() => {
    init()
    initTheme()
    initLayout()
    initOrg()
    initTabs()
  }, [init, initTheme, initLayout, initOrg, initTabs])

  // 焦点会话总要有一个标签。挂在 activeId 上而不是在每个调用点手动开标签，
  // 是因为「切换会话」的入口有五处（左栏、命令面板、看板排行、搜索回跳、Ctrl+Tab），
  // 逐个补容易漏；这里统一兜底，默认落成预览标签。
  useEffect(() => {
    if (activeId) useTabs.getState().ensure(activeId)
  }, [activeId])

  // 会话被删除后清掉残留标签，否则标签条会指向不存在的会话。
  //
  // 必须等 initialized 为真才能清：会话列表是异步从主进程拉回来的，
  // 首帧 sessions 还是空数组，此时清理会把上次持久化恢复出来的标签
  // 全部误判为「已删除」而抹掉——表现就是重启后标签只剩当前这一个。
  useEffect(() => {
    if (!storeReady) return
    const alive = sessions.map((s) => s.id)
    useTabs.getState().prune(alive)
    // 对比选择与分屏都可能指向已删除的会话。
    // 分屏侧不清的话右半区会变成一片空白，而且用户找不到退出分屏的入口。
    useDiff.getState().prune(alive)
    const sp = useLayout.getState().splitId
    if (sp && !alive.includes(sp)) useLayout.getState().setSplit(null)
  }, [sessions, storeReady])

  const active = sessions.find((s) => s.id === activeId) ?? null
  const running = active ? RUNNING.has(active.status) : false

  // 标签顺序由 useTabs 决定，会话对象从 store 里取——标签只存 id，
  // 这样改名、状态变化都会自动反映到标签上，不需要同步两份数据
  const tabSessions = useMemo(
    () => tabIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is (typeof sessions)[number] => Boolean(s)),
    [tabIds, sessions]
  )

  const openDashboard = useCallback(() => {
    setHistoryOpen(false)
    setDashboardOpen(true)
  }, [])
  const openHistory = useCallback(() => {
    setDashboardOpen(false)
    setHistorySeed(null)
    setHistoryOpen(true)
  }, [])

  /**
   * Ctrl+Tab / Ctrl+Shift+Tab 循环切换。
   *
   * 有标签打开时只在标签之间循环，没有才退回全部会话列表。
   * 理由：标签代表「手头正在跟进的几个」，装了三十个会话的工作区里
   * 逐个 Tab 过去毫无意义，浏览器的 Ctrl+Tab 也只走已打开的标签。
   */
  const cycleSession = useCallback(
    (delta: number) => {
      const tabs = useTabs.getState().ids
      const all = useStore.getState().sessions
      const list = tabs.length > 1 ? tabs : all.map((s) => s.id)
      if (list.length < 2) return
      const cur = list.indexOf(useStore.getState().activeId ?? '')
      const next = (((cur < 0 ? 0 : cur) + delta) % list.length + list.length) % list.length
      useStore.getState().setActive(list[next])
    },
    []
  )

  /** 关标签后要把焦点交给邻居，否则中栏会空掉 */
  const closeTab = useCallback((id: string) => {
    const next = useTabs.getState().close(id)
    if (useStore.getState().activeId === id) useStore.getState().setActive(next)
  }, [])

  const closeTabsExcept = useCallback((id: string) => {
    useTabs.getState().closeOthers(id)
    useStore.getState().setActive(id)
  }, [])

  const closeTabsRight = useCallback((id: string) => {
    useTabs.getState().closeRight(id)
    if (!useTabs.getState().ids.includes(useStore.getState().activeId ?? '')) {
      useStore.getState().setActive(id)
    }
  }, [])

  const closeAllTabs = useCallback(() => {
    useTabs.getState().closeAll()
    useStore.getState().setActive(null)
  }, [])

  /**
   * 菜单与快捷键该作用于哪个会话。
   *
   * 分屏后「当前会话」有两个候选，光看 activeId 会出现
   * 「在右半区点了断开，结果左边那个断了」这种最难排查的错觉。
   * 统一走焦点侧。
   */
  const focusedId = useCallback((): string | null => {
    const l = useLayout.getState()
    if (l.splitId && l.focusPane === 'right') return l.splitId
    return useStore.getState().activeId
  }, [])

  const zoomBy = useCallback((delta: number) => {
    window.toolbox.setZoom(window.toolbox.getZoom() + delta)
  }, [])

  const menuActions = useMemo(
    () => ({
      newSession: () => setDialogOpen(true),
      duplicateSession: () => {
        const id = focusedId()
        if (id) void useStore.getState().duplicateSession(id)
      },
      importConfig: () => void importConfigViaDialog(),
      exportConfig: () => exportConfig(),
      revealWorkspace: () => void window.toolbox.revealPath('workspace'),
      revealHistory: () => void window.toolbox.revealPath('history'),
      quit: () => void window.toolbox.windowClose(),

      startSession: () => {
        const id = focusedId()
        if (id) useStore.getState().start(id)
      },
      stopSession: () => {
        const id = focusedId()
        if (id) useStore.getState().stop(id)
      },
      restartSession: () => {
        const id = focusedId()
        if (!id) return
        /*
          等 stop 真正完成再启动。
          固定延时 320ms 对服务端不可靠：端口可能还没释放，新的 listen 直接
          EADDRINUSE；对 MQTT 则是旧链路还占着 clientId，新链路连上就被踢。
          stop 现在返回 Promise，按实际关闭完成时间接续才稳。
        */
        void (async () => {
          await window.toolbox.stopSession(id)
          await window.toolbox.startSession(id)
        })()
      },
      renameSession: () => setRenameOpen(true),
      clearFrames: () => {
        const id = focusedId()
        if (id) useStore.getState().clearFrames(id)
      },
      removeSession: () => {
        const id = focusedId()
        if (id) useStore.getState().remove(id)
      },

      closeTab: () => {
        const id = useStore.getState().activeId
        if (id) closeTab(id)
      },
      closeOtherTabs: () => {
        const id = useStore.getState().activeId
        if (id) closeTabsExcept(id)
      },
      pinTab: () => {
        const id = useStore.getState().activeId
        if (id) useTabs.getState().pin(id)
      },
      toggleSidebar,
      toggleInspector,
      splitRight: () => {
        // 默认把「焦点会话的邻居」放到右边：分屏几乎总是为了两个会话对比，
        // 让用户先去选一个再点菜单多一步操作。
        const l = useLayout.getState()
        if (l.splitId) {
          setSplit(null)
          return
        }
        const ids = useTabs.getState().ids
        const cur = useStore.getState().activeId
        const other = ids.find((id) => id !== cur) ?? null
        if (other) setSplit(other)
      },
      swapSplit: () => {
        const next = useLayout.getState().swapSplit(useStore.getState().activeId)
        if (next) useStore.getState().setActive(next)
      },
      toggleTimeSync: () => {
        const t = useTimeSync.getState()
        t.setEnabled(!t.enabled)
      },
      toggleCompare: () => {
        const d = useDiff.getState()
        if (d.picks.length === 2 && !d.open) d.setOpen(true)
        else d.setPicking(!d.picking)
      },
      openDashboard,
      openHistory,
      openSearch: () => setSearchOpen(true),
      openPalette: () => setPaletteOpen(true),
      setTheme: setThemeMode,
      setDensity,
      zoomIn: () => zoomBy(0.1),
      zoomOut: () => zoomBy(-0.1),
      zoomReset: () => window.toolbox.setZoom(1),

      openApi: () => setApiOpen(true),
      openMonitor: () => setMonitorOpen(true),
      openAlerts: () => setAlertsOpen(true),
      openMarks: () => setMarksOpen(true),
      openTools: () => setToolsOpen(true),

      openGuide: () => setGuideOpen(true),
      openUpdate: () => setUpdateOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
      openAbout: () => setAboutOpen(true),
      toggleDevTools: () => void window.toolbox.toggleDevTools(),
      relaunch: () => void window.toolbox.relaunchApp()
    }),
    [
      toggleSidebar,
      toggleInspector,
      openDashboard,
      openHistory,
      setThemeMode,
      setDensity,
      zoomBy,
      closeTab,
      closeTabsExcept,
      focusedId,
      setSplit
    ]
  )

  const menus = useMemo(
    () =>
      buildMenus(menuActions, {
        hasSession: active !== null,
        tabCount: tabIds.length,
        activeIsPreview: previewId !== null && previewId === activeId,
        running,
        sidebarVisible,
        inspectorVisible,
        splitOn: splitId !== null,
        timeSyncOn,
        comparing: picking || diffOpen,
        theme: themeMode,
        density,
        monitorUnread,
        alertUnread,
        markCount,
        devToolsEnabled: window.toolbox.devToolsEnabled,
        updateAvailable: updatePhase === 'available' || updatePhase === 'downloading',
        updateReady: updatePhase === 'downloaded'
      }),
    [
      menuActions,
      monitorUnread,
      alertUnread,
      markCount,
      active,
      running,
      sidebarVisible,
      inspectorVisible,
      themeMode,
      density,
      tabIds,
      previewId,
      activeId,
      splitId,
      timeSyncOn,
      picking,
      diffOpen,
      updatePhase
    ]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // F12 / F11 不带修饰键，先单独处理。
      // 打包版不接开发者工具：这里连按键都不吃，交给主进程的 before-input-event
      // 统一吞掉，避免出现「按了有反应但没面板」的错觉
      // F1 是各类桌面应用的帮助键，用户会下意识去按。放在修饰键判断之前，
      // 否则会被 `if (!mod) return` 直接吞掉
      if (e.key === 'F1') {
        e.preventDefault()
        setGuideOpen((v) => !v)
        return
      }
      if (e.key === 'F12') {
        if (!window.toolbox.devToolsEnabled) return
        e.preventDefault()
        void window.toolbox.toggleDevTools()
        return
      }
      // 浮层打开时只保留缩放：其余快捷键交给浮层自己处理
      if (modalOpenRef.current) {
        const zoomCombo =
          (e.ctrlKey || e.metaKey) && ['=', '+', '-', '_', '0'].includes(e.key)
        // Ctrl+K 是命令面板自己的开关，面板打开时仍要能按它关掉
        const paletteToggle =
          paletteOpenRef.current && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'
        if (!zoomCombo && !paletteToggle) return
      }
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'tab') {
        e.preventDefault()
        cycleSession(e.shiftKey ? -1 : 1)
        return
      }
      // 缩放：主键盘与小键盘的 +/- 都要认
      if (key === '=' || key === '+') {
        e.preventDefault()
        zoomBy(0.1)
        return
      }
      if (key === '-' || key === '_') {
        e.preventDefault()
        zoomBy(-0.1)
        return
      }
      if (key === '0') {
        e.preventDefault()
        window.toolbox.setZoom(1)
        return
      }
      if (key === '/') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }
      // Ctrl+\ 分屏、Ctrl+Shift+D 报文对比。
      // 放在 switch 之前单独处理：'\\' 不是字母，而 Shift+D 会和下面的 Ctrl+D（看板）冲突
      if (key === '\\') {
        e.preventDefault()
        menuActions.splitRight()
        return
      }
      if (key === 'd' && e.shiftKey) {
        e.preventDefault()
        menuActions.toggleCompare()
        return
      }
      if (key === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (key === 'n') {
        e.preventDefault()
        setDialogOpen(true)
      } else if (key === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (key === 'j') {
        e.preventDefault()
        toggleInspector()
      } else if (key === 'd') {
        e.preventDefault()
        setHistoryOpen(false)
        setDashboardOpen((v) => !v)
      } else if (key === 'h') {
        e.preventDefault()
        setDashboardOpen(false)
        setHistorySeed(null)
        setHistoryOpen((v) => !v)
      } else if (key === 'f') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      } else if (key === 'm') {
        // M = mark。标注是排查中途随手要开的东西，值得一个快捷键
        e.preventDefault()
        setMarksOpen((v) => !v)
      } else if (key === 'r') {
        e.preventDefault()
        menuActions.restartSession()
      } else if (key === 'l') {
        e.preventDefault()
        menuActions.clearFrames()
      } else if (key === 'w') {
        // Ctrl+W 在浏览器里是关标签页。这里必须 preventDefault，
        // 否则 Electron 默认会把整个窗口关掉
        e.preventDefault()
        const id = useStore.getState().activeId
        if (id) closeTab(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar, toggleInspector, cycleSession, zoomBy, menuActions, closeTab])

  const paletteActions = useMemo(
    () => ({
      onNew: () => setDialogOpen(true),
      onTools: () => setToolsOpen(true),
      onApi: () => setApiOpen(true),
      onMonitor: () => setMonitorOpen(true),
      onAlerts: () => setAlertsOpen(true),
      onMarks: () => setMarksOpen(true),
      onDashboard: openDashboard,
      onHistory: openHistory,
      onSearch: () => setSearchOpen(true),
      onGuide: () => setGuideOpen(true),
      onUpdate: () => setUpdateOpen(true)
    }),
    [openDashboard, openHistory]
  )

  // 右半区会话对象。id 指向已删除会话的情况由上面的 prune 兜掉，这里只管取不到就当没分屏
  const splitSession = splitId ? (sessions.find((s) => s.id === splitId) ?? null) : null

  /**
   * 单个会话视图的渲染。
   *
   * key 绑会话 id 强制重挂载：视图里的显示编码、过滤词、展开状态都是
   * 「这个会话怎么看」的局部状态，切换会话时应该重置而不是串味。没有 key 时
   * React 会复用同一个实例，从 TCP 切到 Modbus 依然沿用 UTF-8 显示，
   * 二进制报文就成了一片控制字符。
   *
   * key 里带上 pane：左右互换时同一个会话从左边挪到右边，要让它重新按新角色初始化。
   */
  const renderSession = (s: (typeof sessions)[number], pane: 'single' | 'left' | 'right'): JSX.Element =>
    s.kind === 'http-mock' ? (
      <HttpMockView key={s.id + ':' + pane} session={s} />
    ) : (
      <SessionView key={s.id + ':' + pane} session={s} pane={pane} />
    )

  const barTitle = dashboardOpen
    ? '数据看板'
    : historyOpen
      ? '报文历史'
      : active
        ? active.name
        : 'FlowProbe'
  const barSub = !dashboardOpen && !historyOpen && active ? KIND_META[active.kind].label : undefined
  // 看板/历史是「整页系统视图」，它们盖住会话视图，标签条要按此降级
  const systemViewOpen = dashboardOpen || historyOpen

  return (
    <div style={styles.shell}>
      <MenuBar groups={menus} title={barTitle} subtitle={barSub} />

      <div style={{ ...styles.body, gridTemplateColumns: sidebarVisible ? '244px minmax(0, 1fr)' : 'minmax(0, 1fr)' }}>
        {sidebarVisible && (
          <Sidebar
            onNew={() => setDialogOpen(true)}
            onTools={() => setToolsOpen(true)}
            onApi={() => setApiOpen(true)}
            onMonitor={() => setMonitorOpen(true)}
            onAlerts={() => setAlertsOpen(true)}
            monitorUnread={monitorUnread}
            alertUnread={attention}
            onDashboard={openDashboard}
            onHistory={openHistory}
            onSearch={() => setSearchOpen(true)}
            onPalette={() => setPaletteOpen(true)}
          />
        )}
        <main
          style={styles.main}
          /*
            标签拖到中栏右半边 → 进入分屏。
            判定用 types 而不是 getData：dragover 阶段浏览器出于安全不给读数据，
            只能看类型名。落点阈值取 60% 而不是 50%，是为了不影响「拖到中间只是想排序」的手感。
          */
          onDragOver={(e) => {
            if (systemViewOpen || !e.dataTransfer.types.includes(TAB_MIME)) return
            const r = e.currentTarget.getBoundingClientRect()
            const right = e.clientX - r.left > r.width * 0.6
            if (!right) {
              if (dropHint) setDropHint(false)
              return
            }
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!dropHint) setDropHint(true)
          }}
          onDragLeave={() => setDropHint(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes(TAB_MIME)) return
            e.preventDefault()
            setDropHint(false)
            const id = e.dataTransfer.getData(TAB_MIME)
            if (!id) return
            // 拖的就是当前左半区那个会话时，分屏没有意义（两边一模一样）
            if (id === useStore.getState().activeId) return
            setSplit(id)
          }}
        >
          {/*
            标签条在两种情况下出现：有会话标签时，或侧栏被折叠时（此时它承载
            「展开侧栏」按钮）。看板与历史页是整页系统视图，标签列表置空——
            给它们也列标签会让人以为能和会话并排对比，反而误导；但折叠按钮
            仍需保留，否则在看板里把侧栏收起来就再也展不开了。
            折叠按钮收进标签条左端而不是浮在报文区左上角，是因为那个浮动按钮
            会盖住时间轴第一行。
          */}
          {(systemViewOpen ? !sidebarVisible : tabSessions.length > 0 || !sidebarVisible) && (
            <SessionTabs
              sessions={systemViewOpen ? [] : tabSessions}
              activeId={activeId}
              previewId={previewId}
              sidebarVisible={sidebarVisible}
              onShowSidebar={toggleSidebar}
              onSelect={(id) => useStore.getState().setActive(id)}
              onPin={(id) => useTabs.getState().pin(id)}
              onClose={closeTab}
              onCloseOthers={closeTabsExcept}
              onCloseRight={closeTabsRight}
              onCloseAll={closeAllTabs}
              onReorder={(from, to) => useTabs.getState().reorder(from, to)}
              onNew={() => setDialogOpen(true)}
              splitId={splitId}
              onSplit={setSplit}
              onSwapSplit={() => {
                const next = useLayout.getState().swapSplit(useStore.getState().activeId)
                if (next) useStore.getState().setActive(next)
              }}
            />
          )}
          {dashboardOpen ? (
            <DashboardView onClose={() => setDashboardOpen(false)} />
          ) : historyOpen ? (
            <HistoryView
              key={historySeed ? 'seed:' + historySeed.keyword + ':' + historySeed.sessionId : 'plain'}
              onClose={() => {
                setHistoryOpen(false)
                setHistorySeed(null)
              }}
              initialKeyword={historySeed?.keyword ?? ''}
              initialTab={historySeed?.tab ?? 'frames'}
              initialSessionId={historySeed?.sessionId ?? ''}
            />
          ) : active ? (
            splitSession ? (
              // 分屏：两侧各自是完整会话视图。pane 传进去让它们知道自己是哪一侧，
              // 检查器只在焦点侧显示、联动广播才分得清方向。
              <SplitPane
                ratio={splitRatio}
                onRatio={setSplitRatio}
                focus={focusPane}
                onFocusLeft={() => setFocusPane('left')}
                onFocusRight={() => setFocusPane('right')}
                left={renderSession(active, 'left')}
                right={renderSession(splitSession, 'right')}
              />
            ) : (
              renderSession(active, 'single')
            )
          ) : (
            <EmptyState onNew={() => setDialogOpen(true)} />
          )}
          {dropHint && <div style={styles.dropHint}>松开放到右半区并排对比</div>}
        </main>
      </div>

      {dialogOpen && <NewSessionDialog onClose={() => setDialogOpen(false)} />}
      {toolsOpen && <ToolsPanel onClose={() => setToolsOpen(false)} />}
      {apiOpen && (
        <ApiClientPanel onClose={() => setApiOpen(false)} onOpenMonitor={() => { setApiOpen(false); setMonitorOpen(true) }} />
      )}
      {monitorOpen && <MonitorPanel onClose={() => setMonitorOpen(false)} />}
      {alertsOpen && <AlertCenterPanel onClose={() => setAlertsOpen(false)} />}
      {marksOpen && (
        <MarksPanel
          onClose={() => setMarksOpen(false)}
          onLocate={(sid, fid) => {
            /*
              从顶部菜单打开时书签可能属于任何会话，所以要先把那个会话切成焦点
              并确保它有标签，再发定位请求 —— 只发请求的话目标会话根本没渲染，
              没人认领这个请求。
            */
            useStore.getState().setActive(sid)
            useTabs.getState().ensure(sid)
            useMarks.getState().requestLocate(sid, fid)
            setMarksOpen(false)
          }}
        />
      )}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {guideOpen && <GuidePanel onClose={() => setGuideOpen(false)} />}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
      {renameOpen && active && (
        <PromptDialog
          title="重命名会话"
          label="新的会话名称"
          initial={active.name}
          confirmText="重命名"
          onConfirm={(v) => useStore.getState().renameSession(active.id, v)}
          onClose={() => setRenameOpen(false)}
        />
      )}
      {searchOpen && (
        <GlobalSearchPanel
          onClose={() => setSearchOpen(false)}
          onJump={(j: SearchJump) => {
            if (j.mode === 'context' && typeof j.hitId === 'number') {
              setContextTarget({ kind: j.kind, id: j.hitId, keyword: j.keyword })
              return
            }
            setDashboardOpen(false)
            setHistorySeed({
              keyword: j.keyword,
              tab: j.kind === 'http' ? 'http' : 'frames',
              sessionId: j.sessionId
            })
            setHistoryOpen(true)
          }}
        />
      )}
      {contextTarget && (
        <HistoryContextView
          target={contextTarget}
          onClose={() => setContextTarget(null)}
          onLocateSession={(id) => {
            // 回到实时时间轴要先退出历史页/看板，否则会话视图被它们盖着
            setHistoryOpen(false)
            setHistorySeed(null)
            setDashboardOpen(false)
            useStore.getState().setActive(id)
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--app-bg)'
  },
  body: {
    display: 'grid',
    gridTemplateRows: 'minmax(0, 1fr)',
    minHeight: 0,
    overflow: 'hidden'
  },
  // 纵向主轴：标签条固定在上，视图占满剩余高度。
  // 各视图内部已经是 flex:1 + minHeight:0 的写法，换主轴方向不用改它们。
  main: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--bg-0)'
  },
  // 落点提示压在右半边上方。pointerEvents:none 是必须的，
  // 否则这层自己会吃掉 dragover，导致提示一出现就闪烁
  dropHint: {
    position: 'absolute',
    top: 34,
    right: 0,
    bottom: 0,
    width: '40%',
    display: 'grid',
    placeItems: 'center',
    zIndex: 40,
    pointerEvents: 'none',
    background: 'var(--selected-bg)',
    boxShadow: 'inset 1px 0 0 0 var(--accent)',
    color: 'var(--text-1)',
    fontSize: 'var(--fs-sm)'
  }
}
