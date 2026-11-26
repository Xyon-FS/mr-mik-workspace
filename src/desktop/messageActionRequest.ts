type Cache = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const key = (sessionId: string, itemId: string, kind: string) => `mrmak.message-action.${JSON.stringify([sessionId, itemId, kind])}`

// A lost response must not turn the next explicit retry into a second native
// action. Persist before dispatch; a confirmed success permits a new action.
export function messageActionRequest(sessionId: string, itemId: string, kind: string, cache: Cache = localStorage) {
  const name = key(sessionId, itemId, kind), previous = cache.getItem(name)
  if (previous) {
    if (!/^[a-f0-9-]{36}$/i.test(previous)) throw new Error('The saved message-action identity is invalid. No action was sent.')
    return previous
  }
  const id = crypto.randomUUID()
  cache.setItem(name, id)
  return id
}
export function completeMessageAction(sessionId: string, itemId: string, kind: string, id: string, cache: Cache = localStorage) {
  const name = key(sessionId, itemId, kind)
  if (cache.getItem(name) === id) cache.removeItem(name)
}
