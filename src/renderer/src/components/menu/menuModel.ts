/**
 * 系统菜单模型。
 *
 * 这里刻意把「菜单长什么样」做成纯数据：菜单栏组件只负责渲染与键盘导航，
 * 菜单项本身是一组 { label, hint, run, checked, disabled } 描述。
 * 好处是同一份定义可以同时喂给顶部菜单栏和命令面板，
 * 不会出现「菜单里有、Ctrl+K 里没有」的分裂。
 *
 * 划分原则（这是本次重构的核心决定）：
 * - 系统功能 = 与「应用本体」有关的：窗口、视图布局、主题、数据目录、诊断、关于。
 *   它们与当前打开的是哪个会话无关，因此上提到顶部菜单栏。
 * - 模块功能 = 与「某个协议/某个会话」有关的：连接参数、收发、Mock 路由、
 *   断言、协议模板。它们留在左栏 / 中栏 / 右栏的原位，因为操作对象就在眼前。
 */

export interface MenuItem {
  /** 分隔线 */
  sep?: true
  label?: string
  /** 右侧快捷键提示 */
  hint?: string
  run?: () => void
  /** 勾选态（视图开关类） */
  checked?: boolean
  /** 圆点选中态（单选组，如主题、密度） */
  radio?: boolean
  disabled?: boolean
  danger?: boolean
}

export interface MenuGroup {
  id: string
  label: string
  items: MenuItem[]
}

export interface MenuActions {
  // 文件
  newSession: () => void
  duplicateSession: () => void
  importConfig: () => void
  exportConfig: () => void
  revealWorkspace: () => void
  revealHistory: () => void
  quit: () => void
  // 会话
  startSession: () => void
  stopSession: () => void
  restartSession: () => void
  renameSession: () => void
  clearFrames: () => void
  removeSession: () => void
  // 视图
  closeTab: () => void
  closeOtherTabs: () => void
  pinTab: () => void
  toggleSidebar: () => void
  toggleInspector: () => void
  splitRight: () => void
  swapSplit: () => void
  toggleTimeSync: () => void
  toggleCompare: () => void
  openDashboard: () => void
  openHistory: () => void
  openSearch: () => void
  openPalette: () => void
  setTheme: (m: 'system' | 'light' | 'dark') => void
  setDensity: (d: 'compact' | 'default' | 'comfortable') => void
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
  // 工具
  openApi: () => void
  openMonitor: () => void
  openAlerts: () => void
  openMarks: () => void
  openTools: () => void
  // 帮助
  openGuide: () => void
  openUpdate: () => void
  openShortcuts: () => void
  openAbout: () => void
  toggleDevTools: () => void
  relaunch: () => void
}

export interface MenuContext {
  hasSession: boolean
  /** 标签数量与预览态，决定标签相关菜单项是否可用 */
  tabCount: number
  activeIsPreview: boolean
  running: boolean
  sidebarVisible: boolean
  inspectorVisible: boolean
  /** 是否处于分屏。决定「退出分屏 / 左右互换 / 时间轴联动」是否可用 */
  splitOn: boolean
  timeSyncOn: boolean
  comparing: boolean
  theme: 'system' | 'light' | 'dark'
  density: 'compact' | 'default' | 'comfortable'
  /** 巡检失败未读数，用于菜单项上直接提示 */
  monitorUnread: number
  /** 报文告警未读数 */
  alertUnread: number
  /** 已存书签数，直接显示在菜单项上（有没有存过东西一眼可见） */
  markCount: number
  /** 开发者工具是否可用。打包版为 false，「帮助」里不显示该项 */
  devToolsEnabled: boolean
  /** 服务器上有新版本尚未下载 */
  updateAvailable: boolean
  /** 新版本已下载完，只等重启安装 */
  updateReady: boolean
}

