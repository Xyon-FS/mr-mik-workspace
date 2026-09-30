import { workerEfforts } from './effort.mjs';
const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
export function makConversations(value = { conversations: [], selected: {} }) {
  if (!Array.isArray(value.conversations) || value.conversations.length > 10000 || !value.selected || typeof value.selected !== 'object' || Array.isArray(value.selected)) throw new Error('Invalid Mak conversations.');
  const conversations = value.conversations.map(item => {
    if (!validId(item.id) || item.projectId != null && !validId(item.projectId) || item.threadId != null && !/^[a-f0-9-]{36}$/i.test(item.threadId) || item.parentId != null && !validId(item.parentId) || typeof item.title !== 'string' || item.title.length > 160 || !Number.isFinite(Date.parse(item.at))) throw new Error('Invalid Mak conversation.');
    if (item.effort != null && !workerEfforts.includes(item.effort) || item.model != null && (typeof item.model !== 'string' || item.model.length > 200) || item.updatedAt != null && !Number.isFinite(Date.parse(item.updatedAt))) throw new Error('Invalid Mak reasoning metadata.');
    return { id: item.id, projectId: item.projectId || null, threadId: item.threadId || null, parentId: item.parentId || null, title: item.title, at: item.at, ...(item.effort ? { effort: item.effort } : {}), ...(item.model ? { model: item.model } : {}), ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}) };
  });
  if (new Set(conversations.map(item => item.id)).size !== conversations.length) throw new Error('Duplicate Mak conversation ID.');
  const selected = Object.fromEntries(Object.entries(value.selected).filter(([key, id]) => (key === 'global' || validId(key)) && (id === 'legacy' || conversations.some(item => item.id === id && (item.projectId || 'global') === key))));
  return { conversations, selected };
}
export function mergeMakConversations(local, incoming) {
  local = makConversations(local); incoming = makConversations(incoming);
  const result = new Map(local.conversations.map(item => [item.id, item]));
  for (const item of incoming.conversations) {
    const old = result.get(item.id);
    if (old && (old.projectId !== item.projectId || old.threadId && item.threadId && old.threadId !== item.threadId)) throw new Error('Mak conversation ID conflict.');
    const newer = old && Date.parse(old.updatedAt || old.at) >= Date.parse(item.updatedAt || item.at) ? old : item;
    result.set(item.id, { ...newer, threadId: old?.threadId || item.threadId });
  }
  return makConversations({ conversations: [...result.values()], selected: { ...incoming.selected, ...local.selected } });
}
