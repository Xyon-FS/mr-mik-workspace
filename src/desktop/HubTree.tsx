import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { api, onServiceEvent, pickFiles, reportError, setPreview, useDesktop } from './client'
import type { FileEntry, Folder, LibraryResource, Preview } from './types'
import type { WorkspaceEntity } from '../types'
import { Icon } from './Icons'
import CardCreateDialog from './CardCreateDialog'
import CardActions from './CardActions'
import CollectionAssociation from './CollectionAssociation'
import './hub-rail.css'

type Kind = 'knowledge' | 'process' | 'inbox'
const labels: Record<Kind, string> = { knowledge: 'Knowledge', process: 'Processes', inbox: 'Inbox' }
export default function HubTree({ section = 'all', fileRevision = 0, onFileContextMenu }: { section?: Kind | 'all' | 'cards'; fileRevision?: number; onFileContextMenu?: (event: MouseEvent, path: string, resource?: LibraryResource) => void }) {
  const { repo, projects, settings } = useDesktop()
  const selected = settings.selectedProjectId || ''
  const [resources, setResources] = useState<Record<Kind, LibraryResource[]>>({ knowledge: [], process: [], inbox: [] })
  const [context, setContext] = useState<FileEntry[]>([]), [cards, setCards] = useState<WorkspaceEntity[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ knowledge: true, process: true, inbox: true, context: true, workspace: true })
  const [revision, setRevision] = useState(0)
  const [creatingCard, setCreatingCard] = useState(false)
  const [importing, setImporting] = useState<Kind | null>(null), [error, setError] = useState('')
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
  const addFiles = async (kind: Kind) => {
    if (importing) return
    const projectId = selected
    setError(''); setImporting(kind)
    try {
      const paths = await pickFiles({ window: 'workspace' })
      for (const source of paths) await api('/resources/import', { kind, projectId: projectId || null, source })
      setExpanded(value => ({ ...value, [kind]: true })); setRevision(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setImporting(null) }
  }
  const kinds: Kind[] = section === 'all' ? ['knowledge', 'process', 'inbox'] : section === 'cards' ? [] : [section]
  const cardGroups = selected ? [{ id: selected, name: '', items: cards }] : [{ id: '', name: 'Global cards', items: cards.filter(card => !card.projectId) }, ...projects.map(project => ({ id: project.id, name: project.name, items: cards.filter(card => card.projectId === project.id) }))].filter(group => group.items.length)
  const refresh = () => setRevision(value => value + 1)
  const showCards = section === 'all' || section === 'cards'
  return <div className="hub-tree" role="tree" aria-label="Mr. Mik workspace folders">
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
    {section === 'all' && !selected && <div><div className="hub-tree-heading"><button className="file-row directory" onClick={() => toggle('context')} aria-expanded={expanded.context}><Icon name="arrow" size={11} style={{ transform: expanded.context ? 'rotate(90deg)' : undefined }} /><Icon name="folder" size={15} /><span>Context</span></button></div>{expanded.context && context.map(file => <button className="file-row hub-child" key={file.path} onClick={() => void api<Preview>(`/preview?path=${encodeURIComponent(file.path)}`).then(setPreview).catch(reportError)} onContextMenu={event => onFileContextMenu?.(event, file.path)}><Icon name="files" size={14} /><span>{file.name}</span></button>)}</div>}
    {showCards && <div><div className="hub-tree-heading">{section === 'all' ? <button className="file-row directory" onClick={() => toggle('workspace')} aria-expanded={expanded.workspace}><Icon name="arrow" size={11} style={{ transform: expanded.workspace ? 'rotate(90deg)' : undefined }} /><Icon name="workspace" size={15} /><span>Cards</span></button> : <span className="collection-filter-spacer" />}<button className="desk-icon" title="Create card" aria-label="Create card" onClick={() => setCreatingCard(true)}><Icon name="plus" size={14} /></button></div>{(section === 'cards' || expanded.workspace) && cardGroups.map(group => <div key={group.id}>{group.name && <p className="file-tree-note">{group.name}</p>}{group.items.map(card => <div className="hub-resource" key={card.id}><a className="file-row hub-child" title={card.title} href={`#/${encodeURIComponent(card.id)}`}><Icon name="workspace" size={14} /><span>{card.title}</span></a><CollectionAssociation card={card} refreshed={refresh} /><CardActions entity={card} inline onRemoved={refresh} /></div>)}</div>)}</div>}
    {kinds.map(kind => <div key={kind}><div className="hub-tree-heading">{section === 'all' ? <button className="file-row directory" onClick={() => toggle(kind)} aria-expanded={expanded[kind]}><Icon name="arrow" size={11} style={{ transform: expanded[kind] ? 'rotate(90deg)' : undefined }} /><Icon name="folder" size={15} /><span>{labels[kind]}</span></button> : <span className="collection-filter-spacer" />}<button className="desk-icon" title={`Add files to ${labels[kind]}`} aria-label={`Add files to ${labels[kind]}`} disabled={!!importing} onClick={() => void addFiles(kind)}><Icon name={importing === kind ? 'refresh' : 'plus'} size={14} /></button></div>{(section !== 'all' || expanded[kind]) && <>{resources[kind].map(item => <div className="hub-resource" key={item.id}><button className="file-row hub-child" title={item.path} onClick={() => preview(item)} onContextMenu={event => onFileContextMenu?.(event, item.repositoryProjectId ? '' : `${repo}/${item.path}`, item)}><Icon name="files" size={14} /><span>{item.title}</span></button>{kind === 'inbox' && <CollectionAssociation resource={item} refreshed={refresh} />}<button className="desk-icon file-row-actions" aria-label={`Actions for ${item.title}`} onClick={event => onFileContextMenu?.(event, item.repositoryProjectId ? '' : `${repo}/${item.path}`, item)}><Icon name="more" size={14} /></button></div>)}{!resources[kind].length && <p className="file-tree-note">No files here.</p>}</>}</div>)}
    {creatingCard && <CardCreateDialog project={projects.find(project => project.id === selected)} onClose={() => setCreatingCard(false)} onCreated={id => { setCreatingCard(false); setExpanded(value => ({ ...value, workspace: true })); refresh(); window.location.hash = `#/${encodeURIComponent(id)}` }} />}
  </div>
}
