export function mergeHistoryWindow<T extends { id: string }>(before: T[], after: T[]) {
  // The incoming native window owns order and contents from its first overlap.
  // Retain only the earlier prefix, including rows evicted from the live cap.
  const incoming = new Set(after.map(item => item.id))
  const overlap = before.findIndex(item => incoming.has(item.id))
  const next = [...(overlap < 0 ? before : before.slice(0, overlap)), ...after]
  return next.length === before.length && next.every((item, index) => item === before[index]) ? before : next
}
