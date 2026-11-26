import { useSyncExternalStore } from 'react'
import type { DesktopState, Preview, ServiceEvent } from './types'
import { workspaceViews } from './workspaceViewStore'
import { rememberPreview } from './previewMemory'
import { connectionIssue, type ConnectionIssue } from '../../desktop/service/connection-errors.mjs'

const params = new URLSearchParams(window.location.search)
export const isDesktop = params.get('desktop') === '1'
export const surface = params.get('surface') === 'chats' ? 'chats' : 'workspace'
export const clientId = crypto.randomUUID()
let token = params.get('token') || sessionStorage.getItem('mrmak.token') || ''
if (isDesktop && token) {
  sessionStorage.setItem('mrmak.token', token)
  params.delete('token')
  history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`)
}
const listeners = new Set<() => void>()
const events = new Set<(event: ServiceEvent) => void>()
let state: DesktopState = {
  ready: false, connected: false, error: null, repo: '', contentBase: '', projects: [], agents: [], sessions: [], selectedId: null, notices: [],
  settings: { defaultAgent: 'codex', defaultBypass: false, defaultWorkerEffort: 'xhigh' }, coordinator: 'idle', voice: { configured: false, owner: null }, operations: [], preview: null, voiceHistory: [],
}
let socket: WebSocket | null = null
let started = false
let reconnectTimer = 0
const update = (values: Partial<DesktopState>) => { state = { ...state, ...values }; listeners.forEach(listener => listener()) }
export const desktopState = () => state
export const useDesktop = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, desktopState)
export const onServiceEvent = (listener: (event: ServiceEvent) => void) => { events.add(listener); return () => { events.delete(listener) } }
workspaceViews.subscribe(() => {
  const views = workspaceViews.read(), active = views.tabs.find(tab => tab.id === views.active)
  update({ preview: active?.type === 'preview' ? active.file : null, browserSessionId: active?.type === 'browser' ? active.sessionId : null, inspector: active?.type === 'inspector' ? active.selection : null })
})
export const setPreview = (preview: Preview | null, automatic = false) => {
  if (preview) { if (preview.viewState) rememberPreview(`image:${preview.identity || preview.path}`, preview.viewState); workspaceViews.open({ id: `preview:${preview.identity || preview.path}`, title: preview.name, type: 'preview', file: preview }, automatic) }
  else workspaceViews.select(null)
}
export const closeBrowserPanel = () => { const id = workspaceViews.read().active; if (id) workspaceViews.close(id) }
export async function browserUpload(id: string, file: File) {
  const response = await fetch(`/api/browser/${encodeURIComponent(id)}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-File-Name': encodeURIComponent(file.name) }, body: file })
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed'); return result
}
export async function browserDownload(id: string, downloadId: string, name: string) {
  const response = await fetch(`/api/browser/${encodeURIComponent(id)}/download/${encodeURIComponent(downloadId)}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error('This download is no longer available.')
  const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export const dismissError = () => update({ error: null })
export const reportError = (error: unknown) => update({ error: error instanceof Error ? error.message : String(error) })
export const contentUrl = (relative: string) => isDesktop ? `${state.contentBase}${relative}` : relative

export async function api<T>(path: string, data?: unknown, method?: string): Promise<T> {
  let response: Response
  try { response = await fetch(`/api${path}`, {
    method: method || (data === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  }) } catch (cause) { const issue = connectionIssue(cause, { localService: true }); throw Object.assign(new Error(issue.message), { connectionIssue: issue }) }
  const value = await response.json()
  if (!response.ok) throw Object.assign(new Error(value.error || `Request failed (${response.status})`), { connectionIssue: value.connectionIssue as ConnectionIssue | undefined })
  return value as T
}
export async function retryLocalConnection() {
  if (!state.ready) { await startDesktop(); return }
  const initial = await api<DesktopState>('/bootstrap')
  update({ ...initial, ready: true, selectedId: initial.sessions.some(item => item.id === state.selectedId) ? state.selectedId : initial.selectedId, error: null })
  clearTimeout(reconnectTimer)
  connect()
}
export function pickFiles(options: { window?: 'chats' | 'workspace'; folder?: boolean } = {}): Promise<string[]> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.removeEventListener('mrmak-picked-files', picked); window.removeEventListener('pagehide', closed) }
    const picked = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId: string; paths: string[] }>).detail
      if (detail?.requestId !== requestId) return
      cleanup(); resolve(detail.paths)
    }
    const closed = () => { cleanup(); reject(new Error('The file picker window was closed.')) }
    window.addEventListener('mrmak-picked-files', picked)
    window.addEventListener('pagehide', closed)
    api('/files/pick', { requestId, ...options }).catch(error => { cleanup(); reject(error) })
  })
}
export async function uploadImage(file: File, sessionId: string): Promise<{ path: string; name: string }> {
  const response = await fetch('/api/attachments', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'Screenshot.png'), 'X-Session-Id': sessionId }, body: file })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Image could not be saved')
  return value
}
export async function uploadFile(file: File, folder: string): Promise<{ path: string; name: string; renamed: boolean }> {
  const response = await fetch(`/api/files/import?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: file,
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'File could not be copied')
  return value
}
export function sendEvent(value: unknown) {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(value)); return true
}
export function selectChat(id: string) {
  update({ selectedId: id }); sendEvent({ type: 'selected', id })
  localStorage.setItem('mrmak.selectedChat', id)
}
export const windowAction = (window: 'workspace' | 'chats', action = 'show', value?: boolean) => api('/window', { window, action, value }).catch(reportError)

