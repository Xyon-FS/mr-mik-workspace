import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'

type Option = { value: string; label: string; disabled?: boolean }

export default function DarkSelect({ label, value, options, onChange, compact = false, title, disabled = false }: { label: string; value: string; options: Option[]; onChange: (value: string) => void; compact?: boolean; title?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 240 })
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find(option => option.value === value)?.label || options[0]?.label || ''

  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = button.current?.getBoundingClientRect()
      if (!rect) return
      const below = window.innerHeight - rect.bottom - 8
      const above = rect.top - 8
      const height = Math.min(240, Math.max(100, below >= 130 ? below : above))
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)), top: below >= 130 ? rect.bottom + 4 : Math.max(8, rect.top - height - 4), width: rect.width, maxHeight: height })
    }
    const outside = (event: PointerEvent) => { if (!button.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false) }
    place()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])

  const focusOption = (direction: number) => {
    const enabled = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])]
    if (!enabled.length) return
    const currentIndex = enabled.findIndex(item => item === document.activeElement)
    enabled[(currentIndex + direction + enabled.length) % enabled.length].focus()
  }
  return <>
    <button ref={button} disabled={disabled} type="button" role="combobox" aria-label={label} aria-controls={listId} aria-haspopup="listbox" aria-expanded={open} title={title} className={`desk-dark-select ${compact ? 'compact' : ''}`} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => focusOption(event.key === 'ArrowDown' ? 1 : -1)) } else if (event.key === 'Escape') setOpen(false) }}><Icon name="projects" size={compact ? 13 : 15} /><span>{current}</span><Icon name="arrow" size={compact ? 11 : 13} /></button>
    {open && createPortal(<div ref={menu} id={listId} role="listbox" aria-label={label} className="desk-dark-options" style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }} onKeyDown={event => { if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); button.current?.focus() } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusOption(event.key === 'ArrowDown' ? 1 : -1) } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); const enabled = menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'); enabled?.[event.key === 'Home' ? 0 : enabled.length - 1]?.focus() } }}>
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} onClick={() => { onChange(option.value); setOpen(false); button.current?.focus() }}>{option.label}{option.value === value && <span aria-hidden="true">✓</span>}</button>)}
    </div>, document.body)}
  </>
}
