import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface VirtualListProps<T> {
  /** 数据源，按显示顺序排列 */
  items: T[]
  /** 稳定的行标识，用于缓存已测量的行高 */
  keyOf: (item: T, index: number) => string
  /** 未测量时的预估行高 */
  estimate?: number
  /** 视口上下额外渲染的行数 */
  overscan?: number
  /** 是否黏在底部（新数据自动滚到最新） */
  stickToBottom?: boolean
  /** 滚动容器样式 */
  style?: React.CSSProperties
  /** 每一行外层包裹样式（横向内边距放这里，绝对定位会忽略容器 padding） */
  rowStyle?: React.CSSProperties
  padTop?: number
  padBottom?: number
  /**
   * 滚动后回报视口顶部那一行的下标。
   *
   * 分屏联动需要知道「你现在看到哪一条」，而这个信息只有虚拟列表自己算得出来
   * （行高是实测的，外部无法从 scrollTop 推回下标）。
   */
  onTopIndex?: (index: number) => void
  /**
   * 受控滚动到指定行。token 每次自增触发一次滚动。
   *
   * 为什么不直接用 index 变化触发：跟随侧要滚到的行可能和上次相同（两侧时间接近时），
   * 只看 index 会把这次跟随吞掉。
   */
  scrollTo?: { index: number; token: number } | null
  children: (item: T, index: number) => React.ReactNode
}

/** 在升序数组中找到最后一个 <= value 的下标 */
function lowerBound(offsets: number[], value: number, hi: number): number {
  let lo = 0
  let high = hi
  while (lo < high) {
    const mid = (lo + high) >> 1
    if (offsets[mid + 1] <= value) lo = mid + 1
    else high = mid
  }
  return lo
}

/**
 * 变高虚拟列表：只渲染视口内的行，行高实测后缓存。
 * 十万级数据也只有几十个 DOM 节点，滚动不再随数据量变慢。
 */
