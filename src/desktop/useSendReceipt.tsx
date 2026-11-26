import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { GraphicalItem } from './GraphicalTimeline'

type Receipt = { id: string; runtimeId: string; text: string; previous: Set<string>; failed?: boolean }
// Delivery outlives a mounted view. Keep the recovery text with its session,
// including across page reloads; never replay a retained message automatically.
const stores = new Map<string, ReturnType<typeof createReceipts>>()
function createReceipts(sessionId: string) {
  const key = `mrmak.chat-outgoing.${sessionId}`
  let receipts: Receipt[] = []
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    if (Array.isArray(saved) && saved.length <= 1000) receipts = saved.flatMap(row =>
      row && typeof row.id === 'string' && typeof row.runtimeId === 'string' && typeof row.text === 'string' && row.text.length <= 64000 && Array.isArray(row.previous) && row.previous.every((id: unknown) => typeof id === 'string')
        ? [{ ...row, previous: new Set<string>(row.previous) }] : [])
  } catch { /* Browser storage is optional; in-memory recovery remains available. */ }
  const listeners = new Set<() => void>()
  const store = {
    read: () => receipts,
    subscribe: (listener: () => void) => {
      stores.set(sessionId, store); listeners.add(listener)
      return () => { listeners.delete(listener); if (!listeners.size && !receipts.length && stores.get(sessionId) === store) stores.delete(sessionId) }
    },
    update: (change: (previous: Receipt[]) => Receipt[]) => {
      receipts = change(receipts)
      try {
        if (receipts.length) localStorage.setItem(key, JSON.stringify(receipts.map(row => ({ ...row, previous: [...row.previous] }))))
        else localStorage.removeItem(key)
      } catch { /* A full browser cache must not break delivery or editing. */ }
      for (const listener of listeners) listener()
      if (!listeners.size && !receipts.length && stores.get(sessionId) === store) stores.delete(sessionId)
    },
  }
  return store
}
export default function useSendReceipt(sessionId: string, items: GraphicalItem[], runtimeId?: string) {
  const store = useMemo(() => stores.get(sessionId) || createReceipts(sessionId), [sessionId])
  const receipts = useSyncExternalStore(store.subscribe, store.read)
  const echoed = useCallback((receipt: Receipt) => items.some(item => !receipt.previous.has(item.id) && item.type === 'userMessage' && (receipt.text.trim() ? item.text.includes(receipt.text) : true)), [items])
  const visible = receipts.filter(receipt => !echoed(receipt))
  useEffect(() => {
    if (!runtimeId) return
    const settled = new Set(receipts.filter(echoed).map(receipt => receipt.id))
    if (!settled.size) return
    const frame = requestAnimationFrame(() => store.update(previous => previous.filter(receipt => !settled.has(receipt.id))))
    return () => cancelAnimationFrame(frame)
  }, [echoed, receipts, runtimeId, store])
  const begin = (text: string) => {
    const id = crypto.randomUUID()
    store.update(previous => [...previous, { id, runtimeId: runtimeId || '', text, previous: new Set(items.map(item => item.id)) }])
    return id
  }
  const failed = (id: string, keep: boolean) => store.update(previous => keep ? previous.map(receipt => receipt.id === id ? { ...receipt, failed: true } : receipt) : previous.filter(receipt => receipt.id !== id))
  const receipt = <>{visible.map(value => <article key={value.id} className="graphical-message userMessage graphical-send-receipt" aria-label={value.failed ? 'Message not sent' : 'Your message'} data-local-message><p>{value.text || 'Attached context'}</p>{value.failed && <small role="status">Message not sent. The original text is preserved here.</small>}</article>)}</>
  return { begin, failed, receipt }
}
