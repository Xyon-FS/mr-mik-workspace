import { GraphicalImage } from './GraphicalAssets'
import { ToolResourceCard } from './GraphicalToolResults'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './client'
import { Icon } from './Icons'
import ChatOutputActions from './ChatOutputActions'

type Result = { itemId: string; revision: string; index: number; type: 'code' | 'file' | 'message' | 'asset'; runtimeId?: string; resourceIndex?: number; resource?: {kind:string;name:string;mimeType:string;text?:string;available:boolean}; mediaKind?: string; title: string; language?: string; href?: string }
type Page = { runtimeId: string; results: Result[]; beforeId: string | null; cursor: string | null; hasOlder: boolean }
export default function ConversationOutputBrowser({ sessionId, close }: { sessionId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), loading = useRef(false), page = useRef<Page | null>(null)
  const [results, setResults] = useState<Result[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [opening, setOpening] = useState('')
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [older, setOlder] = useState(false), [selected, setSelected] = useState<Result | null>(null)
  const dismiss = () => { dialog.current?.close(); close() }
  const load = useCallback(async (append = false) => {
    if (loading.current) return
    loading.current = true; setBusy(true); setError('')
    try {
      const previous = page.current
      const next = await api<Page>(`/sessions/${sessionId}/results`, append && previous ? { beforeId: previous.beforeId, cursor: previous.cursor, runtimeId: previous.runtimeId } : {})
      if (!active.current) return
      page.current = next; setOlder(next.hasOlder)
      setResults(current => append ? [...current, ...next.results].filter((value, index, all) => all.findIndex(other => other.itemId === value.itemId && other.index === value.index) === index).slice(0, 1000) : next.results)
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { loading.current = false; if (active.current) setBusy(false) }
  }, [sessionId])
  useEffect(() => {
    active.current = true; const element = dialog.current!; element.showModal(); element.querySelector('input')?.focus()
    return () => { active.current = false; element.close() }
  }, [])
  useEffect(() => { void load() }, [load])
  const view = async (result: Result) => {
    if (opening) return
    setOpening(`${result.itemId}:${result.index}`); setError('')
    try {
      if (result.type === 'asset') { const verified = await api<{resource?:Result['resource']}>(`/sessions/${sessionId}/results`, { action: 'verify', ...result, runtimeId: page.current?.runtimeId }); setSelected({...result,resource:verified.resource,runtimeId:page.current?.runtimeId}) }
      else if (result.type === 'file') await api(`/sessions/${sessionId}/chat`, { action: 'open-file', href: result.href, runtimeId: page.current?.runtimeId })
      else await api(`/sessions/${sessionId}/results`, { action: 'open', ...result, runtimeId: page.current?.runtimeId })
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (active.current) setOpening('') }
  }
  const visible = results.filter(result => (filter === 'all' || result.type === filter) && `${result.title} ${result.language || ''}`.toLowerCase().includes(query.toLowerCase()))
  return createPortal(<dialog ref={dialog} className="conversation-output-browser" aria-label="Conversation outputs" onCancel={event => { event.preventDefault(); dismiss() }} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <header><strong>Conversation outputs</strong><button type="button" className="desk-icon" aria-label="Close conversation outputs" onClick={dismiss}><Icon name="close" size={16} /></button></header>
    <div className="output-browser-search"><Icon name="search" size={15} /><input autoFocus aria-label="Filter conversation outputs" placeholder="Search outputs…" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" className="desk-icon" aria-label="Refresh outputs" title="Refresh outputs" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={15} /></button></div>
    <nav aria-label="Output type">{[['all','All'],['code','Code'],['asset','Resources'],['message','Responses']].map(([value,label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</nav>
    <div className="output-browser-list" aria-busy={busy}>{visible.map(result => <article key={`${result.itemId}:${result.index}`}><Icon name={result.type === 'code' ? 'code' : result.type === 'asset' ? result.mediaKind === 'image' ? 'image' : 'files' : result.type === 'file' ? 'files' : 'chats'} size={17} /><button type="button" className="output-browser-open" title={result.type === 'asset' ? 'Inspect output' : 'Open in Workspace'} aria-label={`Open ${result.title}`} disabled={!!opening} onClick={() => void view(result)}><strong>{result.title}</strong><small>{result.language || (result.mediaKind || (result.type === 'file' ? 'File' : 'Response'))}</small></button>{result.type !== 'asset' && <ChatOutputActions compact sessionId={sessionId} reference={{ itemId: result.itemId, ...(result.href ? { href: result.href } : result.type === 'code' ? { resultIndex: result.index, resultRevision: result.revision } : { message: true }) }} />}</article>)}</div>
    {selected && <section className="output-browser-preview" aria-label="Selected output"><header><small>Preview</small><button type="button" className="desk-icon" aria-label="Close selected output" onClick={() => setSelected(null)}><Icon name="close" size={15} /></button></header>{selected.resourceIndex == null ? <GraphicalImage key={`${selected.itemId}:${selected.revision}`} id={sessionId} itemId={selected.itemId} version={selected.revision} resultRevision={selected.revision} runtimeId={selected.runtimeId} /> : <ToolResourceCard key={`${selected.itemId}:${selected.index}:${selected.revision}`} sessionId={sessionId} itemId={selected.itemId} index={selected.resourceIndex} resultRevision={selected.revision} runtimeId={selected.runtimeId} resource={selected.resource || {kind:selected.mediaKind || 'file',name:selected.title,mimeType:'',available:true}} />}</section>}
    {busy && <p role="status">Reading outputs…</p>}{!busy && !visible.length && <p>{results.length ? 'No matching outputs.' : 'No outputs in the loaded history.'}</p>}
    {older && <button type="button" className="output-browser-older" disabled={busy} onClick={() => void load(true)}>Load earlier outputs</button>}
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
  </dialog>, document.body)
}
