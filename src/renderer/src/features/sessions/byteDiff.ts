/**
 * 字节级差异对齐。
 *
 * 为什么不逐位置直接比：报文差异常常是「中间多了一个字段」这种插入/删除，
 * 逐位置比会导致插入点之后**全部**标红，看不出真正改了什么。
 * 所以要做序列对齐（LCS），把差异归结为「相同 / 替换 / 仅左有 / 仅右有」四种。
 *
 * 为什么限制长度：LCS 是 O(n·m) 的动态规划，两条 4KB 报文就是 1600 万格。
 * 报文调试里真正需要精细对齐的都是几十到几百字节的控制帧，
 * 超过阈值时退化为逐位置比较（同样能看出改了哪个字节，只是插入会造成后移错位），
 * 并在界面上明确标注，让人知道看到的是降级结果而不是真相。
 */

/** 对齐阈值：两侧长度乘积超过它就走降级路径 */
const LCS_BUDGET = 1_500_000

export type OpKind = 'same' | 'replace' | 'left-only' | 'right-only'

export interface DiffCell {
  kind: OpKind
  /** 左侧字节，left-only / same / replace 时有值 */
  left?: number
  /** 右侧字节，right-only / same / replace 时有值 */
  right?: number
  /** 在各自序列里的下标，用于显示偏移 */
  leftIndex?: number
  rightIndex?: number
}

export interface DiffResult {
  cells: DiffCell[]
  sameCount: number
  replaceCount: number
  leftOnlyCount: number
  rightOnlyCount: number
  /** true 表示走了降级的逐位置比较 */
  degraded: boolean
}

/** 逐位置比较：长报文的降级路径 */
function positional(a: Uint8Array, b: Uint8Array): DiffResult {
  const cells: DiffCell[] = []
  let same = 0
  let rep = 0
  let lo = 0
  let ro = 0
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const hasL = i < a.length
    const hasR = i < b.length
    if (hasL && hasR) {
      const eq = a[i] === b[i]
      cells.push({ kind: eq ? 'same' : 'replace', left: a[i], right: b[i], leftIndex: i, rightIndex: i })
      if (eq) same++
      else rep++
    } else if (hasL) {
      cells.push({ kind: 'left-only', left: a[i], leftIndex: i })
      lo++
    } else {
      cells.push({ kind: 'right-only', right: b[i], rightIndex: i })
      ro++
    }
  }
  return { cells, sameCount: same, replaceCount: rep, leftOnlyCount: lo, rightOnlyCount: ro, degraded: true }
}

/**
 * 按字节对齐两条报文。
 *
 * 实现用的是标准 LCS 表 + 回溯。相邻的「仅左有 + 仅右有」会合并成一个
 * replace 单元格，因为「这个字节从 A 变成 B」比「删了 A 又插了 B」更贴近人的理解。
 */
export function diffBytes(a: Uint8Array, b: Uint8Array): DiffResult {
  if (a.length * b.length > LCS_BUDGET) return positional(a, b)

  const n = a.length
  const m = b.length
  // (n+1)×(m+1) 的表用一维数组存，避免上万个小数组的分配开销
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }

  const raw: DiffCell[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'same', left: a[i], right: b[j], leftIndex: i, rightIndex: j })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      raw.push({ kind: 'left-only', left: a[i], leftIndex: i })
      i++
    } else {
      raw.push({ kind: 'right-only', right: b[j], rightIndex: j })
      j++
    }
  }
  while (i < n) {
    raw.push({ kind: 'left-only', left: a[i], leftIndex: i })
    i++
  }
  while (j < m) {
    raw.push({ kind: 'right-only', right: b[j], rightIndex: j })
    j++
  }

  // 合并相邻的 left-only / right-only 成 replace
  const cells: DiffCell[] = []
  for (let k = 0; k < raw.length; k++) {
    const cur = raw[k]
    const nxt = raw[k + 1]
    if (
      nxt &&
      ((cur.kind === 'left-only' && nxt.kind === 'right-only') ||
        (cur.kind === 'right-only' && nxt.kind === 'left-only'))
    ) {
      const l = cur.kind === 'left-only' ? cur : nxt
      const r = cur.kind === 'right-only' ? cur : nxt
      cells.push({
        kind: 'replace',
        left: l.left,
        right: r.right,
        leftIndex: l.leftIndex,
        rightIndex: r.rightIndex
      })
      k++
      continue
    }
    cells.push(cur)
  }

  let same = 0
  let rep = 0
  let lo = 0
  let ro = 0
  for (const c of cells) {
    if (c.kind === 'same') same++
    else if (c.kind === 'replace') rep++
    else if (c.kind === 'left-only') lo++
    else ro++
  }
  return { cells, sameCount: same, replaceCount: rep, leftOnlyCount: lo, rightOnlyCount: ro, degraded: false }
}

/** 字节渲染成两位大写 HEX */
export function hex(b: number | undefined): string {
  return b === undefined ? '··' : b.toString(16).toUpperCase().padStart(2, '0')
}

/** 字节渲染成可打印 ASCII，不可打印用 · 代替（等宽对齐用） */
export function ascii(b: number | undefined): string {
  if (b === undefined) return '·'
  return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'
}
