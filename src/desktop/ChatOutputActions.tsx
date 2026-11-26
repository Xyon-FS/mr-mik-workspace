import AnchoredMenu from './AnchoredMenu'
import { IntermediateOutputContext } from './intermediateOutputContext'
import { useContext, useEffect, useRef, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'
import DarkSelect from './DarkSelect'
import WorkspaceDialog from './WorkspaceDialog'
import { useChatPreviewPin } from './useChatPreviewPin'
import './chat-outputs.css'
import { previewMemory } from './previewMemory'

export type ChatOutputReference = { itemId: string; resultIndex?: number; resultRevision?: string; href?: string; index?: number; kind?: string; message?: boolean }
type Description = { name: string; mode: 'live' | 'snapshot'; revision: string; runtimeId: string; cards: { id: string; title: string }[]; cardId: string | null }

function SaveOutput({ sessionId, reference: initialReference, close: onClose }: { sessionId: string; reference: ChatOutputReference; close: () => void }) {
  const [reference] = useState(() => initialReference)
  const [requestId] = useState(() => crypto.randomUUID())
  const locked = useRef(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  const destination = useRef<HTMLDivElement>(null)
  const [description, setDescription] = useState<Description | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [cardId, setCardId] = useState<string | null>(null), [cardTitle, setCardTitle] = useState(''), [title, setTitle] = useState('')
  const [saved, setSaved] = useState<{ cardId: string; title: string; duplicate: boolean } | null>(null)
  useEffect(() => {
    let closed = false
    void api<Description>(`/sessions/${sessionId}/output`, { ...reference, action: 'describe' }).then(value => {
      if (closed) return
      setDescription(value); setTitle(value.name); setCardTitle(value.name)
      setCardId(value.cards.find(card => card.id === value.cardId)?.id ?? (value.cards.length ? null : ''))
    }, cause => { if (!closed) setError(cause.message) })
    return () => { closed = true }
  }, [sessionId, reference])
  useEffect(() => {
    if (description && document.activeElement === closeButton.current) destination.current?.querySelector('button')?.focus()
  }, [description])
  const save = async () => {
    if (!description || locked.current || cardId === null || !title.trim() || (cardId === '' && !cardTitle.trim())) return
    locked.current = true
    setBusy(true); setError('')
    try { setSaved(await api(`/sessions/${sessionId}/output`, { ...reference, action: 'save', requestId, runtimeId: description.runtimeId, revision: description.revision, cardId: cardId || undefined, cardTitle, title })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { locked.current = false; setBusy(false) }
  }
  return <WorkspaceDialog label="Add to card" className="chat-output-dialog" busy={busy} close={onClose}>
    <header className="settings-dialog-heading"><h3>Add to card</h3><button ref={closeButton} type="button" className="desk-icon" aria-label="Close card dialog" disabled={busy} onClick={onClose}><Icon name="close" size={17} /></button></header>
    {saved ? <>
      <p role="status">{saved.duplicate ? 'Already saved in' : 'Saved in'} “{saved.title}”.</p>
      <footer className="chat-card-save-actions"><button type="button" disabled={busy} onClick={onClose}>Done</button><button type="button" disabled={busy} onClick={() => {
        if (locked.current) return
        locked.current = true; setBusy(true); setError('')
        void api(`/sessions/${sessionId}/output`, { action: 'open-card', cardId: saved.cardId }).then(onClose, cause => {
          setError(cause.message); locked.current = false; setBusy(false)
        })
      }}>Open card in Workspace</button></footer>
    </> : description ? <form className="card-create-dialog" onSubmit={event => { event.preventDefault(); void save() }}>
      <p>{description.mode === 'live' ? 'Link to the latest file contents.' : 'Save a snapshot of this output.'}</p>
      <div className="card-create-fields">
        <div ref={destination} className="chat-card-destination"><span>Destination</span><DarkSelect label="Destination" appearance="workspace" icon="" value={cardId ?? 'unselected'} placeholder="Choose a card" disabled={busy} options={[...description.cards.map(card => ({ value: card.id, label: card.title })), { value: '', label: 'New card…' }]} onChange={setCardId} /></div>
        {cardId === '' && <label>New card title<input required maxLength={160} value={cardTitle} disabled={busy} onChange={event => setCardTitle(event.target.value)} /></label>}
        <label>Output title<input required maxLength={160} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      </div>
      <footer className="card-create-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || cardId === null || !title.trim() || (cardId === '' && !cardTitle.trim())}>{busy ? 'Saving…' : description.mode === 'live' ? 'Link to card' : 'Save note'}</button></footer>
    </form> : !error && <p role="status">Reading output…</p>}
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
  </WorkspaceDialog>
}

export default function ChatOutputActions({ sessionId, reference, preview = false, compact = false, viewIdentity, download }: { sessionId: string; reference: ChatOutputReference; preview?: boolean; compact?: boolean; viewIdentity?: string; image?: boolean; download?: () => void }) {
  const intermediate = useContext(IntermediateOutputContext)
  const [open, setOpen] = useState(false), [menuOpen,setMenuOpen] = useState(false), [error, setError] = useState('')
  const trigger = useRef<HTMLSpanElement>(null)
  const openSave = () => { setError(''); setOpen(true) }
  useChatPreviewPin(open || menuOpen, trigger)
  if (intermediate) return null
  return <span ref={trigger} className={`chat-output-actions${compact ? ' compact' : ''}`}>
    {reference.message ? <button type="button" className="message-add-to-card" aria-haspopup="dialog" onClick={openSave}><Icon name="plus" size={14} />Add to card</button>
    : <AnchoredMenu label="Artifact actions" placement="below" appearance="workspace" onOpenChange={setMenuOpen}>{close => <>
    {preview && <button type="button" aria-label="Open output in Workspace" title="Open in Workspace" onClick={() => { close(); setError(''); void api(`/sessions/${sessionId}/output`, { ...reference, action: 'open', ...(viewIdentity ? { viewState: previewMemory(`image:${viewIdentity}`) } : {}) }).catch(cause => setError(cause.message)) }}><Icon name="external" size={13} />Open in Workspace</button>}
    {download && <button type="button" onClick={() => { close(); download() }}><Icon name="download" size={13} />Download</button>}
    <button type="button" aria-label="Add output to card" onClick={() => { close(); openSave() }}><Icon name="plus" size={13} />Add to card</button>
    </>}</AnchoredMenu>}
    {open && <SaveOutput sessionId={sessionId} reference={reference} close={() => {
      setOpen(false)
      requestAnimationFrame(() => trigger.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }))
    }} />}
    {error && <span role="alert">{error}</span>}
  </span>
}
