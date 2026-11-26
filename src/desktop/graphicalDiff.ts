// Unified headers and patch content can both begin with +++/---. Track the
// declared hunk lengths instead of guessing from those prefixes alone.
export function diffLines(text: string) {
  let oldLines = 0, newLines = 0
  return text.split('\n').map(line => {
    let kind: 'added' | 'removed' | 'hunk' | undefined
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldLines = Number(hunk[1] ?? 1); newLines = Number(hunk[2] ?? 1); kind = 'hunk'
    } else if (oldLines > 0 || newLines > 0) {
      if (line.startsWith('+') && newLines > 0) { kind = 'added'; newLines-- }
      else if (line.startsWith('-') && oldLines > 0) { kind = 'removed'; oldLines-- }
      else if (line.startsWith(' ')) { oldLines = Math.max(0, oldLines - 1); newLines = Math.max(0, newLines - 1) }
      else if (!line.startsWith('\\')) { oldLines = 0; newLines = 0 }
    } else {
      if (line.startsWith('+') && !line.startsWith('+++ ')) kind = 'added'
      if (line.startsWith('-') && !line.startsWith('--- ')) kind = 'removed'
    }
    return { line, kind }
  })
}
