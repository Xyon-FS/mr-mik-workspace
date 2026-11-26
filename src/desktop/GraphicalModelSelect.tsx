import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AgentLogo, Icon } from './Icons'
import DarkSelect from './DarkSelect'
import { useConversationChrome } from './ConversationChrome'

export type GraphicalModel = { model: string; displayName: string; defaultReasoningEffort?: string; supportedReasoningEfforts: { reasoningEffort: string }[] }
const effortLabel = (value?: string) => value === 'xhigh' ? 'Extra high' : value ? value[0].toUpperCase() + value.slice(1) : 'Default'

export default function GraphicalModelSelect({ models, model, effort, disabled, onChange, workMode, usage, provider, placeholder = 'Loading models…' }: { models: GraphicalModel[] | null; model?: string; effort?: string; disabled: boolean; onChange: (model: string, effort?: string) => Promise<void>; workMode?: { value: string; choices: { value: string; label: string }[]; disabled?: boolean; change: (value: string) => Promise<unknown> }; usage?: ReactNode; provider?: 'codex' | 'claude'; placeholder?: string }) {
  const { account } = useConversationChrome()
  const [open, setOpen] = useState(false)
  const [showUsage, setShowUsage] = useState(false)
  const [position, setPosition] = useState<{ left: number; width: number; bottom?: number; top?: number; maxHeight: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId()
  const focusVersion = useRef(0)
  const selected = models?.find(item => item.model === model)
  const dismiss = useCallback(() => { focusVersion.current++; setOpen(false) }, [])
  const close = useCallback(() => { dismiss(); trigger.current?.focus() }, [dismiss])
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return
      const width = Math.min(320, window.innerWidth - 16), above = rect.top - 12, below = window.innerHeight - rect.bottom - 12
      const up = above >= 180 || above >= below
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), maxHeight: Math.max(60, Math.min(540, up ? above : below)) })
    }
    const outside = (event: Event) => {
      const target = event.target as HTMLElement, list = target.closest?.('[role="listbox"]')
      if (list && [...(menu.current?.querySelectorAll('[aria-controls]') || [])].some(control => control.getAttribute('aria-controls') === list.id)) return
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) dismiss()
    }
    // Disabling a pending selection can move focus to body, outside the portal.
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement).closest?.('[role="listbox"]')) { event.preventDefault(); event.stopPropagation(); close() } }
    place(); document.addEventListener('keydown', escape, true); document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('keydown', escape, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, close, dismiss])
  const focusModel = () => menu.current?.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model"]')?.focus()
  useEffect(() => {
    if (!open || !position || document.activeElement !== trigger.current) return
    // Enter/Space and pointer activation must enter the portal as well as arrows.
    // Otherwise the next Tab skips the picker and immediately dismisses it.
    const first = menu.current?.querySelector<HTMLButtonElement>('[role="combobox"]:not(:disabled)') || menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus()
  }, [open, position])
  const apply = async (value: string, nextEffort: string | undefined, group: string) => {
    const version = focusVersion.current
    await onChange(value, nextEffort)
    requestAnimationFrame(() => { if (version === focusVersion.current) menu.current?.querySelector<HTMLButtonElement>(`[role="radiogroup"][aria-label="${group}"] [aria-checked="true"]`)?.focus() })
  }
  return <>
    <button ref={trigger} type="button" role="combobox" aria-label="Model and reasoning" aria-haspopup="dialog" aria-controls={id} aria-expanded={open} disabled={!models && !usage && !account} className="graphical-model-trigger" title={`Model and session · ${effortLabel(effort)}${workMode ? ` · ${workMode.choices.find(item => item.value === workMode.value)?.label || 'Build'}` : ''}`} onClick={() => { if (open) dismiss(); else setOpen(true) }} onKeyDown={event => {
      if (event.key === 'Escape') close()
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); requestAnimationFrame(() => requestAnimationFrame(focusModel)) }
    }}><span>{selected?.displayName || model || placeholder}</span><small>{effortLabel(effort)}{workMode && ` · ${workMode.choices.find(item => item.value === workMode.value)?.label || 'Build'}`}</small><Icon name="arrow" size={11} /></button>
    {open && position && createPortal(<div ref={menu} id={id} role="dialog" aria-label="Model and reasoning" className="graphical-model-picker-menu" style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        const target = event.target as HTMLElement, group = target.closest('[role="radiogroup"]'); if (!group) return
        const choices = [...group.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')]; if (!choices.length) return
        event.preventDefault(); const index = choices.indexOf(target as HTMLButtonElement), direction = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1
        choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + direction + choices.length) % choices.length].focus()
      }
      if (event.key === 'Tab') {
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])], index = buttons.indexOf(event.target as HTMLButtonElement)
        if (event.shiftKey && index === 0 || !event.shiftKey && index === buttons.length - 1) { event.preventDefault(); close() }
      }
    }}>
      <header className="graphical-session-heading">{provider && <AgentLogo agent={provider} size={16} />}<strong>{provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Model and session'}</strong><button type="button" aria-label="Close model and session" onClick={close}><Icon name="close" size={15} /></button></header>

      {account && <section className="graphical-account-options"><strong>Account</strong>{account}</section>}
      <section className="graphical-model-options"><strong>Model</strong><DarkSelect icon="" label="Model" value={model || ''} disabled={disabled || !models?.length} options={(models || []).map(item => ({ value: item.model, label: item.displayName || item.model }))} onChange={value => { const next = models?.find(item => item.model === value); if (next && next.model !== model) { const nextEffort = next.supportedReasoningEfforts.some(item => item.reasoningEffort === effort) ? effort : next.defaultReasoningEffort || next.supportedReasoningEfforts[0]?.reasoningEffort; void onChange(next.model, nextEffort).catch(() => {}) } }} /></section>
      <section className="graphical-reasoning-options"><strong>Reasoning</strong><div role="radiogroup" aria-label="Reasoning effort">{selected?.supportedReasoningEfforts.map(item => <button type="button" role="radio" aria-checked={item.reasoningEffort === effort} key={item.reasoningEffort} disabled={disabled} onClick={() => { if (model && item.reasoningEffort !== effort) void apply(model, item.reasoningEffort, 'Reasoning effort').catch(() => {}) }}>{effortLabel(item.reasoningEffort)}</button>)}</div>{!selected?.supportedReasoningEfforts.length && <small>No adjustable reasoning reported.</small>}</section>
      {workMode && <section className="graphical-workmode-options"><strong>Work mode</strong><div role="radiogroup" aria-label="Work mode">{workMode.choices.map(item => <button type="button" role="radio" key={item.value} aria-checked={item.value === workMode.value} disabled={disabled || workMode.disabled} onClick={() => { if (item.value !== workMode.value) void workMode.change(item.value).catch(() => {}) }}>{item.label}</button>)}</div></section>}
      {usage && <section className="graphical-account-usage"><button type="button" className="graphical-usage-toggle" aria-expanded={showUsage} onClick={() => setShowUsage(value => !value)}><Icon name="info" size={15} /><span>Account usage</span><Icon name="arrow" size={12} /></button>{showUsage && usage}</section>}
    </div>, document.body)}
  </>
}
