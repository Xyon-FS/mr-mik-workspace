import { useEffect, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'
import type { Folder } from './types'
import WorkspaceDialog from './WorkspaceDialog'
import './chat-attachments.css'

function FilePicker({ directory, disabled, attach, close }: { directory: string; disabled: boolean; attach: (paths: string[]) => Promise<void>; close: () => void }) {
  const [location, setLocation] = useState(directory)
  const [target, setTarget] = useState({ path: directory })
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<{ target: typeof target; query: string; folder?: Folder; error?: string }>()
  const [selected, setSelected] = useState(new Set<string>())
  const [attaching, setAttaching] = useState(false)
  const [failure, setFailure] = useState('')
  const current = listing?.target === target ? listing : undefined
  const folder = current?.folder
  const loading = !current || current.query !== query

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ path: target.path, mode: 'all', q: query.trim() })
      void api<Folder>(`/files?${params}`).then(folder => {
        if (active) setListing({ target, query, folder })
      }, cause => {
        if (active) setListing({ target, query, error: cause instanceof Error ? cause.message : String(cause) })
      })
    }, query ? 180 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [target, query])

  const browse = (path: string) => {
    if (!path.trim()) return
    setTarget({ path: path.trim() }); setLocation(path.trim()); setQuery(''); setFailure('')
  }
  const toggle = (path: string) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const confirm = async () => {
    if (attaching || disabled || !selected.size) return
    setAttaching(true); setFailure('')
    try { await attach([...selected]); close() }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)) }
    finally { setAttaching(false) }
  }
  return <WorkspaceDialog label="Attach files and folders" className="chat-file-picker" close={close} busy={attaching}>
    <h3>Attach files and folders</h3>
    <form className="chat-picker-location" onSubmit={event => { event.preventDefault(); browse(location) }}>
      <button type="button" className="desk-icon" aria-label="Parent folder" title="Parent folder" disabled={attaching || !folder || folder.path === folder.parent} onClick={() => { if (folder) browse(folder.parent) }}><Icon name="up" size={16} /></button>
      <input aria-label="Folder path" value={location} disabled={attaching} onChange={event => setLocation(event.target.value)} />
      <button type="submit" className="desk-secondary" disabled={attaching || !location.trim()}>Go</button>
    </form>
    <input className="chat-picker-filter" aria-label="Filter folder contents" placeholder="Filter by name…" value={query} disabled={attaching || !folder && !loading} onChange={event => setQuery(event.target.value)} />
    <section className="chat-picker-list" role="group" aria-label="Folder contents" aria-busy={loading}>
      {folder && <label className="chat-picker-row chat-picker-current"><input type="checkbox" checked={selected.has(folder.path)} disabled={attaching} onChange={() => toggle(folder.path)} /><Icon name="folder" size={17} /><span>Attach this folder</span></label>}
      {loading ? <p role="status">Loading folder…</p> : current?.error ? <p role="alert">{current.error}</p> : folder?.entries.length ? folder.entries.map(entry => <div className="chat-picker-row" key={entry.path}>
        <label><input type="checkbox" checked={selected.has(entry.path)} disabled={attaching} onChange={() => toggle(entry.path)} /><Icon name={entry.directory ? 'folder' : 'files'} size={17} /><span title={entry.name}>{entry.name}</span></label>
        {entry.directory && <button type="button" className="desk-icon" aria-label={`Open folder ${entry.name}`} title="Browse this folder" disabled={attaching} onClick={() => browse(entry.path)}><Icon name="arrow" size={14} /></button>}
      </div>) : <p>{query.trim() ? 'No matching files or folders.' : 'This folder is empty.'}</p>}
      {!loading && folder?.truncated && <p role="status">Use the name filter to find more items.</p>}
    </section>
    {failure && <p role="alert">{failure}</p>}
    <footer className="chat-picker-actions">
      <span role="status">{selected.size} selected</span>
      <button type="button" className="desk-secondary" disabled={attaching} onClick={close}>Cancel</button>
      <button type="button" className="desk-primary" disabled={attaching || disabled || !selected.size} onClick={() => void confirm()}>{attaching ? 'Attaching…' : 'Attach selected'}</button>
    </footer>
  </WorkspaceDialog>
}

export default function ChatFilePicker({ directory, disabled, attach, focus }: { directory: string; disabled: boolean; attach: (paths: string[]) => Promise<void>; focus: () => void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = () => { if (!disabled) setOpen(true) }
    window.addEventListener('mrmak-attach-file', show)
    return () => window.removeEventListener('mrmak-attach-file', show)
  }, [disabled])
  const close = () => { setOpen(false); requestAnimationFrame(focus) }
  return open ? <FilePicker directory={directory} disabled={disabled} attach={attach} close={close} /> : null
}
