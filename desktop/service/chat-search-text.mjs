export function chatSearchText(item) {
  if (!item || typeof item !== 'object') return '';
  return [item.text, item.fullDetails ?? item.details, item.tool, item.server,
    ...(item.attachments || []).map(value => value.name),
    ...(item.changes || []).map(value => `${value.path} ${value.diff}`),
    ...(item.resources || []).map(value => `${value.name || ''} ${value.text || ''} ${value.uri || ''}`)].filter(value => typeof value === 'string').join('\n');
}
export function searchMatch(item, query) { return typeof query === 'string' && !!query.trim() && chatSearchText(item).toLowerCase().includes(query.trim().toLowerCase()); }
