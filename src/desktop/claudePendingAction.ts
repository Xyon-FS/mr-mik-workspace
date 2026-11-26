export type ClaudePendingAction = { id: string; signature: string; action: 'steer' | 'enqueue'; expectedTurnId: string | null; revision: number }
type Cache = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const key = (id: string) => `mrmak.claude-pending-action.${id}`
export function readClaudePendingAction(id: string, cache?: Cache): ClaudePendingAction | null {
  try {
    const value = JSON.parse((cache || localStorage).getItem(key(id)) || 'null')
    return value && typeof value.id === 'string' && typeof value.signature === 'string' && ['steer', 'enqueue'].includes(value.action) && (value.expectedTurnId === null || typeof value.expectedTurnId === 'string') && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value : null
  } catch { return null }
}
export function writeClaudePendingAction(id: string, value: ClaudePendingAction | null, expectedId?: string, cache: Cache = localStorage) {
  // A response from an older view must not clear a newer action's reservation.
  if (expectedId && readClaudePendingAction(id, cache)?.id !== expectedId) return
  if (value) cache.setItem(key(id), JSON.stringify(value))
  else cache.removeItem(key(id))
}
