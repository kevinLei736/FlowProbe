/**
 * 应用 Logo：三条数据流线，中间一条在探针处被截断。
 *
 * 为什么是这个形状：产品做的事就是「在链路中间截下一帧看清楚」——
 * 上下两条弱化的线代表持续流动的报文，中间那条被断开、缺口处落一个环形探针点，
 * 正好对应 FlowProbe 这个名字。
 *
 * 为什么不用曲线或渐变：这个组件最小要在 20px 的标题栏里渲染，
 * 曲线与渐变在这个尺寸会糊成一坨灰。粗直线 + 一个实心环在小尺寸下依然认得出。
 *
 * 为什么用 var(--accent) 而不是写死颜色：主题的强调色是无彩色（深色近白、浅色近黑），
 * 写死任何色相都会在另一套主题下显得突兀。
 */
export function Logo({ size = 24 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="FlowProbe"
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="var(--accent)" opacity="0.12" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="var(--accent)" strokeWidth="1.3" opacity="0.42" />
      {/* 上下两条：持续流动的报文，弱化处理以突出中间的探针 */}
      <g stroke="var(--accent)" strokeWidth="2.9" strokeLinecap="round">
        <path d="M8 10.5 H24" opacity="0.42" />
        <path d="M8 16 H13" />
        <path d="M8 21.5 H19" opacity="0.42" />
      </g>
      {/* 探针：环形而非实心，缺口才看得出是「截断」 */}
      <circle cx="18.7" cy="16" r="3.7" fill="var(--accent)" />
      <circle cx="18.7" cy="16" r="1.35" fill="var(--bg-1)" />
    </svg>
  )
}