export function buildMenus(a: MenuActions, c: MenuContext): MenuGroup[] {
  const sep: MenuItem = { sep: true }
  return [
    {
      id: 'file',
      label: '文件',
      items: [
        { label: '新建连接…', hint: 'Ctrl+N', run: a.newSession },
        { label: '复制当前会话', run: a.duplicateSession, disabled: !c.hasSession },
        sep,
        { label: '导入配置…', run: a.importConfig },
        { label: '导出配置…', run: a.exportConfig },
        sep,
        { label: '打开工作区所在目录', run: a.revealWorkspace },
        { label: '打开历史库所在目录', run: a.revealHistory },
        sep,
        { label: '退出', hint: 'Alt+F4', run: a.quit }
      ]
    },
    {
      id: 'session',
      label: '会话',
      items: [
        { label: '启动连接', run: a.startSession, disabled: !c.hasSession || c.running },
        { label: '断开连接', run: a.stopSession, disabled: !c.hasSession || !c.running },
        { label: '重新连接', run: a.restartSession, disabled: !c.hasSession },
        sep,
        { label: '重命名会话…', run: a.renameSession, disabled: !c.hasSession },
        { label: '清空报文时间轴', run: a.clearFrames, disabled: !c.hasSession },
        sep,
        { label: '删除会话', run: a.removeSession, disabled: !c.hasSession, danger: true }
      ]
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { label: '左侧会话栏', hint: 'Ctrl+B', run: a.toggleSidebar, checked: c.sidebarVisible },
        { label: '右侧检查器', hint: 'Ctrl+J', run: a.toggleInspector, checked: c.inspectorVisible },
        sep,
        {
          label: c.splitOn ? '退出分屏' : '在右侧并排打开',
          hint: 'Ctrl+\\',
          run: a.splitRight,
          checked: c.splitOn,
          disabled: !c.splitOn && c.tabCount < 2
        },
        { label: '左右互换', run: a.swapSplit, disabled: !c.splitOn },
        { label: '时间轴联动', run: a.toggleTimeSync, checked: c.timeSyncOn, disabled: !c.splitOn },
        { label: '报文对比', hint: 'Ctrl+Shift+D', run: a.toggleCompare, checked: c.comparing },
        sep,
        { label: '固定当前标签', run: a.pinTab, disabled: !c.activeIsPreview },
        { label: '关闭当前标签', hint: 'Ctrl+W', run: a.closeTab, disabled: c.tabCount === 0 },
        { label: '关闭其他标签', run: a.closeOtherTabs, disabled: c.tabCount < 2 },
        sep,
        { label: '数据看板', hint: 'Ctrl+D', run: a.openDashboard },
        { label: '报文历史', hint: 'Ctrl+H', run: a.openHistory },
        { label: '全局搜索', hint: 'Ctrl+F', run: a.openSearch },
        { label: '命令面板', hint: 'Ctrl+K', run: a.openPalette },
        sep,
        { label: '主题 · 跟随系统', run: () => a.setTheme('system'), radio: c.theme === 'system' },
        { label: '主题 · 浅色', run: () => a.setTheme('light'), radio: c.theme === 'light' },
        { label: '主题 · 深色', run: () => a.setTheme('dark'), radio: c.theme === 'dark' },
        sep,
        { label: '密度 · 紧凑', run: () => a.setDensity('compact'), radio: c.density === 'compact' },
        { label: '密度 · 标准', run: () => a.setDensity('default'), radio: c.density === 'default' },
        {
          label: '密度 · 宽松',
          run: () => a.setDensity('comfortable'),
          radio: c.density === 'comfortable'
        },
        sep,
        { label: '放大界面', hint: 'Ctrl+=', run: a.zoomIn },
        { label: '缩小界面', hint: 'Ctrl+-', run: a.zoomOut },
        { label: '恢复默认缩放', hint: 'Ctrl+0', run: a.zoomReset }
      ]
    },
    {
      id: 'tools',
      label: '工具',
      items: [
        { label: 'HTTP 接口测试', run: a.openApi },
        {
          label: c.monitorUnread > 0 ? '接口巡检（' + c.monitorUnread + ' 次失败）' : '接口巡检',
          run: a.openMonitor
        },
        {
          label: c.alertUnread > 0 ? '告警中心（' + c.alertUnread + ' 条未读）' : '告警中心',
          run: a.openAlerts
        },
        {
          label: c.markCount > 0 ? '报文标注与书签（' + c.markCount + '）' : '报文标注与书签',
          hint: 'Ctrl+M',
          run: a.openMarks
        },
        { label: '编解码工具箱', run: a.openTools },
        sep,
        { label: '全局搜索历史', hint: 'Ctrl+F', run: a.openSearch },
        { label: '报文历史浏览器', hint: 'Ctrl+H', run: a.openHistory }
      ]
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        // 使用文档放帮助菜单第一项：不熟悉的人第一次点开「帮助」，要找的就是它
        { label: '使用文档', hint: 'F1', run: a.openGuide },
        { label: '快捷键一览', hint: 'Ctrl+/', run: a.openShortcuts },
        { label: '关于 FlowProbe', run: a.openAbout },
        sep,
        // 更新入口带上「有新版本」提示：菜单收着的时候用户不会主动来看，
        // 只有把结论摊在菜单项上才有人点
        {
          label: c.updateReady ? '有新版本可安装…' : c.updateAvailable ? '有新版本…' : '检查更新…',
          run: a.openUpdate
        },
        sep,
        // 开发者工具只在开发运行里出现。用扩展展开而不是 disabled：
        // 一个永远点不动的灰项对使用者没有信息量，只会让人反复去点
        ...(c.devToolsEnabled
          ? [{ label: '开发者工具', hint: 'F12', run: a.toggleDevTools } as MenuItem]
          : []),
        { label: '重启应用', run: a.relaunch }
      ]
    }
  ]
}
