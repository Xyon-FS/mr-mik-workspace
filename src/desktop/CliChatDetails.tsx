import { useEffect, useRef, type ReactNode } from 'react'
import { GraphicalChatDetails } from './GraphicalChatChrome'
import { Icon } from './Icons'

export default function CliChatDetails({ connected, children }: { connected: boolean; children: ReactNode }) {
  const container = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement, panel = container.current
      const list = target.closest?.('[role="listbox"]')
      if (list && [...(panel?.querySelectorAll('[aria-controls]') || [])].some(control => control.getAttribute('aria-controls') === list.id)) return
      if (panel?.open && !panel.contains(target)) panel.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !container.current?.open) return
      container.current.open = false
      container.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [])
  return <details className="graphical-details" ref={container}><summary aria-label="Chat details" title="Chat details"><Icon name="more" size={17} /></summary><GraphicalChatDetails connected={connected} sessionInfo={children} /></details>
}
