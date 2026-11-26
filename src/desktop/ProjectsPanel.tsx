import { useEffect, useState, type ReactNode } from 'react'
import { api, pickFiles, reportError, useDesktop, onServiceEvent } from './client'
import type { Project } from './types'
import type { WorkspaceEntity } from '../types'
import { Icon } from './Icons'
import AnchoredMenu from './AnchoredMenu'
import WorkspaceIconDialog from './WorkspaceIconDialog'
import WorkspaceDialog from './WorkspaceDialog'
import DarkSelect from './DarkSelect'
import './hub-rail.css'

export default function ProjectsPanel({ onClose, onSelect, scope }: { onClose: () => void; onSelect: () => void; scope: ReactNode }) {
  const { projects, settings } = useDesktop()
  const [name, setName] = useState(''), [folder, setFolder] = useState(''), [editing, setEditing] = useState('')
  const [cards, setCards] = useState<WorkspaceEntity[]>([])
  const [form, setForm] = useState<'new' | 'edit' | 'repository' | null>(null), [iconOpen, setIconOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState('')
  const [removeRepositoryTarget, setRemoveRepositoryTarget] = useState('')
  const [replacementId, setReplacementId] = useState('')
  const [cardAction, setCardAction] = useState('keep')
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
      setName(''); setFolder(''); setEditing(''); setForm(null); await choose(project.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const edit = (project: Project) => { setEditing(project.id); setName(project.name); setFolder(''); setError(''); setForm('edit') }
  const addExample = async () => {
    setBusy(true); setError('')
    try { const result = await api<{ projectId: string }>('/projects/example', {}); await choose(result.projectId) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const saveRepository = async () => {
    setBusy(true); setError('')
    try { await api('/projects/repositories', { projectId: editing, id: repositoryEditing || undefined, name: repositoryName, repositoryPath: repositoryFolder }); setRepositoryEditing(''); setRepositoryName(''); setRepositoryFolder(''); setForm(null) }
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
      if (repositoryEditing === removeRepositoryTarget) { setRepositoryEditing(''); setRepositoryName(''); setRepositoryFolder(''); setForm(null) }
      setRemoveRepositoryTarget(''); setReplacementId(''); onSelect()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const editedProject = projects.find(project => project.id === (editing || settings.selectedProjectId))
  const removingRepository = editedProject?.repositories.find(repository => repository.id === removeRepositoryTarget)
  const removingMain = editedProject?.repositories[0]?.id === removeRepositoryTarget
  const affectedCards = cards.filter(card => removeTarget ? card.projectId === removeTarget : card.projectId === editing && card.repositoryId === removeRepositoryTarget)
  const cardChoices = <section className="card-choice"><span>{affectedCards.length} affected card{affectedCards.length === 1 ? '' : 's'}</span>
    {affectedCards.length > 0 && <><ul>{affectedCards.map(card => <li key={card.id}>{card.title}</li>)}</ul><DarkSelect appearance="workspace" icon="" label="What to do with these cards" value={cardAction} disabled={busy} options={[{ value: 'keep', label: removeTarget ? 'Keep in Global Hub' : 'Keep in this workspace' }, { value: 'archive', label: 'Archive cards' }, { value: 'delete', label: 'Delete cards · Recycle Bin' }]} onChange={setCardAction} /><p>{cardAction === 'delete' ? 'Card entries are removed; only their Hub content folders go to the Recycle Bin.' : removeTarget ? 'Retained cards move to Global Hub. Archived cards can be restored from Archive.' : 'Retained cards lose this linked project association. Archived cards can be restored from Archive.'}</p></>}
  </section>
  const selectedProject = projects.find(project => project.id === settings.selectedProjectId)
  const startRepository = (id = '') => { const repository = selectedProject?.repositories.find(item => item.id === id); setEditing(selectedProject?.id || ''); setRepositoryEditing(id); setRepositoryName(repository?.name || ''); setRepositoryFolder(repository?.repositoryPath || ''); setError(''); setForm('repository') }
  return <div className="files-panel hub-panel workspace-menu-panel"><header><h2>Workspace</h2><div><AnchoredMenu label="Workspace actions" appearance="workspace" placement="below">{close => <div className="conversation-actions">
    <button disabled={!selectedProject || busy} onClick={() => { if (selectedProject) edit(selectedProject); close() }}><Icon name="edit" size={16} />Edit workspace</button>
    <button disabled={!selectedProject || busy} onClick={() => { setIconOpen(true); close() }}><Icon name="image" size={16} />Workspace icon</button>
    <hr /><button disabled={busy} onClick={() => { close(); void addExample() }}><Icon name="layers" size={16} />Add example workspace</button>
    <hr /><button className="danger" disabled={!selectedProject || busy} onClick={() => { close(); if (selectedProject) void reviewCards(selectedProject.id) }}><Icon name="trash" size={16} />Remove workspace</button>
  </div>}</AnchoredMenu><button className="desk-icon" onClick={onClose} aria-label="Close Workspaces"><Icon name="close" size={17} /></button></div></header>
    <div className="workspace-scope-row">{scope}<button className="desk-icon" aria-label="New workspace" title="New workspace" onClick={() => { setEditing(''); setName(''); setFolder(''); setError(''); setForm('new') }}><Icon name="plus" size={16} /></button></div>
    <div className="hub-panel-scroll">
      {error && !form && !removeTarget && !removeRepositoryTarget && <p role="alert" className="desk-error-inline">{error}</p>}
      {selectedProject && <section className="workspace-linked"><div className="workspace-section-heading"><span>Linked projects</span><button className="desk-icon" aria-label="Link project" title="Link project" onClick={() => startRepository()}><Icon name="plus" size={15} /></button></div>
        {selectedProject.repositories.map((repository, index) => <div className="workspace-linked-row" key={repository.id}>
          <button className="workspace-link-name" title={repository.repositoryPath || 'Folder unavailable'} aria-label={`Edit link for ${repository.name}`} onClick={() => startRepository(repository.id)}><Icon name="folder" size={16} /><span><strong>{repository.name === 'Main project' && repository.repositoryPath ? repository.repositoryPath.split(/[\\/]/).filter(Boolean).pop() : repository.name}</strong><small>{!repository.available ? 'Folder unavailable' : index === 0 ? 'Main project' : 'Linked project'}</small></span></button>
          <button className="desk-icon" disabled={!repository.available} aria-label={`Open folder for ${repository.name}`} title="Open folder" onClick={() => void api('/reveal', { path: repository.repositoryPath }).catch(reportError)}><Icon name="external" size={14} /></button>
          <button className="desk-icon" disabled={selectedProject.repositories.length < 2 || busy} aria-label={`Unlink ${repository.name}`} title={selectedProject.repositories.length < 2 ? 'Keep at least one linked project' : 'Unlink project'} onClick={() => { setEditing(selectedProject.id); void reviewCards(selectedProject.id, repository.id) }}><Icon name="unlink" size={14} /></button>
        </div>)}
        {!selectedProject.repositories.length && <p className="file-tree-note">No linked projects</p>}
      </section>}
    </div>
    {form && <WorkspaceDialog label={form === 'repository' ? repositoryEditing ? 'Edit linked project' : 'Link project' : form === 'edit' ? 'Edit workspace' : 'New workspace'} close={() => setForm(null)} busy={busy}>
      <header><h3 id="workspace-edit-title">{form === 'repository' ? repositoryEditing ? 'Edit linked project' : 'Link project' : form === 'edit' ? 'Edit workspace' : 'New workspace'}</h3><button className="desk-icon" aria-label="Close dialog" disabled={busy} onClick={() => setForm(null)}><Icon name="close" size={16} /></button></header>
      <form className="hub-form" onSubmit={event => { event.preventDefault(); if (form === 'repository') void saveRepository(); else void save() }}>
        <label>Name<input autoFocus required maxLength={100} value={form === 'repository' ? repositoryName : name} onChange={event => form === 'repository' ? setRepositoryName(event.target.value) : setName(event.target.value)} /></label>
        {form === 'repository' && <label>Project folder<div className="hub-picker"><input required aria-label="Project folder" value={repositoryFolder} onChange={event => setRepositoryFolder(event.target.value)} /><button type="button" onClick={() => void pickFiles({ window: 'workspace', folder: true }).then(paths => { if (paths[0]) setRepositoryFolder(paths[0]) }).catch(reportError)}>Browse…</button></div></label>}
        {error && <p role="alert" className="desk-error-inline">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={() => setForm(null)}>Cancel</button><button disabled={busy || (form === 'repository' ? !repositoryName.trim() || !repositoryFolder.trim() : !name.trim())}>{busy ? 'Saving…' : form === 'new' ? 'Create workspace' : form === 'repository' && !repositoryEditing ? 'Link project' : 'Save changes'}</button></footer>
      </form>
    </WorkspaceDialog>}
    {iconOpen && selectedProject && <WorkspaceIconDialog projectId={selectedProject.id} close={() => setIconOpen(false)} />}
    {removeTarget && <WorkspaceDialog label="Remove workspace registration?" role="alertdialog" busy={busy} close={() => setRemoveTarget('')}>
      <h3 id="remove-workspace-title">Remove workspace registration?</h3>
      {cardChoices}
      <p id="remove-workspace-text"><strong>{projects.find(project => project.id === removeTarget)?.name || 'This workspace'}</strong> will disappear from the workspace selector. External project folders and chat history are not deleted. Choose what happens to the Hub cards below.</p>
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      <footer><button disabled={busy} onClick={() => setRemoveTarget('')}>Cancel</button><button className="danger" disabled={busy} onClick={() => void remove()}>Remove registration</button></footer>
    </WorkspaceDialog>}
    {removeRepositoryTarget && removingRepository && <WorkspaceDialog label={`Unlink ${removingRepository.name}?`} role="alertdialog" busy={busy} close={() => setRemoveRepositoryTarget('')}>
      <h3 id="unlink-project-title">Unlink {removingRepository.name}?</h3>
      {cardChoices}
      <p id="unlink-project-text">Only its Mr. Mik registration will be removed. The external folder and its native agent settings stay untouched. Choose what happens to its cards below; retained cards lose this default working project. Hub links to files in it are removed. Old chats stay in History but cannot resume as linked-project chats after unlinking.</p>
      {removingMain && <div className="hub-replacement-field"><span>New main linked project</span><DarkSelect appearance="workspace" icon="" label="New main linked project" value={replacementId} options={[{ value: '', label: 'Choose a project…' }, ...editedProject!.repositories.filter(repository => repository.id !== removeRepositoryTarget).map(repository => ({ value: repository.id, label: repository.name }))]} onChange={setReplacementId} /></div>}
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      <footer className="hub-unlink-actions"><button disabled={busy} onClick={() => setRemoveRepositoryTarget('')}>Cancel</button><button className="danger" disabled={busy || !!removingMain && !replacementId} onClick={() => void removeLinkedProject()}>Unlink project</button></footer>
    </WorkspaceDialog>}
  </div>
}
