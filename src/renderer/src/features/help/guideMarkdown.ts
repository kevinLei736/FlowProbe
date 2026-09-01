import { GUIDE_SECTIONS, type GuideBlock } from './guideContent'

/**
 * 把结构化正文渲染成 Markdown。
 *
 * 两个消费方：面板里的「导出 Markdown」按钮，以及 npm run docs:guide
 * 生成的 docs\\使用文档.md。共用一份渲染逻辑，文档不会出现
 * 「界面上写的和仓库里的不一样」这种最难发现的偏差。
 */
function renderBlock(b: GuideBlock): string[] {
  switch (b.t) {
    case 'h':
      return ['### ' + b.text, '']
    case 'p':
      return [b.text, '']
    case 'note':
      // 用引用块表达提示条：Markdown 没有原生 callout，> 是各处渲染器都认的写法
      return ['> **提示** ' + b.text, '']
    case 'code':
      return ['```', b.text, '```', '']
    case 'bullets':
      return [...b.items.map((x) => '- ' + x), '']
    case 'steps':
      return [...b.items.map((x, i) => i + 1 + '. ' + x), '']
    case 'table': {
      const rows = [
        '| ' + b.head.join(' | ') + ' |',
        '|' + b.head.map(() => '---').join('|') + '|',
        ...b.rows.map((r) => '| ' + r.join(' | ') + ' |')
      ]
      return [...rows, '']
    }
  }
}

export function guideToMarkdown(): string {
  const out: string[] = ['# FlowProbe 使用文档', '']
  out.push('本文件由应用内「帮助 → 使用文档」的同一份内容生成，两处永远一致。', '')
  // 目录放在最前：手册是查阅式读物，先给全貌再给细节
  out.push('## 目录', '')
  for (const s of GUIDE_SECTIONS) {
    out.push('- **' + s.title + '** — ' + s.summary)
  }
  out.push('')
  for (const s of GUIDE_SECTIONS) {
    out.push('---', '')
    out.push('## ' + s.title, '')
    out.push(s.summary, '')
    for (const b of s.blocks) out.push(...renderBlock(b))
  }
  return out.join('\n')
}
