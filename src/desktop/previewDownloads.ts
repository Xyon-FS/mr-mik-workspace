export function downloadPreview(text: string, name: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a')
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000)
}
export function tableCsv(cells: string[][]) { return cells.map(row => row.map(value => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n') }
export function codeFence(text: string, language = '') {
  let length = 3
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  const fence = '`'.repeat(length)
  return `${fence}${language}\n${text}\n${fence}`
}
