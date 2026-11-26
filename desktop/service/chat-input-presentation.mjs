const quoteHeaders = [
  '\n\nQuoted context (user-selected excerpts; chat excerpts or browser selections):\n',
  '\n\nQuoted context (user-selected chat excerpts or browser selections):\n',
];

function quotePayload(quotes) {
  return quotes.map(value => `[${value.role} message ${value.itemId}]\n${value.text.split('\n').map(line => '> ' + line).join('\n')}`).join('\n\n');
}

export function recordedQuoteSuffix(quotes) {
  return quotes.length ? quoteHeaders[0] + quotePayload(quotes) : '';
}

// Codex native history echoes text only. Recover the structured context from our complete suffix.
export function recordedQuotes(item) {
  const text = visibleUserText(item);
  const header = quoteHeaders.find(value => text.includes(value));
  if (!header) return [];
  const entries = text.slice(text.lastIndexOf(header) + header.length).split('\n\n');
  if (entries.length > 20) return [];
  const quotes = [];
  let size = 0;
  for (const [index, entry] of entries.entries()) {
    const [source, ...lines] = entry.split('\n');
    const match = /^\[(assistant|user) message ([^\x00-\x1f]{1,8192})\]$/.exec(source);
    if (!match || !lines.length || lines.some(line => !line.startsWith('> '))) return [];
    const quote = lines.map(line => line.slice(2)).join('\n');
    size += quote.length;
    if (!quote.trim() || quote.length > 8000 || size > 16000) return [];
    quotes.push({ id: `native-quote:${index}`, type: 'quote', role: match[1], itemId: match[2], text: quote });
  }
  return quotes;
}

// Presentation only: native text and attachment payloads remain unchanged.
export function visibleUserText(item) {
  let text = item.text || '';
  const marker = '\n\nAttached paths:\n', position = text.lastIndexOf(marker);
  if (position >= 0 && item.attachments?.length) {
    try {
      const paths = text.slice(position + marker.length).split('\n').map(line => JSON.parse(line));
      const known = new Set(item.attachments.map(value => value.path));
      if (paths.length && paths.every(value => typeof value === 'string' && /^(?:[a-z]:[\\/]|\/)/i.test(value) && known.has(value))) text = text.slice(0, position);
    } catch { /* Preserve user-authored or unrecognized suffixes. */ }
  }
  const quotes = item.composerContext?.filter(value => value.type === 'quote') || [];
  if (quotes.length && quotes.every(value => typeof value.text === 'string' && typeof value.itemId === 'string' && ['user','assistant'].includes(value.role))) {
    const payload = quotePayload(quotes);
    for (const header of quoteHeaders) {
      const suffix = header + payload;
      if (text.endsWith(suffix)) { text = text.slice(0,-suffix.length); break; }
    }
  }
  return text;
}
