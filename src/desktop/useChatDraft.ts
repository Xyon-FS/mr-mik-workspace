import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from './client'

export function createChatDraft(initial: string) {
  let value = initial
  let version = 0
  const listeners = new Set<() => void>()
  return {
    read: () => value,
    empty: () => !value.trim(),
    version: () => version,
    touch: () => { version++ },
    set: (next: string) => { if (next === value) return; value = next; version++; for (const listener of listeners) listener() },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
export type ChatDraft = ReturnType<typeof createChatDraft>
export function savedChatDraft(id: string) {
  try { return localStorage.getItem(`mrmak.chat-draft.${id}`) || '' } catch { return '' }
}
const entries = new Map<string, ReturnType<typeof sessionDraft>>()
function sessionDraft(id: string) {
  const draft = createChatDraft(savedChatDraft(id))
  let views = 0, pending = 0, ready = false, timer = 0
  const retainedVersions = new Map<number, number>()
  let unsubscribe: (() => void) | undefined
  const persist = () => {
    // Native acceptance consumes this exact submitted draft. Until delivery
    // settles, do not resurrect it through a delayed autosave or remount. Newer
    // edits have a different version and continue to save normally.
    if (ready && !retainedVersions.has(draft.version())) void api(`/sessions/${id}/chat`, { action: 'draft', text: draft.read() }).catch(() => {})
  }
  const save = () => {
    try { localStorage.setItem(`mrmak.chat-draft.${id}`, draft.read()) } catch {
      try { localStorage.removeItem(`mrmak.chat-draft.${id}`) } catch { /* Browser cache may be unavailable. */ }
    }
    clearTimeout(timer)
    if (ready) timer = window.setTimeout(persist, 300)
  }
  const attach = () => {
    entries.set(id, entry)
    unsubscribe ||= draft.subscribe(save)
  }
  const dispose = () => {
    if (views || pending) return
    clearTimeout(timer); persist(); unsubscribe?.(); unsubscribe = undefined
    if (entries.get(id) === entry) entries.delete(id)
  }
  const entry = {
    draft,
    hasPending: () => pending > 0,
    configure: (value: boolean) => { ready = value; save() },
    mount: () => { views++; attach(); return () => { views--; dispose() } },
    retain: () => {
      const version = draft.version()
      retainedVersions.set(version, (retainedVersions.get(version) || 0) + 1)
      pending++; attach(); let released = false
      return () => {
        if (released) return
        released = true; pending--
        const count = retainedVersions.get(version)! - 1
        if (count) retainedVersions.set(version, count)
        else retainedVersions.delete(version)
        dispose()
      }
    },
  }
  return entry
}

// The shell observes empty/nonempty changes; only DraftInput observes each
// character. Native delivery handlers read the current value at invocation.
export default function useChatDraft(id: string, ready: boolean, runtimeId?: string) {
  const [entry] = useState(() => entries.get(id) || sessionDraft(id))
  const draft = entry.draft
  const empty = useSyncExternalStore(draft.subscribe, draft.empty)
  useEffect(() => entry.mount(), [entry])
  useEffect(() => entry.configure(ready), [entry, ready, runtimeId])
  return { draft, empty, readText: draft.read, setText: draft.set, retainDraft: entry.retain, hasPending: entry.hasPending }
}
