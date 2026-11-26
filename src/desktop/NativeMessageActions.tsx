import { useEffect, useRef, useState } from 'react'
import { api, reportError, selectChat, desktopState } from './client'
import NativeControlsPanel from './NativeControlsPanel'
import { messageActionRequest, completeMessageAction } from './messageActionRequest'
type Catalog = { offset: number; total: number; hasMore: boolean; launchId: string; revision: string; messages: { id: string; role: string; preview: string }[] }
export default function NativeMessageActions({ id, disabled }: { id: string; disabled: boolean }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<Catalog | null>(null), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [contextLaunchId, setContextLaunchId] = useState(''), [selectorLabel, setSelectorLabel] = useState('Open native skills and commands')
  const [query, setQuery] = useState('')
  const epoch = useRef(0)
  useEffect(() => () => { epoch.current++ }, [])
  const load = async (value = query, offset = 0) => {
    const version = ++epoch.current
    setOpen(true); setBusy(true); setError(''); setData(null)
    try { const context = await api<{ launchId: string; hasConversation: boolean; selectorLabel: string }>(`/sessions/${id}/nativecontext`); if (version !== epoch.current) return; setContextLaunchId(context.launchId); setSelectorLabel(context.selectorLabel); if (!context.hasConversation) return; const result = await api<Catalog>(`/sessions/${id}/nativemessageactions?query=${encodeURIComponent(value)}&offset=${offset}`); if (version !== epoch.current) return; setData(result); setSelected(result.messages[result.messages.length - 1]?.id || '') }
    catch (cause) { if (version === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (version === epoch.current) setBusy(false) }
  }
  const act = async (kind: string) => {
    if (!data || busy) return
    const version = epoch.current
    setBusy(true); setError('')
    try {
      const requestId = messageActionRequest(id, selected, kind)
      const result = await api<{ session: { id: string }; notice: string }>(`/sessions/${id}/messageaction`, { kind, itemId: selected, requestId, launchId: data.launchId, revision: data.revision })
      completeMessageAction(id, selected, kind, requestId)
      if (version === epoch.current && desktopState().selectedId === id) { selectChat(result.session.id); if (result.notice) reportError(result.notice) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const context = async (action: string) => {
    if (!contextLaunchId || busy) return
    setBusy(true); setError('')
    try { await api(`/sessions/${id}/nativecontext`, { action, launchId: contextLaunchId }); setOpen(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const row = data?.messages.find(message => message.id === selected)
  return <div className="native-message-actions"><button type="button" disabled={disabled || busy} onClick={() => { if (open) setOpen(false); else void load() }}>Message actions</button>{open && <section className="native-message-actions-panel" aria-label="OpenCode message actions">
    <strong>Native conversation tools</strong><p>Choose skill commands in the native terminal, or prepare a project reference. These actions never submit a message.</p><div className="graphical-actions"><button type="button" disabled={busy || !contextLaunchId} onClick={() => void context('selector')}>{selectorLabel}</button><button type="button" disabled={busy || !contextLaunchId} onClick={() => void context('working-project')}>Prepare working project reference</button></div><form onSubmit={event => { event.preventDefault(); void load(query) }}><input aria-label="Search native conversation" placeholder="Search all native messages…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /><button type="submit" disabled={busy}>Search history</button></form><p>The original conversation and current working files are preserved.</p>
    {contextLaunchId && !busy && <NativeControlsPanel key={contextLaunchId} id={id} launchId={contextLaunchId} close={() => setOpen(false)} />}
    {data && <><p role="status">{data.total} matching messages · latest first pages</p><div><button disabled={busy || !data.offset} onClick={() => void load(query, Math.max(0, data.offset - 100))}>Newer messages</button><button disabled={busy || !data.hasMore} onClick={() => void load(query, data.offset + 100)}>Older messages</button></div><label>Message<select aria-label="Native message" disabled={busy} value={selected} onChange={event => setSelected(event.target.value)}>{data.messages.map(message => <option key={message.id} value={message.id}>{message.role === 'user' ? 'You' : 'OpenCode'}: {message.preview || '(tool activity)'}</option>)}</select></label><div className="graphical-actions"><button disabled={busy || row?.role !== 'assistant'} onClick={() => void act('branch')}>Branch after response</button><button disabled={busy || row?.role !== 'user'} onClick={() => void act('edit')}>Edit and branch</button><button disabled={busy || row?.role !== 'assistant'} onClick={() => void act('retry')}>Retry in new branch</button></div></>}
    {busy && <p role="status">Verifying native conversation…</p>}{error && <p role="alert">{error}</p>}<button disabled={busy} onClick={() => setOpen(false)}>Close actions</button>
  </section>}</div>
}