export function VirtualList<T>({
  items,
  keyOf,
  estimate = 24,
  overscan = 6,
  stickToBottom = false,
  style,
  rowStyle,
  padTop = 0,
  padBottom = 0,
  onTopIndex,
  scrollTo = null,
  children
}: VirtualListProps<T>): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const cache = useRef<Map<string, number>>(new Map())
  const heights = useRef<number[]>([])
  const offsets = useRef<number[]>([0])
  const keys = useRef<string[]>([])
  const rowEls = useRef<Map<number, HTMLDivElement>>(new Map())
  const scrollTop = useRef(0)
  const atBottom = useRef(true)
  const rafId = useRef<number | null>(null)
  const [tick, setTick] = useState(0)
  const [viewport, setViewport] = useState(600)

  const rebuildOffsets = useCallback((from: number): void => {
    const h = heights.current
    const o = offsets.current
    o.length = h.length + 1
    let acc = from === 0 ? 0 : o[from]
    for (let i = from; i < h.length; i++) {
      acc += h[i]
      o[i + 1] = acc
    }
  }, [])

  // items 变化时同步行高数组：纯追加走增量，其余整表重建（行高从缓存取回，不会跳动）
  useMemo(() => {
    const n = items.length
    const prev = keys.current
    const appendOnly =
      prev.length > 0 &&
      n >= prev.length &&
      keyOf(items[prev.length - 1], prev.length - 1) === prev[prev.length - 1]

    if (appendOnly) {
      const oldLen = prev.length
      for (let i = oldLen; i < n; i++) {
        const k = keyOf(items[i], i)
        prev.push(k)
        heights.current.push(cache.current.get(k) ?? estimate)
      }
      rebuildOffsets(oldLen)
    } else {
      const nextKeys = new Array<string>(n)
      const nextHeights = new Array<number>(n)
      for (let i = 0; i < n; i++) {
        const k = keyOf(items[i], i)
        nextKeys[i] = k
        nextHeights[i] = cache.current.get(k) ?? estimate
      }
      keys.current = nextKeys
      heights.current = nextHeights
      // 缓存过大时按当前可见集合收缩，避免长期运行后无限增长
      if (cache.current.size > n * 3 + 2000) {
        const fresh = new Map<string, number>()
        for (let i = 0; i < n; i++) {
          const v = cache.current.get(nextKeys[i])
          if (v !== undefined) fresh.set(nextKeys[i], v)
        }
        cache.current = fresh
      }
      rebuildOffsets(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, estimate, rebuildOffsets])

  // 直接读现值：行高实测重算偏移后（只 bump tick），总高也要立刻跟上
  const total = offsets.current[items.length] ?? 0

  // 视口高度跟随容器尺寸变化
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    setViewport(el.clientHeight)
    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback((): void => {
    const el = scroller.current
    if (!el) return
    scrollTop.current = el.scrollTop
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (onTopIndex && items.length > 0) {
      onTopIndex(lowerBound(offsets.current, Math.max(0, el.scrollTop - padTop), items.length))
    }
    if (rafId.current !== null) return
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null
      setTick((v) => v + 1)
    })
  }, [onTopIndex, items.length, padTop])

  useEffect(
    () => () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current)
    },
    []
  )

  const start = useMemo(() => {
    if (items.length === 0) return 0
    const idx = lowerBound(offsets.current, Math.max(0, scrollTop.current - padTop), items.length)
    return Math.max(0, idx - overscan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, total, viewport, items.length, overscan, padTop])

  const end = useMemo(() => {
    if (items.length === 0) return 0
    const bottom = scrollTop.current - padTop + viewport
    let i = start
    while (i < items.length && offsets.current[i] < bottom) i++
    return Math.min(items.length, i + overscan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, total, viewport, items.length, start, overscan, padTop])

  // 实测行高，修正后从最早变化的位置重算偏移
  useLayoutEffect(() => {
    let minIdx = Number.POSITIVE_INFINITY
    rowEls.current.forEach((el, i) => {
      const h = el.offsetHeight
      if (h > 0 && Math.abs((heights.current[i] ?? 0) - h) > 0.5) {
        heights.current[i] = h
        const k = keys.current[i]
        if (k) cache.current.set(k, h)
        if (i < minIdx) minIdx = i
      }
    })
    if (minIdx !== Number.POSITIVE_INFINITY) {
      rebuildOffsets(minIdx)
      setTick((v) => v + 1)
    }
  })

  // 黏底：仅在数据增加或总高变化（行高实测修正）后贴到最新，
  // 这样用户主动往上翻时不会被强行拽回底部。
  useLayoutEffect(() => {
    if (!stickToBottom) return
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    scrollTop.current = el.scrollTop
    atBottom.current = true
  }, [stickToBottom, items.length, total])

  // 受控滚动：跟随侧被要求对齐到某一行时执行。
  // 用 useLayoutEffect 而不是 useEffect，避免先画出旧位置再跳一帧。
  useLayoutEffect(() => {
    if (!scrollTo) return
    const el = scroller.current
    if (!el) return
    const i = Math.max(0, Math.min(items.length - 1, scrollTo.index))
    const top = (offsets.current[i] ?? 0) + padTop
    if (Math.abs(el.scrollTop - top) < 2) return
    el.scrollTop = top
    scrollTop.current = el.scrollTop
    setTick((v) => v + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTo?.token])

  const rows: JSX.Element[] = []
  for (let i = start; i < end; i++) {
    const item = items[i]
    if (item === undefined) continue
    rows.push(
      <div
        key={keys.current[i] ?? i}
        ref={(el) => {
          if (el) rowEls.current.set(i, el)
          else rowEls.current.delete(i)
        }}
        style={{ position: 'absolute', top: (offsets.current[i] ?? 0) + padTop, left: 0, right: 0, ...rowStyle }}
      >
        {children(item, i)}
      </div>
    )
  }

  return (
    <div ref={scroller} style={style} onScroll={onScroll}>
      <div style={{ position: 'relative', height: total + padTop + padBottom }}>{rows}</div>
    </div>
  )
}
