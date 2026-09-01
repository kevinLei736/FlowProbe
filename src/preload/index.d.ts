import type { ToolboxApi } from './index'

declare global {
  interface Window {
    toolbox: ToolboxApi
  }
}

export {}
