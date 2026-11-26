import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentProps, RefObject } from 'react'
import type { ChatDraft } from './useChatDraft'
import { api } from './client'
import { skillCompletion, completeSkill } from '../../desktop/service/skill-completion.mjs'
import { skillMentions } from '../../desktop/service/skill-mentions.mjs'
import SkillCompletionMenu from './SkillCompletionMenu'
import type { CompletionSkill } from './SkillCompletionMenu'
import './chat-completion-layout.css'

type Completion = { sessionId: string; runtimeId?: string; provider: 'codex' | 'claude'; disabled: boolean; hasImages?: boolean; selectedSkills?: string[] }
export default function GraphicalDraftInput({ draft, inputRef, onChange, completion, onSkillInsert, ...props }: Omit<ComponentProps<'textarea'>, 'value' | 'defaultValue' | 'ref'> & { draft: ChatDraft; inputRef: RefObject<HTMLTextAreaElement | null>; completion?: Completion; onSkillInsert?: (text: string) => void }) {
  const text = useSyncExternalStore(draft.subscribe, draft.read)
  const [cursor, setCursor] = useState<number | null>(null), [host, setHost] = useState<HTMLElement | null>(null), [dismissed, setDismissed] = useState(false), [activation, setActivation] = useState(0), [selected, setSelected] = useState(0)
  const [catalog, setCatalog] = useState<{scope: string; activation: number; skills: CompletionSkill[]; error: string; warning: string} | null>(null), [insertionError, setInsertionError] = useState('')
  const mirror = useRef<HTMLDivElement>(null), id = useId()
  const scope = `${completion?.sessionId}:${completion?.runtimeId || ''}`, sessionId = completion?.sessionId, runtimeId = completion?.runtimeId
  const token = cursor == null ? null : skillCompletion(text, cursor)
  const wanted = !!(completion && !completion.disabled && token && host && !dismissed)
  const ready = catalog?.scope === scope && catalog.activation === activation
  useEffect(() => {
    if (!wanted || !sessionId) return
    let alive = true
    void api<{skills: CompletionSkill[]; warnings?: string}>(`/sessions/${sessionId}/chat`, {action: 'skills', runtimeId}).then(result => {
      if (alive) setCatalog({scope, activation, skills: result.skills, error: '', warning: result.warnings || ''})
    }, cause => { if (alive) setCatalog({scope, activation, skills: [], error: cause.message, warning: ''}) })
    return () => { alive = false }
  }, [wanted, sessionId, runtimeId, scope, activation])
  const known = useMemo(() => new Set(catalog?.scope === scope ? catalog.skills.map(skill => skill.name) : []), [catalog, scope])
  const mentions = useMemo(() => known.size ? skillMentions(text).filter(item => known.has(item.name)) : [], [text, known])
  const visible = ready ? catalog.skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(token?.query.toLowerCase() || '')) : []
  const current = Math.min(selected, Math.max(0, visible.length - 1))
  const blocked = (skill: CompletionSkill) => {
    if (catalog?.skills.filter(item => item.name === skill.name).length !== 1) return 'More than one skill has this name. Use a uniquely named skill.'
    if (completion?.provider !== 'claude') return ''
    if (completion.hasImages) return 'Remove images before using a native Claude skill.'
    if (mentions.some(item => item.start !== token?.start && item.name !== skill.name) || completion.selectedSkills?.some(name => name !== skill.name)) return 'Claude supports one skill per message.'
    return ''
  }
  const choose = (skill: CompletionSkill) => {
    if (!token || !ready || blocked(skill) || completion?.disabled) return
    try {
      const next = completeSkill(text, token, skill.name, props.maxLength || 64000)
      if (onSkillInsert) onSkillInsert(next.text); else draft.set(next.text)
      setDismissed(true); setInsertionError('')
      const input = inputRef.current
      input?.focus()
      requestAnimationFrame(() => { if (input?.isConnected && draft.read() === next.text) { input.setSelectionRange(next.cursor, next.cursor); setCursor(next.cursor) } })
    } catch (cause) { setInsertionError(cause instanceof Error ? cause.message : 'Skill unavailable.') }
  }
  useLayoutEffect(() => {
    const input = inputRef.current
    if (input) {
      input.style.height = 'auto'; input.style.height = `${Math.min(220, Math.max(44, input.scrollHeight))}px`
      if (mirror.current) {
        const style = getComputedStyle(input)
        for (const property of ['font','line-height','letter-spacing','padding','tab-size','word-break','overflow-wrap','box-sizing']) mirror.current.style.setProperty(property,style.getPropertyValue(property))
        mirror.current.scrollTop = input.scrollTop
      }
    }
  }, [text, inputRef, mentions.length])
  const end = mentions[mentions.length - 1]?.end || 0
  const highlighted = mentions.flatMap((item,index) => [text.slice(index ? mentions[index-1].end : 0,item.start),<strong key={item.start}>{text.slice(item.start,item.end)}</strong>])
  return <><div className={`graphical-draft-editor${mentions.length ? ' has-skill-highlight' : ''}`}>
    {!!mentions.length && <div ref={mirror} className="graphical-draft-mirror" aria-hidden="true">{highlighted}{text.slice(end)}{text.endsWith('\n') ? '\u200b' : ''}</div>}
    <textarea {...props} ref={inputRef} value={text} aria-autocomplete={completion ? 'list' : undefined} aria-expanded={wanted} aria-controls={wanted ? id : undefined} aria-activedescendant={wanted && visible[current] ? `${id}-${current}` : undefined}
      onFocus={event => { props.onFocus?.(event); setHost(event.currentTarget.closest('form')); setCursor(event.currentTarget.selectionStart); setDismissed(false) }}
      onBlur={event => { props.onBlur?.(event); const target = event.relatedTarget; if (!(target instanceof HTMLElement && target.closest('.graphical-skill-completion') && event.currentTarget.closest('form')?.contains(target))) setDismissed(true) }}
      onClick={event => { props.onClick?.(event); if (dismissed) setActivation(value => value + 1); setDismissed(false) }}
      onSelect={event => { props.onSelect?.(event); const input = event.currentTarget; setCursor(input.selectionStart === input.selectionEnd ? input.selectionStart : null) }}
      onScroll={event => { props.onScroll?.(event); if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop }}
      onChange={event => { const input = event.target, next = skillCompletion(input.value,input.selectionStart,input.selectionEnd); if (!token || dismissed || next?.start !== token.start) setActivation(value => value + 1); setSelected(0); setDismissed(false); setInsertionError(''); setCursor(input.selectionStart === input.selectionEnd ? input.selectionStart : null); onChange?.(event); draft.set(input.value) }}
      onKeyDown={event => {
        if (wanted && !event.nativeEvent.isComposing) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true); return }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (visible[current]) choose(visible[current]); return }
          if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); const length = visible.length; for (let step = 1; step <= length; step++) { const next = (current + (event.key === 'ArrowDown' ? step : -step) + length) % length; if (!blocked(visible[next])) { setSelected(next); break } } return }
        }
        props.onKeyDown?.(event)
      }} />
  </div>{wanted && host && <SkillCompletionMenu host={host} id={id} skills={visible} selected={current} loading={!ready} error={insertionError || (ready ? catalog.error : '')} warning={ready ? catalog.warning : ''} blocked={blocked} close={() => setDismissed(true)} choose={choose} retry={() => setActivation(value => value + 1)} />}</>
}

export function DraftPasteActionLabel({ draft, extra }: { draft: ChatDraft; extra: number }) {
  const fits = useSyncExternalStore(draft.subscribe, () => draft.read().length + extra <= 64000)
  return fits ? 'Undo conversion' : 'Remove paste'
}
