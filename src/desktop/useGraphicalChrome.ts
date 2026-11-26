import { useEffect } from 'react'
import type { RefObject } from 'react'

export function useGraphicalChrome({ view, find }: { view: RefObject<HTMLDivElement | null>; find: () => void }) {
  useEffect(() => {
    const root = () => view.current?.closest('.graphical-chat')
    const panels = () => Array.from(root()?.querySelectorAll<HTMLDetailsElement>('details.graphical-details[open], details.graphical-usage[open], details.graphical-context-menu[open]') || [])
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement, list = target.closest?.('[role="listbox"]');
      for (const panel of panels()) {
        const owner = panel.closest('.graphical-details') || panel
        const ownedList = list && Array.from(owner.querySelectorAll('[aria-controls]')).some(control => control.getAttribute('aria-controls') === list.id)
        if (!owner.contains(target) && !ownedList) panel.open = false
      }
    }
    const exclusive = (event: Event) => {
      const opened = event.target;
      if (opened instanceof HTMLDetailsElement && opened.open && root()?.contains(opened) && opened.matches('.graphical-details, .graphical-usage, .graphical-context-menu')) for (const panel of panels()) if (panel !== opened && !panel.contains(opened)) panel.open = false
    }
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open],[aria-modal="true"]')) return
      if (event.key === 'Escape') { const opened = panels(); for (const panel of opened) panel.open = false; opened[0]?.querySelector('summary')?.focus() }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); find(); requestAnimationFrame(() => root()?.querySelector<HTMLInputElement>('.graphical-search input')?.focus()) }
    }
    window.addEventListener('keydown', keys); document.addEventListener('pointerdown', outside); document.addEventListener('toggle', exclusive, true)
    return () => { window.removeEventListener('keydown', keys); document.removeEventListener('pointerdown', outside); document.removeEventListener('toggle', exclusive, true) }
  }, [view, find])
}
