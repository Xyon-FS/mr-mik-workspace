export function visualizeReference(text) {
  if (typeof text !== 'string' || text.length > 10000) return null;
  const match = /^\uE200visualize\uE202(\{[^\r\n]*\})\uE201?$/u.exec(text.trim());
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    if (typeof value?.path !== 'string' || value.path.length > 8192 || !/\.html?$/i.test(value.path) || /[\x00-\x1f]/.test(value.path)) return null;
    return { path: value.path, wide: value.mode === 'wide', title: typeof value.title === 'string' ? value.title.trim().slice(0, 120) : '' };
  } catch {
    return null;
  }
}
