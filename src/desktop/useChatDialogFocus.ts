import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// The chat overlays predate native dialogs. Keep their layout, while giving
// them modal keyboard behavior, including portalled selects and confirmations.
export function useChatDialogFocus<T extends HTMLElement>(enabled: boolean, close: () => void) {
  const panel = useRef<T>(null)
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const previous = useRef<HTMLElement | null>(opener)
  const dismiss = useRef(close)
  useEffect(() => { dismiss.current = close }, [close])
  useLayoutEffect(() => {
    if (enabled) return
    const remember = (event: FocusEvent) => { if (event.target instanceof HTMLElement) previous.current = event.target }
    document.addEventListener('focusin', remember)
    return () => document.removeEventListener('focusin', remember)
  }, [enabled])
  useEffect(() => {
    if (!enabled) return
    const node = panel.current
    if (!node) return
    const controls = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])')]
      .filter(element => {
        if (element.tabIndex < 0 || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false
        // Chromium can retain rects for skipped content in closed details.
        for (let parent = element.parentElement; parent && parent !== node; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false
        }
        return true
      })
    if (!node.contains(document.activeElement)) (controls().find(element => element.matches('input,textarea')) || controls()[0] || node).focus()
    const keys = (event: KeyboardEvent) => {
      // Only the foremost modal owns keyboard containment. Nested selects own
      // their own Escape/Tab and return focus to their trigger.
      const modals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(element => element.getClientRects().length)
      if (modals[modals.length - 1] !== node || document.querySelector('dialog[open]')) return
      const target = event.target as HTMLElement
      if (target.closest?.('[role="listbox"],[data-local-escape]') || target.closest?.('[role="combobox"][aria-expanded="true"]') && event.key === 'Escape') return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); return }
      if (event.key !== 'Tab') return
      const items = controls(), current = document.activeElement
      if (!items.length) { event.preventDefault(); node.focus(); return }
      if (!node.contains(current) || event.shiftKey && current === items[0] || !event.shiftKey && current === items[items.length - 1]) {
        event.preventDefault(); (event.shiftKey ? items[items.length - 1] : items[0])?.focus()
      }
    }
    document.addEventListener('keydown', keys, true)
    return () => {
      document.removeEventListener('keydown', keys, true)
      const target = previous.current
      if (target?.isConnected && target.getClientRects().length) target.focus()
    }
  }, [enabled])
  return panel
}
