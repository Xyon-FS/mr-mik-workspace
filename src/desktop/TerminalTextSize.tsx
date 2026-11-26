import { useCallback, useEffect, useRef } from 'react'
import { api, reportError } from './client'

export default function TerminalTextSize({ value }: { value: number }) {
  const input = useRef<HTMLInputElement>(null), pending = useRef<number | null>(null), confirmed = useRef(value), observed = useRef(value), version = useRef(0)
  const commit = useCallback((field: HTMLInputElement) => {
    const next = Number(field.value)
    if (!field.value || !Number.isInteger(next) || next < 10 || next > 24) { field.value = String(pending.current ?? confirmed.current); return }
    if (next === pending.current || pending.current === null && next === confirmed.current) return
    const request = ++version.current
    pending.current = next
    void api<{ terminalFontSize: number }>('/settings', { terminalFontSize: next }).then(settings => {
      if (request !== version.current) return
      confirmed.current = settings.terminalFontSize
      pending.current = observed.current === settings.terminalFontSize ? null : settings.terminalFontSize
    }).catch(error => { if (request === version.current) { pending.current = null; if (input.current && document.activeElement !== input.current) input.current.value = String(confirmed.current) } reportError(error) })
  }, [])
  useEffect(() => {
    // A settings broadcast must not replace a newer edit that is still focused.
    observed.current = value
    if (pending.current !== null && value !== pending.current) return
    pending.current = null; confirmed.current = value
    if (input.current && document.activeElement !== input.current) input.current.value = String(value)
  }, [value])
  useEffect(() => {
    // Commit before an outside pointer closes/unmounts the enclosing menu.
    const outside = (event: PointerEvent) => { const field = input.current; if (field && document.activeElement === field && !field.contains(event.target as Node)) commit(field) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [commit])
  return <input ref={input} aria-label="Terminal text size" type="number" min={10} max={24} step={1} defaultValue={value} onBlur={event => commit(event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
}
