import { useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'

type Option = { value: string; label: string; disabled?: boolean; leading?: ReactNode }

export default function DarkSelect({ label, value, options, onChange, compact = false, title, disabled = false, icon = 'projects', placeholder, variant, appearance, contained = false, leading }: { label: string; value: string; options: Option[]; onChange: (value: string) => void; compact?: boolean; title?: string; disabled?: boolean; icon?: string; placeholder?: string; variant?: 'permissions'; appearance?: 'workspace'; contained?: boolean; leading?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [portal, setPortal] = useState<HTMLElement>(document.body)
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 0, top: 0, width: 0, maxHeight: 240 })
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const keyboardDirection = useRef(0)
  const listId = useId()
  const current = options.find(option => option.value === value)?.label || placeholder || options[0]?.label || ''
  if (disabled && open) setOpen(false)

  useLayoutEffect(() => {
    if (!open || disabled) return
    const place = () => {
      const rect = button.current?.getBoundingClientRect()
      if (!rect) return
      if (menu.current) menu.current.dataset.chatMenu = String(!!button.current?.closest('.chats-surface,.graphical-model-picker-menu,.conversation-anchored-menu'))
      const below = window.innerHeight - rect.bottom - 8
      const above = rect.top - 8
      const opensBelow = below >= 130 || below >= above
      const height = Math.max(1, Math.min(variant ? 320 : 240, (opensBelow ? below : above) - 4))
      const width = Math.min(variant ? Math.max(240, rect.width) : rect.width, window.innerWidth - 16)
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: opensBelow ? rect.bottom + 4 : undefined, bottom: opensBelow ? undefined : window.innerHeight - rect.top + 4, width, maxHeight: height })
    }
    const outside = (event: PointerEvent) => { if (!button.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false) }
    place()
    if (keyboardDirection.current) {
      const enabled = menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')
      enabled?.[keyboardDirection.current > 0 ? 0 : enabled.length - 1]?.focus()
      keyboardDirection.current = 0
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, disabled, variant])

  const portalTarget = () => (contained ? button.current?.closest<HTMLElement>('.conversation-anchored-menu') : null) || button.current?.closest('dialog') || document.body
  const focusOption = (direction: number) => {
    const enabled = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])]
    if (!enabled.length) return
    const currentIndex = enabled.findIndex(item => item === document.activeElement)
    enabled[currentIndex < 0 ? (direction > 0 ? 0 : enabled.length - 1) : (currentIndex + direction + enabled.length) % enabled.length].focus()
  }
  return <>
    <button ref={button} disabled={disabled} type="button" role="combobox" data-value={value} aria-label={label} aria-controls={listId} aria-haspopup="listbox" aria-expanded={open && !disabled} title={title} className={`desk-dark-select ${compact ? 'compact' : ''}${variant ? ' permission-trigger' : ''}${appearance ? ' workspace-select' : ''}`} onClick={() => { setPortal(portalTarget()); setOpen(value => !value) }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (open) focusOption(event.key === 'ArrowDown' ? 1 : -1); else { keyboardDirection.current = event.key === 'ArrowDown' ? 1 : -1; setPortal(portalTarget()); setOpen(true) } } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) } }}>{leading || (icon && <Icon name={icon} size={compact ? 13 : 15} />)}<span>{current}</span><Icon name="arrow" size={compact ? 11 : 13} /></button>
    {open && !disabled && createPortal(<div ref={menu} id={listId} role="listbox" aria-label={label} className={`desk-dark-options${variant ? ' permission-options' : ''}${appearance ? ' workspace-select-options' : ''}`} style={{ boxSizing: 'border-box', left: position.left, top: position.top, bottom: position.bottom, width: position.width, maxHeight: position.maxHeight }} onKeyDown={event => { if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() } setOpen(false); button.current?.focus() } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusOption(event.key === 'ArrowDown' ? 1 : -1) } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); const enabled = menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'); enabled?.[event.key === 'Home' ? 0 : enabled.length - 1]?.focus() } }}>
      {variant && <div className="permission-menu-heading">Permissions</div>}
      {options.map(option => <button key={option.value} data-value={option.value} type="button" role="option" aria-label={option.label} aria-selected={option.value === value} disabled={option.disabled} onClick={() => { if (disabled) return; onChange(option.value); setOpen(false); button.current?.focus() }}>{option.leading}{variant && <Icon name={option.value.includes('bypass') || option.value === 'full-access' ? 'shield' : option.value === 'auto-review' ? 'check' : 'question'} size={15} />}<span className="select-option-label">{option.label}</span>{option.value === value && <span className="select-option-check" aria-hidden="true">✓</span>}</button>)}
    </div>, portal)}
  </>
}
