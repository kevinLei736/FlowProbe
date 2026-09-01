import { create } from 'zustand'

export type ThemeMode = 'system' | 'light' | 'dark'
const LS_KEY = 'toolbox.theme'

function systemPrefersDark(): boolean {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

function apply(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', resolve(mode))
}

interface State {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  init: () => void
  setMode: (mode: ThemeMode) => void
}

export const useTheme = create<State>((set, get) => ({
  mode: 'system',
  resolved: 'dark',

  init: () => {
    let mode: ThemeMode = 'system'
    try {
      const saved = localStorage.getItem(LS_KEY) as ThemeMode | null
      if (saved === 'system' || saved === 'light' || saved === 'dark') mode = saved
    } catch {
      // ignore
    }
    apply(mode)
    set({ mode, resolved: resolve(mode) })

    // 跟随系统时监听系统主题变化
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = (): void => {
        if (get().mode === 'system') {
          apply('system')
          set({ resolved: resolve('system') })
        }
      }
      mq.addEventListener('change', listener)
    }
  },

  setMode: (mode) => {
    try {
      localStorage.setItem(LS_KEY, mode)
    } catch {
      // ignore
    }
    apply(mode)
    set({ mode, resolved: resolve(mode) })
  }
}))