import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceEntity } from '../types'
import { api, reportError } from './client'
import { Icon } from './Icons'

export default function CardActions({ entity, children }: { entity: WorkspaceEntity; children?: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('click', close); window.addEventListener('keydown', key); window.addEventListener('resize', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); window.removeEventListener('resize', close) }
  }, [menu])
  const remove = async () => {
    setBusy(true); setError('')
    try {
      const result = await api<{ warnings?: string[] }>('/cards/delete', { id: entity.id, confirm: true })
      setConfirm(false)
      if (decodeURIComponent(location.hash).includes(entity.id)) location.hash = ''
      if (result.warnings?.length) reportError(result.warnings.join(' '))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <div className="card-actions-wrap" onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }) }}>
    {children}
    <button className="card-actions-trigger desk-icon" title="Card actions" aria-label={`Actions for card ${entity.title}`} onClick={event => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom }) }}><Icon name="more" size={16} /></button>
    {menu && createPortal(<div className="file-context-menu card-actions-menu" role="menu" style={{ left: Math.max(8, Math.min(menu.x, innerWidth - 190)), top: Math.max(8, Math.min(menu.y, innerHeight - 100)) }}>
      <button role="menuitem" onClick={() => void api('/cards/status', { id: entity.id, status: entity.status === 'archived' ? 'active' : 'archived' }).catch(reportError)}><Icon name={entity.status === 'archived' ? 'refresh' : 'archive'} size={16} />{entity.status === 'archived' ? 'Restore card' : 'Archive card'}</button>
      <button role="menuitem" className="danger" onClick={() => { setError(''); setConfirm(true) }}><Icon name="trash" size={16} />Delete card…</button>
    </div>, document.body)}
    {confirm && createPortal(<div className="file-confirm-backdrop"><div className="file-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`delete-card-${entity.id}`}>
      <h3 id={`delete-card-${entity.id}`}>Delete “{entity.title}”?</h3>
      <p>Remove this card from Mr. Mik and move its Hub content folder to the Windows Recycle Bin. External project folders and native conversations are not deleted. Close this card’s chats first.</p>
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      <div><button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button className="danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Delete card'}</button></div>
    </div></div>, document.body)}
  </div>
}
