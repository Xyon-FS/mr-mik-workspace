import { useCallback, useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon } from './Icons'
import './preview-chrome.css'

export function PreviewButton({ label, icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: string }) {
  return <button type="button" className="preview-icon-button" aria-label={label} title={label} {...props}><Icon name={icon} size={15} />{children}</button>
}

export function PreviewOptions({ label, children }: { label: string; children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null)
  const position = useCallback(() => {
    const element = root.current, popup = element?.querySelector<HTMLElement>('.preview-options-content')
    if (!element?.open || !popup) return
    const trigger = element.querySelector('summary')!.getBoundingClientRect()
    if (!trigger.width || !trigger.height) { element.open = false; return }
    const container = element.closest('.file-preview-body, .workspace-view-body')?.getBoundingClientRect()
    const top = Math.max(8, container?.top || 0), bottom = Math.min(window.innerHeight - 8, container?.bottom ?? window.innerHeight)
    const left = Math.max(8, container?.left || 0), right = Math.min(window.innerWidth - 8, container?.right ?? window.innerWidth)
    popup.style.maxWidth = `${Math.max(0, right - left)}px`
    const below = Math.max(0, bottom - trigger.bottom - 6), above = Math.max(0, trigger.top - top - 6)
    const upwards = below < Math.min(popup.scrollHeight, 200) && above > below
    popup.style.top = upwards ? 'auto' : 'calc(100% + 6px)'
    popup.style.bottom = upwards ? 'calc(100% + 6px)' : 'auto'
    popup.style.maxHeight = `${Math.min(440, upwards ? above : below)}px`
    const width = popup.getBoundingClientRect().width, x = Math.max(left, Math.min(right - width, trigger.right - width))
    popup.style.right = `${trigger.right - x - width}px`
  }, [])
  useEffect(() => {
    const outside = (event: Event) => { if (root.current?.open && !root.current.contains(event.target as Node)) root.current.open = false }
    const blur = () => { if (root.current) root.current.open = false }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && root.current?.open) { event.preventDefault(); event.stopPropagation(); root.current.open = false; root.current.querySelector('summary')?.focus() } }
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', escape, true); window.addEventListener('blur', blur); window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
    const observer = new ResizeObserver(position); if (root.current?.parentElement) observer.observe(root.current.parentElement)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); observer.disconnect() }
  }, [position])
  return <details ref={root} className="preview-options" onToggle={position}><summary aria-label={label} title={label}><Icon name="more" size={16} /></summary><div className="preview-options-content" onClick={event => { if ((event.target as Element).closest('button') && root.current) { root.current.open = false; root.current.querySelector('summary')?.focus({ preventScroll: true }) } }}>{children}</div></details>
}
