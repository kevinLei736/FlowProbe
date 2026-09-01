import type { SessionConfig } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import { useSnippets } from '../../store/useSnippets'

/**
 * 配置导入导出。
 *
 * 原来这两个动作长在左栏按钮上，属于「系统功能」被塞进模块区的典型例子。
 * 抽成独立模块后，顶部菜单栏与命令面板可以共用同一份实现，
 * 也避免左栏组件里夹着一段与会话列表无关的文件 IO 逻辑。
 */

export function exportConfig(): void {
  const { sessions } = useStore.getState()
  const { snippets } = useSnippets.getState()
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: sessions.map((s) => ({
      kind: s.kind,
      name: s.name,
      config: s.config,
      autoStart: s.autoStart === true,
      group: s.group ?? '',
      tags: s.tags ?? []
    })),
    snippets
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `toolbox-config-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** 返回导入的会话数量，失败返回 -1，便于调用方给出提示而不是静默无反应 */
export async function importConfigFromText(text: string): Promise<number> {
  try {
    const data = JSON.parse(text)
    const create = useStore.getState().createSession
    let n = 0
    if (Array.isArray(data.sessions)) {
      for (const s of data.sessions) {
        if (s.kind && s.config) {
          await create(s.kind, s.name ?? '导入会话', s.config as SessionConfig, s.autoStart === true, {
            group: typeof s.group === 'string' ? s.group : '',
            tags: Array.isArray(s.tags) ? s.tags.map(String) : []
          })
          n++
        }
      }
    }
    if (Array.isArray(data.snippets)) useSnippets.getState().load(data.snippets)
    return n
  } catch {
    return -1
  }
}

/** 通过主进程的打开对话框选文件并导入（菜单入口用，无需隐藏的 file input） */
export async function importConfigViaDialog(): Promise<number> {
  const picked = await window.toolbox.openTextFile('导入配置', ['json'])
  if (!picked) return 0
  return importConfigFromText(picked.content)
}
