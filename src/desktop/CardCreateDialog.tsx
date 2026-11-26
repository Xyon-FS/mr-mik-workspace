import { useState } from 'react'
import { CARD_CATEGORIES } from '../lib/categories'
import { api } from './client'
import type { Project } from './types'
import DarkSelect from './DarkSelect'
import WorkspaceDialog from './WorkspaceDialog'

export default function CardCreateDialog({ project, onClose, onCreated }: {
  project?: Project
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('other')
  const [repositoryId, setRepositoryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const card = await api<{ id: string }>('/cards', { projectId: project?.id || null, repositoryId: repositoryId || null, title, description, category })
      onCreated(card.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <WorkspaceDialog label="New card" busy={busy} close={onClose}>
    <form className="card-create-dialog" onSubmit={event => void create(event)}>
      <h3 id="card-create-title">New card</h3>
      <p>A card collects pages, notes and media in Mr. Mik. It does not add files to a linked project.</p>
      <div className="card-create-fields">
        <label>Workspace<span>{project?.name || 'Mr. Mik Hub · Global'}</span></label>
        <label>Card title<input autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Unity development" /></label>
        <label>Category<DarkSelect appearance="workspace" icon="" label="Card category" value={category} options={CARD_CATEGORIES.map(item => ({ value: item.value, label: item.label }))} onChange={setCategory} /></label>
        {project && <label><span className="card-create-label">Linked project for new chats <small>(optional)</small></span><DarkSelect appearance="workspace" icon="" label="Card linked project" value={repositoryId} options={[{ value: '', label: 'None · workspace-wide card' }, ...project.repositories.map(item => ({ value: item.id, label: item.name, disabled: !item.available }))]} onChange={setRepositoryId} /></label>}
        <label><span className="card-create-label">Description <small>(optional)</small></span><textarea maxLength={2000} rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="What will this card collect?" /></label>
      </div>
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      <footer className="card-create-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !title.trim()}>Create card</button></footer>
    </form>
  </WorkspaceDialog>
}
