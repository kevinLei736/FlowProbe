/**
 * 控件样式原语。
 *
 * 项目里的控件样式原本散在 19 个文件、各自的 `styles` 映射里手写
 * （统计过：121 个 input、40 个 select、150 个 button），
 * 同一个输入框在不同面板里 padding 差 1px、圆角差 2px 的情况到处都是。
 *
 * 这里把「一个控件长什么样」收敛成可复用的对象，各面板 `styles` 映射
 * 直接展开使用（`{ ...field, width: 120 }`），既保留内联样式的灵活度，
 * 又让尺寸、圆角、色彩有唯一来源。所有值都引用 CSS 变量，
 * 换主题与切换界面密度不需要动 TS。
 */
import type { CSSProperties } from 'react'

/* ——— 文本类输入 ——— */

export const field: CSSProperties = {
  height: 'var(--control-h)',
  padding: '0 var(--control-px)',
  background: 'var(--field-bg)',
  color: 'var(--field-fg)',
  border: '1px solid var(--field-border)',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-md)',
  minWidth: 0,
  outline: 'none'
}

export const fieldSm: CSSProperties = {
  ...field,
  height: 'var(--control-h-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-sm)'
}

/** 报文/JSON/脚本等等宽内容的输入 */
export const fieldMono: CSSProperties = {
  ...field,
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums'
}

export const textarea: CSSProperties = {
  ...field,
  height: 'auto',
  padding: '8px var(--control-px)',
  lineHeight: 'var(--lh-normal)',
  fontFamily: 'var(--font-mono)',
  resize: 'vertical'
}

/*
 * 原生 <select> 的样式原语（select / selectSm）已删除。
 *
 * 为什么删掉而不是留着：原生下拉的候选列表由操作系统绘制，CSS 管不到圆角、
 * 阴影、行高与选中标记，深色主题下 Windows 还会额外描一圈系统边框，跟应用
 * 其余浮层完全不是一套；而且它在 overflow:auto 的面板里会被裁切。留着原语
 * 等于给后来者一条「看起来合规」的错误路径，所以直接移除，统一改用
 * components/ui/Select.tsx 的自绘下拉框。
 */

/* ——— 按钮 ——— */

const btnBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 'var(--control-h)',
  padding: '0 14px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid transparent',
  fontSize: 'var(--fs-sm)',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  userSelect: 'none'
}

/** 主操作：浅底深字（深色主题）/ 深底白字（浅色主题） */
export const btnPrimary: CSSProperties = {
  ...btnBase,
  background: 'var(--btn-bg)',
  color: 'var(--btn-fg)'
}

/**
 * 次级操作：淡色叠加填充、无描边。
 * 之所以不给边框：深色主题下密集排列的描边按钮会连成一片「白色网格」，
 * 这是之前反复被指出的观感问题。用极淡的填充区分层级，与主流桌面工具的层级处理一致。
 */
export const btnSecondary: CSSProperties = {
  ...btnBase,
  background: 'var(--btn2-bg)',
  color: 'var(--btn2-fg)'
}

/**
 * 柔和主操作：常驻入口（左栏「新建连接」、空态主按钮）。
 *
 * 为什么不用 btnPrimary：主按钮是主题里对比度最高的元素，适合「确认 / 提交」
 * 这类一次性动作。常驻在侧栏的入口如果也用最高对比，会一直抢注意力；浅色主题下
 * 深底白字的按钮压在浅灰侧栏上、紧邻右侧白色内容区，割裂感尤其明显。
 * 这里改成浮起的实底卡片，层级仍高于次级按钮，但不喧哗。
 */
export const btnQuiet: CSSProperties = {
  ...btnBase,
  background: 'var(--btnq-bg)',
  color: 'var(--text-0)',
  border: '1px solid var(--btnq-border)',
  boxShadow: 'var(--shadow-sm)'
}

/** 三级操作：完全透明，仅 hover 时浮出底色 */
export const btnGhost: CSSProperties = {
  ...btnBase,
  background: 'transparent',
  color: 'var(--text-1)'
}

/** 危险操作：文字与描边染色，底色保持中性，避免大面积红块 */
export const btnDanger: CSSProperties = {
  ...btnBase,
  background: 'transparent',
  color: 'var(--error)',
  border: '1px solid color-mix(in srgb, var(--error) 45%, transparent)'
}

export const btnSm: CSSProperties = {
  height: 'var(--control-h-sm)',
  padding: '0 10px',
  fontSize: 'var(--fs-xs)'
}

/** 纯图标按钮：正方形，图标居中 */
export const iconBtn: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 'var(--control-h)',
  height: 'var(--control-h)',
  padding: 0,
  background: 'transparent',
  color: 'var(--text-1)',
  border: 'none',
  borderRadius: 'var(--r-sm)',
  fontSize: 13
}

export const iconBtnSm: CSSProperties = {
  ...iconBtn,
  width: 'var(--control-h-sm)',
  height: 'var(--control-h-sm)',
  fontSize: 11
}

/* ——— 分段控件（替代一排互斥按钮）——— */

export const segment: CSSProperties = {
  display: 'inline-flex',
  padding: 2,
  gap: 2,
  background: 'var(--bg-inset)',
  borderRadius: 'var(--r-md)'
}

export const segmentItem: CSSProperties = {
  height: 'calc(var(--control-h) - 6px)',
  padding: '0 10px',
  background: 'transparent',
  color: 'var(--text-2)',
  border: 'none',
  borderRadius: 'var(--r-xs)',
  fontSize: 'var(--fs-sm)',
  fontWeight: 500,
  whiteSpace: 'nowrap'
}

/** 选中态用实底浮起 + 轻投影，比换文字色更容易一眼定位 */
export const segmentItemOn: CSSProperties = {
  background: 'var(--bg-2)',
  color: 'var(--text-0)',
  boxShadow: 'var(--shadow-sm)'
}

/* ——— 标签 / 徽标 ——— */

export const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 22,
  padding: '0 8px',
  background: 'var(--btn2-bg)',
  color: 'var(--text-1)',
  border: 'none',
  borderRadius: 'var(--r-pill)',
  fontSize: 'var(--fs-xs)'
}

export const chipOn: CSSProperties = {
  background: 'var(--selected-bg)',
  color: 'var(--text-0)'
}

export const badge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 16,
  padding: '0 5px',
  background: 'var(--bg-inset)',
  color: 'var(--text-2)',
  borderRadius: 'var(--r-xs)',
  fontSize: 'var(--fs-micro)',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums'
}

/* ——— 容器 ——— */

/** 浮层卡片：弹窗、下拉菜单、搜索层共用 */
export const surface: CSSProperties = {
  background: 'var(--bg-1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--shadow-lg)'
}

export const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--overlay)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 60
}

/** 工具条：面板顶部一行控件的容器 */
export const toolbar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  flexWrap: 'wrap'
}

/** 区块标题：小号、字距略开、弱色 */
export const sectionTitle: CSSProperties = {
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  letterSpacing: 0.5,
  color: 'var(--text-2)',
  textTransform: 'uppercase'
}

export const label: CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-2)'
}

/** 快捷键提示 */
export const kbd: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-micro)',
  color: 'var(--text-2)',
  background: 'var(--bg-inset)',
  borderRadius: 3,
  padding: '2px 5px',
  lineHeight: 1
}

/** 复选框一行：勾选框 + 文案，整行可点 */
export const checkRow: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-1)',
  cursor: 'pointer',
  userSelect: 'none'
}

/** 等宽数字文本，用于统计值 */
export const numeric: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums'
}
