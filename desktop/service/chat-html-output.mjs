// Whole, completed HTML outputs only; ordinary prose/inline tags remain Markdown.
export function standaloneHtml(text) {
  if (typeof text !== 'string' || text.length > 200000) return null;
  const value = text.trim(), body = value.replace(/^<!doctype\s+html[^>]*>\s*/i, '');
  const root = /^<(html|body|div|section|article|main|form|table|svg|canvas|button)\b[^>]*>/i.exec(body);
  if (!root || !new RegExp(`</${root[1]}\\s*>$`, 'i').test(body)) return null;
  return value;
}
