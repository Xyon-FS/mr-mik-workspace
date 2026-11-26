import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'
import './anchored-menu.css'

export default function AnchoredMenu({ label, icon = 'more', children, className = '', align = 'start', menuOwner, triggerText, triggerContent, disabled = false, placement = 'side', title, appearance, onOpenChange }: { label: string; icon?: string; children: (close: () => void) => ReactNode; className?: string; align?: 'start' | 'end'; menuOwner?: string; triggerText?: string; triggerContent?: ReactNode; disabled?: boolean; placement?: 'side' | 'below' | 'left'; title?: string; appearance?: 'workspace'; onOpenChange?: (open: boolean) => void }) {
  const [host,setHost] = useState<Element | null>(null)
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 500 })
  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false) }, [open, onOpenChange])
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), menu = panel.current
      if (!anchor || !menu) return
      const width = menu.offsetWidth, maxHeight = Math.max(80, window.innerHeight - 16)
      const left = Math.max(8, Math.min((placement === 'below' ? anchor.left : placement === 'left' ? anchor.left - width - 5 : anchor.right + 5), window.innerWidth - width - 8))
      const height = Math.min(menu.scrollHeight, maxHeight), top = placement === 'below' ? (window.innerHeight - anchor.bottom >= height + 8 ? anchor.bottom + 5 : anchor.top - height - 5) : align === 'end' ? anchor.bottom - height : anchor.top
      setPosition({ left, top: Math.max(8, Math.min(top, window.innerHeight - height - 8)), maxHeight })
    }
    place(); const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, align, placement])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const node = event.target as HTMLElement
      // A nested native dialog owns focus/input until it closes. Unmounting its
      // popup owner on pointerdown would discard the confirmation before click.
      const modal = node.closest?.('dialog[open]')
      if (modal && modal !== trigger.current?.closest('dialog[open]')) return
      const listbox = node.closest?.('[role="listbox"]')
      if (listbox?.id && panel.current?.querySelector(`[aria-controls="${CSS.escape(listbox.id)}"]`)) return
      if (!panel.current?.contains(node) && !trigger.current?.contains(node)) setOpen(false)
    }
    const modalFocus = (event: FocusEvent) => { if ((event.target as HTMLElement).closest?.('.desk-scrim,[aria-modal="true"]')) outside(event) }
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (event.target as HTMLElement).closest?.('[data-local-escape]')) return
      // Disabled controls can return keyboard focus to body while a native
      // modal is busy. The modal still owns Escape/Tab in that case.
      if (document.querySelector('dialog[open]') && document.activeElement?.closest('dialog[open]') !== trigger.current?.closest('dialog[open]')) return
      if ((event.target as HTMLElement).closest?.('[role="listbox"]')) return
      if (event.key === 'Escape' && (event.target as HTMLElement).closest?.('[role="combobox"][aria-expanded="true"]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true }) }
      if (event.key === 'Tab') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') || [])].filter(item => item.getClientRects().length > 0)
        if (!items.length) return
        if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? items[items.length - 1] : items[0])?.focus() }
        else if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus() }
        else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus() }
      }
    }
    panel.current?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled),summary')?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', modalFocus); document.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', modalFocus); document.removeEventListener('keydown', keys, true) }
  }, [open])
  return <><button type="button" ref={trigger} disabled={disabled} className={`desk-icon ${className}`} aria-label={label} title={title || label} aria-haspopup="dialog" aria-expanded={open} onClick={event => { setHost(event.currentTarget.closest('dialog[open]') || document.fullscreenElement); setOpen(value => !value) }}>{triggerContent ?? (triggerText ? <><span>{triggerText}</span><Icon name="arrow" size={11} /></> : <Icon name={icon} size={15} />)}</button>{open && createPortal(<div ref={panel} data-menu-owner={menuOwner} className={`conversation-anchored-menu${appearance ? ' workspace-popover' : ''}`} role="dialog" aria-label={label} style={position}>{children(close)}</div>, host || document.body)}</>
}
