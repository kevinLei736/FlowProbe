import { create } from 'zustand'
import type { Encoding, Terminator } from '@shared/protocol'

export interface Snippet {
  id: string
  name: string
  encoding: Encoding
  content: string
  appendTerminator: Terminator
}

interface SnippetState {
  snippets: Snippet[]
  add: (s: Omit<Snippet, 'id'>) => void
  update: (id: string, patch: Partial<Snippet>) => void
  remove: (id: string) => void
  load: (list: Snippet[]) => void
}

const KEY = 'toolbox.snippets'

function persist(list: Snippet[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // ignore
  }
}

function restore(): Snippet[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Snippet[]
  } catch {
    // ignore
  }
  return [
    { id: 'demo-ping', name: 'PING', encoding: 'utf8', content: 'PING', appendTerminator: 'crlf' },
    { id: 'demo-hex', name: '复位帧', encoding: 'hex', content: 'AA 01 00 55', appendTerminator: '' }
  ]
}

export const useSnippets = create<SnippetState>((set, get) => ({
  snippets: restore(),
  add: (s) => {
    const list = [...get().snippets, { ...s, id: Math.random().toString(36).slice(2) }]
    persist(list)
    set({ snippets: list })
  },
  update: (id, patch) => {
    const list = get().snippets.map((x) => (x.id === id ? { ...x, ...patch } : x))
    persist(list)
    set({ snippets: list })
  },
  remove: (id) => {
    const list = get().snippets.filter((x) => x.id !== id)
    persist(list)
    set({ snippets: list })
  },
  load: (list) => {
    persist(list)
    set({ snippets: list })
  }
}))
