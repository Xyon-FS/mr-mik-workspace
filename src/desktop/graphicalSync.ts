import { api } from './client'
type Row = { id: string }
type Base = { runtimeId: string; revision: number; items: Row[]; turns?: Row[] }
type Patch = { upsert: Row[]; removed: string[]; order: string[] }
function apply(before: Row[], patch: Patch) {
  const map = new Map(before.map(item => [item.id, item]))
  for (const id of patch.removed) map.delete(id)
  for (const item of patch.upsert) map.set(item.id, item)
  const next = patch.order.map(id => map.get(id))
  if (next.some(item => !item)) throw new Error('Incomplete chat update')
  return next.every((item, index) => item === before[index]) && next.length === before.length ? before : next as Row[]
}
export function createGraphicalReader<T extends Base>(id: string) {
  let current: T | null = null, issued = 0, applied = 0
  return async () => {
    const request = ++issued, base = current
    const result = await api<{ mode: string; snapshot: T; baseRevision: number; items: Patch; turns: Patch }>(`/sessions/${id}/chat?since=${base?.revision ?? -1}&runtimeId=${encodeURIComponent(base?.runtimeId || '')}`)
    if (request < applied && current) return current
    if (result.mode === 'unchanged' && current) return current
    let next: T
    if (result.mode === 'full') next = result.snapshot
    else if (base && result.baseRevision === base.revision && result.snapshot.runtimeId === base.runtimeId) next = { ...result.snapshot, items: apply(base.items, result.items), turns: apply(base.turns || [], result.turns) } as T
    else next = await api<T>(`/sessions/${id}/chat`)
    if (request < applied && current || current?.runtimeId === next.runtimeId && current.revision > next.revision) return current!
    applied = request; current = next
    return next
  }
}