export async function startDesktop() {
  if (started) return
  started = true
  try {
    const initial = await api<DesktopState>('/bootstrap')
    const selected = localStorage.getItem('mrmak.selectedChat')
    if (surface === 'workspace' && !location.hash && initial.settings.workspaceRoute?.startsWith('#/')) history.replaceState(null, '', location.pathname + location.search + initial.settings.workspaceRoute)
    update({ ...initial, ready: true, error: null, selectedId: initial.sessions.some(item => item.id === selected) ? selected : initial.selectedId })
    if (!performance.getEntriesByName('mr-mik:bootstrap-ready').length) performance.mark('mr-mik:bootstrap-ready')
    if (surface === 'workspace') { if (initial.browserSessionId) workspaceViews.open({ id: `browser:${initial.browserSessionId}`, title: 'Browser', type: 'browser', sessionId: initial.browserSessionId }); else if (initial.inspector) workspaceViews.open({ id: `inspector:${initial.inspector.sessionId}:${initial.inspector.itemId}`, title: 'Changes', type: 'inspector', selection: initial.inspector }) }
    connect()
  } catch (error) { started = false; reportError(error) }
}
function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  const currentSocket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/events`)
  socket = currentSocket
  currentSocket.onopen = () => currentSocket.send(JSON.stringify({ type: 'auth', token, clientId, surface }))
  currentSocket.onmessage = ({ data }) => {
    if (socket !== currentSocket) return
    const event = JSON.parse(data) as ServiceEvent
    if (event.type === 'connected') update({ connected: true, sessions: event.sessions || state.sessions, selectedId: event.selectedId ?? state.selectedId, coordinator: event.state || state.coordinator, error: null, ...(surface === 'workspace' && event.browserSessionId && !state.preview && !state.inspector && !state.browserSessionId ? { browserSessionId: event.browserSessionId } : {}) })
    if (event.type === 'connected' && surface === 'workspace' && event.browserSessionId && !workspaceViews.read().active) workspaceViews.open({ id: `browser:${event.browserSessionId}`, title: 'Browser', type: 'browser', sessionId: event.browserSessionId }, !event.userInitiated)
    if (event.type === 'selection') update({ selectedId: event.selectedId || null })
    if (event.type === 'session' && event.session) {
      const next = event.session
      if (!next.open || ['stopped', 'exited'].includes(next.status)) for (const tab of workspaceViews.read().tabs) if (tab.type === 'browser' && tab.sessionId === next.id) workspaceViews.close(tab.id)
      if (state.browserSessionId === next.id && (!next.open || ['stopped', 'exited'].includes(next.status))) update({ browserSessionId: null })
      update({ sessions: state.sessions.some(item => item.id === next.id) ? state.sessions.map(item => item.id === next.id ? next : item) : [...state.sessions, next] })
    }
    if (event.type === 'removed') {
      for (const tab of workspaceViews.read().tabs) if (tab.type === 'browser' && tab.sessionId === event.id || tab.type === 'inspector' && tab.selection.sessionId === event.id) workspaceViews.close(tab.id)
      const sessions = state.sessions.filter(item => item.id !== event.id)
      if (state.browserSessionId === event.id) update({ browserSessionId: null })
      if (state.inspector?.sessionId === event.id) update({ inspector: null })
      update({ sessions, selectedId: state.selectedId === event.id ? sessions[0]?.id || null : state.selectedId })
    }
    if (event.type === 'service-error') reportError(event.error || 'Connection error')
    if (event.type === 'coordinator-state') update({ coordinator: event.state || 'idle' })
    if (event.type === 'coordinator-result' && event.operation) {
      const operation = event.operation
      update({ operations: [...state.operations.filter(item => item.id !== operation.id), operation].slice(-50) })
    }
    if (event.type === 'settings' && event.settings) update({ settings: event.settings })
    if (event.type === 'projects-changed') api<DesktopState['projects']>('/projects').then(projects => update({ projects })).catch(reportError)
    if (event.type === 'notice' && event.notice) update({ notices: [...state.notices, event.notice].slice(-100) })
    if (event.type === 'voice-owner') update({ voice: { ...state.voice, owner: event.owner || null } })
    if (event.type === 'navigate') {
      if (event.sessionId) selectChat(event.sessionId)
      if (surface === 'workspace' && event.window === 'workspace') {
        if (event.browserSessionId) workspaceViews.open({ id: `browser:${event.browserSessionId}`, title: 'Browser', type: 'browser', sessionId: event.browserSessionId }, !event.userInitiated)
        if (event.inspector) workspaceViews.open({ id: `inspector:${event.inspector.sessionId}:${event.inspector.itemId}`, title: 'Changes', type: 'inspector', selection: event.inspector }, !event.userInitiated)
        if (event.route !== undefined) { workspaceViews.select(null, true); location.hash = event.route || '' }
        if (event.preview) setPreview(event.preview, !event.userInitiated)
      }
    }
    if (event.type === 'workspace-changed') window.dispatchEvent(new Event('mrmak-workspace-changed'))
    if (event.type === 'card-content-changed') window.dispatchEvent(new CustomEvent('mrmak-card-content-changed', { detail: event.pages }))
    events.forEach(listener => listener(event))
  }
  currentSocket.onclose = () => {
    if (socket !== currentSocket) return
    update({ connected: false })
    clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(connect, 1500)
    events.forEach(listener => listener({ type: 'disconnected' }))
  }
  currentSocket.onerror = () => currentSocket.close()
}

// Exposing a capability through a DOM attribute would give report pages access to it.
// It lives only in this UI origin, which is separate from the report server.
window.addEventListener('pagehide', () => { token = ''; socket?.close(); clearTimeout(reconnectTimer) })
