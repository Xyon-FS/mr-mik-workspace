import { useEffect, useState } from 'react'
import { api, pickFiles, reportError, useDesktop, onServiceEvent } from './client'
import type { Project } from './types'
import type { WorkspaceEntity } from '../types'
import { Icon } from './Icons'
import CardCreateDialog from './CardCreateDialog'
import DarkSelect from './DarkSelect'
import './hub-rail.css'

export default function ProjectsPanel({ onClose, onSelect }: { onClose: () => void; onSelect: () => void }) {
  const { projects, settings } = useDesktop()
  const [name, setName] = useState(''), [folder, setFolder] = useState(''), [editing, setEditing] = useState('')
  const [cardId, setCardId] = useState(''), [cards, setCards] = useState<WorkspaceEntity[]>([])
  const [removeTarget, setRemoveTarget] = useState('')
  const [removeRepositoryTarget, setRemoveRepositoryTarget] = useState('')
  const [replacementId, setReplacementId] = useState('')
  const [cardAction, setCardAction] = useState('keep')
  const [creatingCard, setCreatingCard] = useState(false)
  const [repositoryName, setRepositoryName] = useState(''), [repositoryFolder, setRepositoryFolder] = useState(''), [repositoryEditing, setRepositoryEditing] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const refresh = () => { void api<{ entities: WorkspaceEntity[] }>('/workspace').then(value => setCards(value.entities)).catch(reportError) }
    refresh(); return onServiceEvent(event => { if (['projects-changed', 'workspace-changed'].includes(event.type)) refresh() })
  }, [])
  const reviewCards = async (workspaceId: string, repositoryId?: string) => {
    setError(''); setCardAction('keep'); setReplacementId('')
    try { const value = await api<{ entities: WorkspaceEntity[] }>('/workspace'); setCards(value.entities); if (repositoryId) setRemoveRepositoryTarget(repositoryId); else setRemoveTarget(workspaceId) }
    catch (cause) { reportError(cause) }
  }
  const choose = (id: string) => api('/settings', { selectedProjectId: id || null }).then(() => { window.location.hash = ''; onSelect() }).catch(reportError)
  const save = async () => {
    setBusy(true); setError('')
    try {
      const project = await api<Project>('/projects', { id: editing || undefined, name, repositoryPath: folder })
      if (cardId) await api('/cards/assign', { id: cardId, projectId: project.id })
      setName(''); setFolder(''); setCardId(''); setEditing(''); await choose(project.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const edit = (project: Project) => { setEditing(project.id); setName(project.name); setFolder(project.repositoryPath || ''); setCardId('') }
  const addExample = async () => {
    setBusy(true); setError('')
    try { const result = await api<{ projectId: string }>('/projects/example', {}); await choose(result.projectId) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const saveRepository = async () => {
    setBusy(true); setError('')
    try { await api('/projects/repositories', { projectId: editing, id: repositoryEditing || undefined, name: repositoryName, repositoryPath: repositoryFolder }); setRepositoryEditing(''); setRepositoryName(''); setRepositoryFolder('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!removeTarget) return
    setBusy(true); setError('')
    try {
      const result = await api<{ warnings?: string[] }>(`/projects/${removeTarget}`, { cardAction, expectedCardIds: affectedCards.map(card => card.id) }, 'DELETE')
      if (result.warnings?.length) reportError(result.warnings.join(' '))
      if (settings.selectedProjectId === removeTarget) await choose('')
      setEditing(''); setName(''); setFolder(''); setRemoveTarget('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const removeLinkedProject = async () => {
    if (!editing || !removeRepositoryTarget) return
    setBusy(true); setError('')
    try {
      const result = await api<{ warnings?: string[] }>('/projects/repositories/remove', { projectId: editing, repositoryId: removeRepositoryTarget, replacementId: replacementId || null, cardAction, expectedCardIds: affectedCards.map(card => card.id) })
      if (result.warnings?.length) reportError(result.warnings.join(' '))
      if (repositoryEditing === removeRepositoryTarget) { setRepositoryEditing(''); setRepositoryName(''); setRepositoryFolder('') }
      setRemoveRepositoryTarget(''); setReplacementId(''); onSelect()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const editedProject = projects.find(project => project.id === editing)
  const removingRepository = editedProject?.repositories.find(repository => repository.id === removeRepositoryTarget)
  const removingMain = editedProject?.repositories[0]?.id === removeRepositoryTarget
  const affectedCards = cards.filter(card => removeTarget ? card.projectId === removeTarget : card.projectId === editing && card.repositoryId === removeRepositoryTarget)
  const cardChoices = <section className="card-choice"><span>{affectedCards.length} affected card{affectedCards.length === 1 ? '' : 's'}</span>
    {affectedCards.length > 0 && <><ul>{affectedCards.map(card => <li key={card.id}>{card.title}</li>)}</ul><DarkSelect label="What to do with these cards" value={cardAction} disabled={busy} options={[{ value: 'keep', label: removeTarget ? 'Keep in Global Hub' : 'Keep in this workspace' }, { value: 'archive', label: 'Archive cards' }, { value: 'delete', label: 'Delete cards · Recycle Bin' }]} onChange={setCardAction} /><p>{cardAction === 'delete' ? 'Card entries are removed; only their Hub content folders go to the Recycle Bin.' : removeTarget ? 'Retained cards move to Global Hub. Archived cards can be restored from Archive.' : 'Retained cards lose this linked project association. Archived cards can be restored from Archive.'}</p></>}
  </section>
  return <div className="files-panel hub-panel"><header><h2>Workspaces</h2><button className="desk-icon" onClick={onClose} aria-label="Close Workspaces"><Icon name="close" size={17} /></button></header>
    <div className="hub-panel-scroll">
      <p className="hub-help">A workspace organizes cards and optional linked projects. Git is optional; Hub content stays in Mr. Mik.</p>
      <button className="hub-quiet" disabled={busy} onClick={() => void addExample()}><Icon name="plus" size={13} /> Add example workspace</button>
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      <div className="hub-project-list"><button className={!settings.selectedProjectId ? 'selected' : ''} onClick={() => void choose('')}>Mr. Mik Hub <small>Shared content</small></button>{projects.map(project => <div className="hub-project-row" key={project.id}><button className={settings.selectedProjectId === project.id ? 'selected' : ''} onClick={() => void choose(project.id)}>{project.name}<small>{!project.repositories.length ? 'Hub only · no linked folders' : project.available ? 'Available' : 'Relink required'}</small></button><button className="desk-icon" onClick={() => edit(project)} title={`Edit ${project.name}`} aria-label={`Edit ${project.name}`}><Icon name="settings" size={15} /></button></div>)}</div>
      <button className="hub-action hub-card-entry" onClick={() => setCreatingCard(true)}><Icon name="plus" size={14} />Create card in {projects.find(project => project.id === settings.selectedProjectId)?.name || 'Global Hub'}</button>
      {editing && <section className="hub-repositories"><h3>Linked projects</h3>{editedProject?.repositories.map(repository => <div className="hub-project-row" key={repository.id}><span>{repository.name}<small>{repository.repositoryPath || 'Missing folder'}</small></span><button className="desk-icon" title={`Edit ${repository.name}`} aria-label={`Edit linked project ${repository.name}`} onClick={() => { setRepositoryEditing(repository.id); setRepositoryName(repository.name); setRepositoryFolder(repository.repositoryPath || '') }}><Icon name="settings" size={15} /></button><button className="desk-icon hub-unlink" disabled={editedProject.repositories.length < 2} title={editedProject.repositories.length < 2 ? 'Add another linked project before unlinking this one' : `Unlink ${repository.name}`} aria-label={`Unlink ${repository.name}`} onClick={() => void reviewCards(editing, repository.id)}><Icon name="close" size={14} /></button></div>)}{editedProject?.repositories.length === 1 && <p className="hub-help">Add another linked project before unlinking the only one.</p>}<form className="hub-form" onSubmit={event => { event.preventDefault(); void saveRepository() }}><label>{repositoryEditing ? 'Linked project name' : 'Add linked project'}<input required value={repositoryName} onChange={event => setRepositoryName(event.target.value)} /></label><label>Project folder<div className="hub-picker"><input readOnly required value={repositoryFolder} placeholder="Choose a folder…" /><button type="button" onClick={() => void pickFiles({ window: 'workspace', folder: true }).then(paths => { if (paths[0]) setRepositoryFolder(paths[0]) }).catch(reportError)}>Browse…</button></div></label><button className="hub-action" disabled={busy || !repositoryFolder}>{repositoryEditing ? 'Save linked project' : 'Link project'}</button></form></section>}
      <form className="hub-form" onSubmit={event => { event.preventDefault(); void save() }}><h3>{editing ? 'Edit workspace' : 'Add workspace'}</h3><label>Name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label><label>First linked project folder <span>(optional)</span><div className="hub-picker"><input readOnly value={folder} placeholder="Choose a folder…" /><button type="button" onClick={() => void pickFiles({ window: 'workspace', folder: true }).then(paths => { if (paths[0]) setFolder(paths[0]) }).catch(reportError)}>Browse…</button></div></label><label>Associate existing card <span>(optional)</span><select value={cardId} onChange={event => setCardId(event.target.value)}><option value="">None</option>{cards.filter(card => !card.projectId || card.projectId === editing).map(card => <option value={card.id} key={card.id}>{card.title}</option>)}</select></label><button className="hub-action" disabled={busy || !name.trim()}>{editing ? 'Save changes' : 'Add workspace'}</button>{editing && <button type="button" className="hub-quiet" onClick={() => { setEditing(''); setName(''); setFolder(''); setCardId('') }}>Cancel</button>}</form>
      {editing && <button className="hub-danger" disabled={busy} onClick={() => void reviewCards(editing)}>Remove registration</button>}
    </div>
    {removeTarget && <div className="file-confirm-backdrop"><div className="file-confirm" role="alertdialog" aria-modal="true" aria-labelledby="remove-workspace-title" aria-describedby="remove-workspace-text">
      <h3 id="remove-workspace-title">Remove workspace registration?</h3>
      {cardChoices}
      <p id="remove-workspace-text"><strong>{projects.find(project => project.id === removeTarget)?.name || 'This workspace'}</strong> will disappear from the workspace selector. External project folders and chat history are not deleted. Choose what happens to the Hub cards below.</p>
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      <div><button disabled={busy} onClick={() => setRemoveTarget('')}>Cancel</button><button className="danger" disabled={busy} onClick={() => void remove()}>Remove registration</button></div>
    </div></div>}
    {removeRepositoryTarget && removingRepository && <div className="file-confirm-backdrop"><div className="file-confirm hub-unlink-dialog" role="alertdialog" aria-modal="true" aria-labelledby="unlink-project-title" aria-describedby="unlink-project-text">
      <h3 id="unlink-project-title">Unlink {removingRepository.name}?</h3>
      {cardChoices}
      <p id="unlink-project-text">Only its Mr. Mik registration will be removed. The external folder and its Codex/Claude settings stay untouched. Choose what happens to its cards below; retained cards lose this default working project. Hub links to files in it are removed. Old chats stay in History but cannot resume as linked-project chats after unlinking.</p>
      {removingMain && <div className="hub-replacement-field"><span>New main linked project</span><DarkSelect label="New main linked project" value={replacementId} options={[{ value: '', label: 'Choose a project…' }, ...editedProject!.repositories.filter(repository => repository.id !== removeRepositoryTarget).map(repository => ({ value: repository.id, label: repository.name }))]} onChange={setReplacementId} /></div>}
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      <div className="hub-unlink-actions"><button disabled={busy} onClick={() => setRemoveRepositoryTarget('')}>Cancel</button><button className="danger" disabled={busy || !!removingMain && !replacementId} onClick={() => void removeLinkedProject()}>Unlink project</button></div>
    </div></div>}
    {creatingCard && <CardCreateDialog project={projects.find(project => project.id === settings.selectedProjectId)} onClose={() => setCreatingCard(false)} onCreated={id => { setCreatingCard(false); window.location.hash = `#/${encodeURIComponent(id)}` }} />}
  </div>
}
