import type { Terminal } from '@xterm/xterm'

// Temporary, local-only diagnostics. Never inspect buffer text or input values.
export function cursorDiagnostics(terminal: Terminal) {
  const buffer = terminal.buffer.active
  const cursor = terminal.element?.querySelector('.xterm-cursor')
  const core = (terminal as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core
  const style = cursor ? getComputedStyle(cursor) : null
  const rect = cursor?.getBoundingClientRect()
  return {
    documentFocused: document.hasFocus(),
    inputFocused: !!terminal.element && terminal.element.contains(document.activeElement) && document.activeElement?.classList.contains('xterm-helper-textarea'),
    buffer: buffer.type,
    cursor: { x: buffer.cursorX, y: buffer.cursorY, viewportY: buffer.viewportY, baseY: buffer.baseY, hidden: core?.coreService?.isCursorHidden ?? 'unavailable' },
    configured: { style: terminal.options.cursorStyle, blink: terminal.options.cursorBlink, inactiveStyle: terminal.options.cursorInactiveStyle, width: terminal.options.cursorWidth, color: terminal.options.theme?.cursor },
    renderer: { present: !!cursor, effectiveStyle: cursor?.classList.contains('xterm-cursor-bar') ? 'bar' : cursor?.classList.contains('xterm-cursor-outline') ? 'outline' : cursor?.classList.contains('xterm-cursor-underline') ? 'underline' : cursor?.classList.contains('xterm-cursor-block') ? 'block' : 'unknown', display: style?.display, visibility: style?.visibility, opacity: style?.opacity, color: style?.color, background: style?.backgroundColor, boxShadow: style?.boxShadow, outline: style?.outline, animation: style?.animationName, width: rect?.width, height: rect?.height },
  }
}
