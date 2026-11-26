import type { Preview } from './types'
export type WorkspaceView = { id: string; title: string; pinned?: boolean; pending?: boolean; visited?: number } & ({ type: 'preview'; file: Preview } | { type: 'browser'; sessionId: string } | { type: 'inspector'; selection: { sessionId: string; itemId: string } })
export function createWorkspaceViews() {
  let state: { tabs: WorkspaceView[]; active: string | null; history: (string | null)[]; position: number } = { tabs: [], active: null, history: [null], position: 0 }
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach(listener => listener())
  const select = (id: string | null, automatic = false) => {
    if (id && !state.tabs.some(tab => tab.id === id)) return
    if (automatic && state.tabs.find(tab => tab.id === state.active)?.pinned && id !== state.active) return
    const tabs = state.tabs.map(tab => tab.id === id ? { ...tab, pending: false, visited: Date.now() } : tab)
    if (id === state.active) { state = { ...state, tabs }; emit(); return }
    const history = [...state.history.slice(0, state.position + 1), id].slice(-50)
    state = { ...state, tabs, active: id, history, position: history.length - 1 }; emit()
  }
  return {
    read: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    select,
    open: (tab: WorkspaceView, automatic = false) => {
      const existing = state.tabs.find(value => value.id === tab.id)
      let tabs = existing ? state.tabs.map(value => value.id === tab.id ? { ...tab, visited: value.visited, pinned: value.pinned, pending: automatic && state.active !== tab.id } : value) : [...state.tabs, { ...tab, pending: automatic }]
      if (tabs.length > 10) { const oldest = tabs.find(value => !value.pinned && value.id !== state.active && value.id !== tab.id); if (oldest) tabs = tabs.filter(value => value.id !== oldest.id) }
      state = { ...state, tabs }; select(tab.id, automatic); emit()
    },
    close: (id: string) => {
      const index = state.tabs.findIndex(tab => tab.id === id), tabs = state.tabs.filter(tab => tab.id !== id)
      state = { ...state, tabs, history: state.history.map(value => value === id ? null : value) }
      if (state.active === id) select(tabs[Math.min(index, tabs.length - 1)]?.id || null)
      emit()
    },
    pin: (id: string) => { if (!state.tabs.find(tab => tab.id === id)?.pinned && state.tabs.filter(tab => tab.pinned).length >= 5) return; state = { ...state, tabs: state.tabs.map(tab => tab.id === id ? { ...tab, pinned: !tab.pinned } : tab) }; emit() },
    move: (direction: number) => {
      const position = Math.min(state.history.length - 1, Math.max(0, state.position + direction)), id = state.history[position]
      state = { ...state, position, active: state.tabs.some(tab => tab.id === id) ? id : null, tabs: state.tabs.map(tab => tab.id === id ? { ...tab, pending: false, visited: Date.now() } : tab) }; emit()
    },
  }
}
export const workspaceViews = createWorkspaceViews()
