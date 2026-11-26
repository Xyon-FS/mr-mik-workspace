import { useEffect, useRef, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'
import type { ComposerContext } from '../../desktop/service/graphical-composer.mjs'

export function MessageQuote({ item, source, remove }: { item: Extract<ComposerContext, { type: 'quote' }>; source?: (id: string) => void; remove?: () => void }) {
  const browser = !!item.sourceUrl || item.itemId.startsWith('browser:')
  return <div className="graphical-message-quote">
    <Icon name="quote" size={14} />
    <details>
      <summary>
        <span className="graphical-quote-label">{browser ? 'Browser selection' : item.inspection ? 'Selected changes' : item.role === 'assistant' ? 'Quoted response' : 'Quoted message'}</span>
        <span className="graphical-quote-excerpt">{item.text}</span>
        <Icon name="arrow" size={12} />
      </summary>
      <blockquote>{item.text}</blockquote>
      {item.sourceUrl ? <a className="graphical-quote-source" href={item.sourceUrl} target="_blank" rel="noreferrer">Source page</a> : !browser && source && <button type="button" className="graphical-quote-source" onClick={() => source(item.itemId)}>View source</button>}
    </details>
    {remove && <button type="button" className="graphical-quote-remove" aria-label="Remove quote" title="Remove quote" onClick={remove}><Icon name="close" size={14} /></button>}
  </div>
}

export function ComposerContextChips({ items, remove, source, sessionId }: { sessionId?: string; items: ComposerContext[]; remove: (id: string) => void; source: (id: string) => void }) {
  const [error, setError] = useState('')
  return items.length ? <div className="graphical-context-chips" aria-label="Prompt context">{items.map(item => {
    if (item.type === 'skill') return <div key={item.id} className="graphical-inline-skill"><strong className="chat-skill-mention" title={item.path}>${item.name}</strong><button type="button" aria-label={`Remove skill ${item.name}`} onClick={() => remove(item.id)}>×</button></div>
    if (!item.sourceUrl && !item.inspection) return <MessageQuote key={item.id} item={item} source={source} remove={() => remove(item.id)} />
    return <div key={item.id} className="graphical-context-chip">
      <details>
        <summary title={item.text}>{item.text.slice(0, 60)}{item.text.length > 60 ? '…' : ''}</summary>
        {item.sourceUrl && sessionId ? <textarea aria-label="Browser note" defaultValue={item.text} maxLength={8000} onBlur={event => { if (event.target.value !== item.text) void api(`/sessions/${sessionId}/contextedit`, { id: item.id, text: event.target.value }).then(() => setError(''), cause => setError(cause.message)) }} /> : <blockquote>{item.text}</blockquote>}
        {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">Source page</a> : <button type="button" onClick={() => { if (sessionId) void api(`/inspector/${sessionId}`, { action: 'show', itemId: item.itemId }).catch(cause => setError(cause.message)) }}>View source</button>}
      </details>
      <button type="button" aria-label="Remove quote" onClick={() => remove(item.id)}>×</button>
    </div>
  })}{error && <p role="alert">{error}</p>}</div> : null
}

export default function GraphicalComposerMenu({ sessionId, disabled, chooseSkill, focus, skillsAvailable = true, runtimeId }: { sessionId: string; disabled: boolean; chooseSkill: (name: string) => void; focus: () => void; skillsAvailable?: boolean; runtimeId?: string }) {
  const menu = useRef<HTMLDetailsElement>(null)
  const [section, setSection] = useState('root'), [skills, setSkills] = useState<{ name: string; path: string; description: string }[]>([]), [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [warning, setWarning] = useState('')
  const close = () => { if (menu.current) menu.current.open = false }
  useEffect(() => {
    const outside = (event: Event) => { const target = event.target as HTMLElement; if (!menu.current?.contains(target) && !target.closest?.('[role="listbox"]')) { if (menu.current) menu.current.open = false } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus() } }
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [])
  const load = async () => {
    setSection('skills'); setLoading(true); setError('')
    try { const result = await api<{ skills: typeof skills; warnings: string }>(`/sessions/${sessionId}/chat`, { action: 'skills', runtimeId }); setSkills(result.skills); setWarning(result.warnings) }
    catch (cause) { setSkills([]); setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }
  const filteredSkills = skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  return <details ref={menu} className="graphical-context-menu" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation() } }} onToggle={event => { if (!event.currentTarget.open) { setSection('root'); setQuery('') } }}>
    <summary aria-label="Add context" title={skillsAvailable ? 'Add files, folders or skills' : 'Add files or folders'} onClick={event => { if (disabled) event.preventDefault() }} aria-disabled={disabled}><Icon name="plus" size={18} /></summary>
    <div className="graphical-context-panel">{section === 'root' ? <>
      <strong className="graphical-context-heading">Add to prompt</strong>
      <button type="button" disabled={disabled} onClick={() => { close(); window.dispatchEvent(new Event('mrmak-attach-file')) }}><Icon name="attach" size={16} /><span>File or folder reference</span></button>
      {skillsAvailable && <button type="button" disabled={disabled} onClick={() => void load()}><Icon name="skills" size={16} /><span>Choose a skill</span><Icon name="arrow" size={13} /></button>}
    </> : <>
      <header><button type="button" aria-label="Back to context menu" onClick={() => setSection('root')}><Icon name="back" size={16} /></button><strong>Skills</strong></header>
      <input aria-label="Find a skill" placeholder="Find a skill…" value={query} onChange={event => setQuery(event.target.value)} />
      {loading ? <p role="status">Loading available skills…</p> : <div className="graphical-skill-list">{filteredSkills.map(skill => <button key={skill.path} type="button" disabled={disabled || loading} title={skill.path} onClick={() => { try { chooseSkill(skill.name); close(); focus() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }}><strong>{skill.name}</strong><small>{skill.description}</small></button>)}{!skills.length && !error && <p>No enabled skills are available for this chat.</p>}{!!skills.length && !filteredSkills.length && !error && <p role="status">No skills match your search.</p>}</div>}
      {warning && <p role="status">{warning}</p>}{error && <p role="alert">{error}</p>}
      <button type="button" disabled={loading} onClick={() => void load()}><Icon name="refresh" size={15} /><span>Refresh skills</span></button>
    </>}</div>
  </details>
}
