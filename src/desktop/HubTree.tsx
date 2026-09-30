import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { api, onServiceEvent, pickFiles, reportError, setPreview, useDesktop } from './client'
import type { FileEntry, Folder, LibraryResource, Preview } from './types'
import type { WorkspaceEntity } from '../types'
import { Icon } from './Icons'
import CardCreateDialog from './CardCreateDialog'
import './hub-rail.css'

type Kind = 'knowledge' | 'process' | 'inbox'
const labels: Record<Kind, string> = { knowledge: 'Knowledge', process: 'Processes', inbox: 'Inbox' }
export default function HubTree({ section = 'all', fileRevision = 0, onFileContextMenu }: { section?: Kind | 'all'; fileRevision?: number; onFileContextMenu?: (event: MouseEvent, path: string, resource?: LibraryResource) => void }) {
  const { repo, projects, settings } = useDesktop()
  const selected = settings.selectedProjectId || ''
  const [resources, setResources] = useState<Record<Kind, LibraryResource[]>>({ knowledge: [], process: [], inbox: [] })
  const [context, setContext] = useState<FileEntry[]>([]), [cards, setCards] = useState<WorkspaceEntity[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ knowledge: true, process: true, inbox: true, context: true, workspace: true })
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [creatingCard, setCreatingCard] = useState(false)
  useEffect(() => onServiceEvent(event => { if (['workspace-changed', 'projects-changed'].includes(event.type)) setRevision(value => value + 1) }), [])
  useEffect(() => {
    let active = true
    void Promise.all((['knowledge', 'process', 'inbox'] as Kind[]).map(kind => api<LibraryResource[]>(`/resources?kind=${kind}&projectId=${encodeURIComponent(selected)}&scope=${selected ? 'project' : 'global'}`))).then(([knowledge, process, inbox]) => { if (active) setResources({ knowledge, process, inbox }) }).catch(reportError)
    void api<{ entities: WorkspaceEntity[] }>('/workspace').then(value => { if (active) setCards(value.entities.filter(card => !selected || card.projectId === selected)) }).catch(reportError)
    if (!selected) void api<Folder>(`/files?path=${encodeURIComponent(`${repo}/context`)}&mode=all`).then(value => { if (active) setContext(value.entries.filter(item => !item.directory)) }).catch(() => { if (active) setContext([]) })
    return () => { active = false }
  }, [repo, selected, revision, fileRevision])
  const toggle = (name: string) => setExpanded(value => ({ ...value, [name]: !value[name] }))
  const preview = (item: LibraryResource) => void api<Preview>(`/resources/preview?kind=${item.kind}&id=${encodeURIComponent(item.id)}`).then(setPreview).catch(reportError)
  const importFile = async (kind: Kind) => {
    setError('')
    try {
      const paths = await pickFiles({ window: 'workspace' })
      if (!paths.length) return
      setBusy(true)
      for (const source of paths) await api('/resources/import', { kind, projectId: selected || null, source })
      setRevision(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const assign = async (item: LibraryResource, projectId: string) => {
    try { await api('/resources/assign', { kind: item.kind, path: item.path, projectId: projectId || null }); setRevision(value => value + 1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const assignCard = async (id: string, projectId: string) => {
    try { await api('/cards/assign', { id, projectId: projectId || null }); setRevision(value => value + 1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const assignCardRepository = async (id: string, repositoryId: string) => {
    try { await api('/cards/repository', { id, repositoryId: repositoryId || null }); setRevision(value => value + 1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const kinds: Kind[] = section === 'all' ? ['knowledge', 'process', 'inbox'] : [section]
  const cardGroups = selected ? [{ id: selected, name: '', items: cards }] : [{ id: '', name: 'Global cards', items: cards.filter(card => !card.projectId) }, ...projects.map(project => ({ id: project.id, name: project.name, items: cards.filter(card => card.projectId === project.id) }))].filter(group => group.items.length)
  return <div className="hub-tree" role="tree" aria-label="Mr. Mik workspace folders">
    {error && <p role="alert" className="desk-error-inline">{error}</p>}
    {section === 'all' && !selected && <div><button className="file-row directory" onClick={() => toggle('context')} aria-expanded={expanded.context}><Icon name="arrow" size={11} style={{ transform: expanded.context ? 'rotate(90deg)' : undefined }} /><Icon name="folder" size={15} />Context</button>{expanded.context && context.map(file => <button className="file-row hub-child" key={file.path} onClick={() => void api<Preview>(`/preview?path=${encodeURIComponent(file.path)}`).then(setPreview).catch(reportError)} onContextMenu={event => onFileContextMenu?.(event, file.path)}><Icon name="files" size={14} />{file.name}</button>)}</div>}
    {kinds.map(kind => <div key={kind}><div className="hub-tree-heading"><button className="file-row directory" onClick={() => toggle(kind)} aria-expanded={expanded[kind]}><Icon name="arrow" size={11} style={{ transform: expanded[kind] ? 'rotate(90deg)' : undefined }} /><Icon name="folder" size={15} /><span>{labels[kind]}</span></button><button className="desk-icon" disabled={busy} title={`Link file to ${labels[kind]} (copy to Mr. Mik Hub)`} aria-label={`Link file to ${labels[kind]}`} onClick={() => void importFile(kind)}><Icon name="plus" size={14} /></button></div>{expanded[kind] && <>{resources[kind].map(item => <div className="hub-resource" key={item.id}><button className="file-row hub-child" title={item.path} onClick={() => preview(item)} onContextMenu={event => onFileContextMenu?.(event, item.repositoryProjectId ? '' : `${repo}/${item.path}`, item)}><Icon name="files" size={14} /><span>{item.title}</span></button>{kind === 'inbox' && <select title={`Assign ${item.title}`} aria-label={`Assign ${item.title}`} value={item.projectId || ''} onChange={event => void assign(item, event.target.value)}><option value="">Unassigned</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}</div>)}{!resources[kind].length && <p className="file-tree-note">{kind === 'inbox' ? 'No files assigned here.' : 'No files yet.'}</p>}</>}</div>)}
    {section === 'all' && <div><div className="hub-tree-heading"><button className="file-row directory" onClick={() => toggle('workspace')} aria-expanded={expanded.workspace}><Icon name="arrow" size={11} style={{ transform: expanded.workspace ? 'rotate(90deg)' : undefined }} /><Icon name="folder" size={15} /><span>Cards</span></button><button className="desk-icon" title="Create card" aria-label="Create card" onClick={() => setCreatingCard(true)}><Icon name="plus" size={14} /></button></div>{expanded.workspace && cardGroups.map(group => <div key={group.id}>{group.name && <p className="file-tree-note">{group.name}</p>}{group.items.map(card => <div className="hub-resource" key={card.id}><a className="file-row hub-child" href={`#/${encodeURIComponent(card.id)}`}><Icon name="workspace" size={14} /><span>{card.title}</span></a><select aria-label={`Workspace for ${card.title}`} title={`Move ${card.title} to workspace`} value={card.projectId || ''} onChange={event => void assignCard(card.id, event.target.value)}><option value="">Global Hub</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>{selected && <select aria-label={`Linked project for ${card.title}`} title={`Working linked project for ${card.title}`} value={card.repositoryId || ''} onChange={event => void assignCardRepository(card.id, event.target.value)}><option value="">No linked project</option>{projects.find(project => project.id === selected)?.repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select>}</div>)}</div>)}</div>}
    <p className="hub-tree-note">{selected ? `${projects.find(project => project.id === selected)?.name || 'Workspace'} · Mr. Mik library` : 'Global Hub · Mr. Mik library'}</p>
    {creatingCard && <CardCreateDialog project={projects.find(project => project.id === selected)} onClose={() => setCreatingCard(false)} onCreated={id => { setCreatingCard(false); setExpanded(value => ({ ...value, workspace: true })); setRevision(value => value + 1); window.location.hash = `#/${encodeURIComponent(id)}` }} />}
  </div>
}
