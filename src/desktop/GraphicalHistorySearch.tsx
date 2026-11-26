import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client'
import type { HistoryWindow } from './useGraphicalReading'
import { Icon } from './Icons'

type Hit = { id: string; type: string; snippet: string }
type Search = { runtimeId: string; searchId: string; query: string; results: Hit[]; scanned: number; complete: boolean; hasMore: boolean }
export default function GraphicalHistorySearch({ responseLabel = 'Codex', sessionId, runtimeId, query, change, reveal, close }: { responseLabel?: string; sessionId: string; runtimeId?: string; query: string; change: (value: string) => void; reveal: (page: HistoryWindow & { anchorId: string }) => boolean; close: () => void }) {
  const [pages, setPages] = useState<Hit[][]>([]), [page, setPage] = useState(0), [offset, setOffset] = useState(0)
  const [result, setResult] = useState<Search | null>(null), [busy, setBusy] = useState(false), [opening, setOpening] = useState(''), [error, setError] = useState('')
  const epoch = useRef({ value: 0 }), search = useRef<Search | null>(null), field = useRef<HTMLInputElement>(null), cached = useRef<Hit[][]>([])
  const run = useCallback(async (value: string, continuation = false) => {
    const version = ++epoch.current.value
    setOpening(''); setError('')
    if (!continuation) { cached.current = []; search.current = null; setPages([]); setResult(null); setPage(0); setOffset(0) }
    if (!value.trim() || !runtimeId) { setBusy(false); return }
    setBusy(true); let current = continuation ? search.current : null
    const hits: Hit[] = []; let failed = false
    try {
      for (let step = 0; step < 5; step++) {
        const next: Search = await api<Search>(`/sessions/${sessionId}/chat`, { action: 'search-history', runtimeId, query: value, ...(current ? { searchId: current.searchId } : {}), limit: 50 - hits.length })
        if (version !== epoch.current.value || next.runtimeId !== runtimeId) return
        hits.push(...next.results); current = next; search.current = next; setResult(next)
        if (next.complete || hits.length >= 50) break
      }
    } catch (cause) { failed = true; if (version === epoch.current.value) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally {
      if (version === epoch.current.value) {
        if (!failed || hits.length) {
          const all = continuation ? [...cached.current, hits] : [hits], dropped = Math.max(0, all.length - 5)
          cached.current = all.slice(-5); setPages(cached.current); setPage(cached.current.length - 1); if (dropped) setOffset(value => value + dropped)
        }
        setBusy(false)
      }
    }
  }, [sessionId, runtimeId])
  useEffect(() => {
    const clock = epoch.current
    const timer = window.setTimeout(() => { void run(query) }, 400)
    return () => { clearTimeout(timer); clock.value++ }
  }, [query, run])
  const open = async (hit: Hit) => {
    const version = epoch.current.value, current = search.current; if (!current) return
    setOpening(hit.id); setError('')
    try {
      const window = await api<HistoryWindow & { anchorId: string }>(`/sessions/${sessionId}/chat`, { action: 'search-open', runtimeId, searchId: current.searchId, itemId: hit.id })
      if (epoch.current.value !== version || window.runtimeId !== runtimeId) return
      if (!reveal(window)) throw new Error('The conversation changed. Search again.')
    } catch (cause) { if (epoch.current.value === version) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (epoch.current.value === version) setOpening('') }
  }
  const hits = result?.query === query.trim() ? pages[page] || [] : []
  const visible = result?.query === query.trim() ? result : null
  return <div className="graphical-search graphical-history-search" role="search" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } else if (event.key === 'Enter' && event.target === field.current) { event.preventDefault(); if (!busy) void run(query) } }}>
    <Icon name="search" size={15} /><input ref={field} autoFocus aria-label="Search conversation" placeholder="Search entire conversation…" value={query} maxLength={200} onChange={event => { epoch.current.value++; setOpening(''); setError(''); setBusy(!!event.target.value.trim()); change(event.target.value) }} />
    <button type="button" className="desk-icon" aria-label="Search again" title="Search again, including new messages" disabled={busy || !query.trim()} onClick={() => void run(query)}><Icon name="history" size={15} /></button>
    <button type="button" className="desk-icon" aria-label="Close conversation search" onClick={close}><Icon name="close" size={14} /></button>
    <small role="status">{busy ? 'Searching…' : visible ? `${visible.complete ? 'Search complete' : 'Search incomplete'} · ${hits.length} ${hits.length === 1 ? 'match' : 'matches'}${hits.length ? ` · results page ${offset + page + 1}` : ''}` : 'Search messages and activity'}</small>
    {error && <p role="alert">{error} <button type="button" disabled={busy} onClick={() => void run(query)}>Retry search</button></p>}
    {!!hits.length && <ol className="graphical-search-results" aria-label="History search results">{hits.map(hit => <li key={hit.id}><button type="button" disabled={!!opening || busy} onClick={() => void open(hit)}><small>{hit.type === 'userMessage' ? 'You' : hit.type === 'agentMessage' ? responseLabel : 'Activity'}</small><span>{hit.snippet}</span>{opening === hit.id && <small>Opening…</small>}</button></li>)}</ol>}
    {!busy && visible?.complete && !hits.length && !error && <p className="graphical-search-empty">No matches in saved history.</p>}
    {!busy && !error && visible && !!pages.length && (page > 0 || page < pages.length - 1 || visible.hasMore) && <div className="graphical-search-pages"><button type="button" disabled={page === 0} title={offset > 0 && page === 0 ? 'Search again to return to earlier results.' : 'Previous results'} onClick={() => setPage(value => value - 1)}>Previous</button><button type="button" onClick={() => { if (page < pages.length - 1) setPage(value => value + 1); else void run(query, true) }}>{page < pages.length - 1 ? 'Next results' : hits.length ? 'Search older history' : 'Continue search'}</button></div>}
  </div>
}
