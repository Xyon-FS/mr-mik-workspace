import type { Terminal } from '@xterm/xterm'

// Keep only three visible lines in memory, briefly, during a native redraw.
// Do not persist/export text, modify the buffer or suppress terminal controls.
export function terminalReadingAnchor(terminal: Terminal) {
  let enabled = false, disposed = false, timer = 0
  let pending: { lines: string[]; expires: number } | null = null
  const cancel = () => { pending = null; window.clearTimeout(timer); timer = 0 }
  const capture = () => {
    if (!enabled || pending || terminal.buffer.active.type !== 'normal') return
    const buffer = terminal.buffer.active
    if (buffer.viewportY <= 0 || buffer.viewportY >= buffer.baseY) return
    const lines = Array.from({ length: 3 }, (_, offset) => buffer.getLine(buffer.viewportY + offset)?.translateToString(true) || '')
    // Blank/repetitive anchors cannot identify a reliable reading location.
    if (lines.filter(line => line.trim()).length < 2) return
    pending = { lines, expires: performance.now() + 5000 }
  }
  const restore = () => {
    timer = 0
    if (!pending || disposed) return
    if (performance.now() > pending.expires || terminal.buffer.active.type !== 'normal') { cancel(); return }
    const buffer = terminal.buffer.active
    let match = -1
    for (let row = 0; row <= buffer.baseY; row++) {
      if (!pending.lines.every((line, offset) => buffer.getLine(row + offset)?.translateToString(true) === line)) continue
      if (match !== -1) { match = -1; break } // Never guess between identical passages.
      match = row
    }
    if (match >= 0) { terminal.scrollToLine(match); cancel() }
    else timer = window.setTimeout(restore, 100)
  }
  const erase = terminal.parser.registerCsiHandler({ final: 'J' }, params => {
    if (params[0] === 3) capture()
    return false // Let xterm execute the real erase, including clearing history.
  })
  const parsed = terminal.onWriteParsed(() => {
    if (!pending) return
    if (performance.now() > pending.expires) { cancel(); return }
    window.clearTimeout(timer)
    timer = window.setTimeout(restore, 100)
  })
  const resize = terminal.onResize(cancel)
  const reset = terminal.parser.registerEscHandler({ final: 'c' }, () => { cancel(); return false })
  return {
    cancel,
    setEnabled: (value: boolean) => { enabled = value; if (!value) cancel() },
    dispose: () => { disposed = true; cancel(); erase.dispose(); parsed.dispose(); resize.dispose(); reset.dispose() },
  }
}
