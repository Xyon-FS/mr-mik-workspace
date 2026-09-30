// Portable application conversation, never a native Codex login or thread ID.
const id = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
export function makHistory(value) {
  if (!value || !Array.isArray(value.operations) || value.operations.length > 50000) throw new Error('Invalid or excessively large Mak History.');
  return { operations: value.operations.map(item => {
    if (!id(item.id) || !item.scope || !['projectId', 'repositoryId', 'cardId', 'selectedId'].every(key => item.scope[key] == null || id(item.scope[key])) || typeof item.text !== 'string' || item.text.length > 30000 || !['running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(item.status) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || item.result != null && (typeof item.result !== 'string' || item.result.length > 200000)) throw new Error('Invalid Mak History operation.');
    if (item.conversationId != null && !id(item.conversationId)) throw new Error('Invalid Mak conversation reference.');
    return { id: item.id, ...(item.conversationId ? { conversationId: item.conversationId } : {}), text: item.text, at: item.at, status: item.status === 'running' ? 'interrupted' : item.status, ...(item.result != null ? { result: item.result } : {}), scope: Object.fromEntries(['projectId', 'repositoryId', 'cardId', 'selectedId'].map(key => [key, item.scope[key] || null])) };
  }) };
}
export function mergeMakHistory(local, incoming) {
  const result = new Map(makHistory(local).operations.map(item => [item.id, item]));
  for (const item of makHistory(incoming).operations) {
    const previous = result.get(item.id);
    if (!previous || previous.text === item.text && JSON.stringify(previous.scope) === JSON.stringify(item.scope) && previous.status === 'interrupted' && item.status !== 'interrupted') result.set(item.id, item);
  }
  return { operations: [...result.values()].sort((a, b) => a.at.localeCompare(b.at)) };
}
