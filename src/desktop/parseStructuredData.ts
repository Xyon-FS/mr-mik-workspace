export type StructuredValue = { kind: 'json'; value: unknown } | { kind: 'table'; cells: string[][] }
export function parseStructuredData(text: string, language: string): StructuredValue | null {
  if (text.length > 200000) return null
  if (language.toLowerCase() === 'json') {
    try { const value: unknown = JSON.parse(text); return value !== null && typeof value === 'object' ? { kind: 'json', value } : null } catch { return null }
  }
  if (!['csv', 'tsv'].includes(language.toLowerCase())) return null
  const separator = language.toLowerCase() === 'tsv' ? '\t' : ',', cells: string[][] = []
  let row: string[] = [], field = '', quoted = false, closed = false
  const cell = () => { row.push(field); field = ''; closed = false; return row.length <= 100 }
  const line = () => { cells.push(row); row = []; return cells.length <= 1000 }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { field += '"'; index++ } else { quoted = false; closed = true } }
      else field += char
    } else if (char === separator) { if (!cell()) return null }
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[index + 1] === '\n') index++; if (!cell() || !line()) return null }
    else if (char === '"' && !field && !closed) quoted = true
    else { if (closed || char === '"') return null; field += char }
  }
  if (quoted) return null
  if ((field || row.length || closed) && (!cell() || !line())) return null
  if (cells.length < 2 || cells[0].length < 2 || cells.some(row => row.length !== cells[0].length)) return null
  return { kind: 'table', cells }
}

