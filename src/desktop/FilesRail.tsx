import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { api, desktopState, onServiceEvent, reportError, setPreview, uploadFile, useDesktop, windowAction } from './client'
import type { FileEntry, Folder, LibraryResource, Preview } from './types'
import { Icon } from './Icons'
import MarkdownDocument from '../components/MarkdownDocument'
import WorkspaceSettings from './WorkspaceSettings'
import McpPanel from './McpPanel'
import { ZoomImage } from '../components/ImagePreview'
import ProjectsPanel from './ProjectsPanel'
import HubTree from './HubTree'
import HubSkills from './HubSkills'
import NativeSkills from './NativeSkills'
import DarkSelect from './DarkSelect'
import SkillCreate from './SkillCreate'
import HelpSite from './HelpSite'

export function FilePreview({ file }: { file: Preview }) {
  return <div className="file-preview"><header><span><Icon name="files" size={16} /><strong title={file.name}>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB</small></span><div><button className="desk-icon" onClick={() => api('/reveal', { path: file.path }).catch(reportError)} title="Show in Explorer"><Icon name="external" size={17} /></button><button className="desk-icon" onClick={() => setPreview(null)} title="Back to Workspace" aria-label="Close file preview"><Icon name="close" size={18} /></button></div></header><div className={`file-preview-body ${file.kind}`}>
    {file.kind === 'text' && (/\.md$/i.test(file.name) ? <MarkdownDocument key={`${file.path}:${file.revision}`} file={file} /> : <pre>{file.text}</pre>)}
    {file.kind === 'document' && <iframe src={file.url} title={file.name} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" />}
    {file.kind === 'image' && <ZoomImage src={file.url} alt={file.name} />}
    {file.kind === 'video' && <video src={file.url} controls />}
    {file.kind === 'audio' && <audio src={file.url} controls />}
    {file.kind === 'unsupported' && <div className="file-unsupported"><Icon name="files" size={38} /><h2>{file.name}</h2><p>{file.reason}</p><button className="desk-secondary" onClick={() => api('/reveal', { path: file.path }).catch(reportError)}>Show in Explorer</button></div>}
  </div></div>
}

const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
const fileName = (path: string) => path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || path
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function RevealFolder({ path, name }: { path: string; name: string }) {
  return <button className="file-reveal" title={`Open ${name} in Explorer`} aria-label={`Open ${name} in Explorer`} onClick={event => { event.stopPropagation(); api('/reveal', { path }).catch(reportError) }}><Icon name="external" size={14} /></button>
}
type TreeControls = {
  expanded: Set<string>; selected: string; dropTarget: string; query: string; revision: number
  toggle: (path: string) => void
  preview: (entry: FileEntry) => void
  contextMenu: (event: MouseEvent, path: string, directory: boolean) => void
  drag: (event: DragEvent, path: string, directory: boolean) => void
  dropProps: (path: string) => {
    onDragOver: (event: DragEvent) => void
    onDragLeave: (event: DragEvent) => void
    onDrop: (event: DragEvent) => void
  }
}

function FolderBranch({ path, mode = 'all', depth = 1, ancestors = [], tree, onLoad }: {
  path: string; mode?: 'main' | 'all'; depth?: number; ancestors?: string[]; tree: TreeControls; onLoad?: (folder: Folder) => void
}) {
  const [folder, setFolder] = useState<Folder | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    api<Folder>(`/files?path=${encodeURIComponent(path)}&mode=${mode}`).then(value => {
      if (!abort.signal.aborted) { setFolder(value); setError(''); onLoad?.(value) }
    }).catch(error => { if (!abort.signal.aborted) setError(message(error)) })
    return () => abort.abort()
  }, [path, mode, tree.revision, onLoad])
  if (error) return <p className={`file-tree-note ${mode === 'all' && /[\\/]\.?(?:agents|claude)[\\/]skills$/i.test(path) && /ENOENT|not found|does not exist/i.test(error) ? '' : 'desk-error-inline'}`}>{mode === 'all' && /[\\/]\.?(?:agents|claude)[\\/]skills$/i.test(path) && /ENOENT|not found|does not exist/i.test(error) ? 'No native skill folder here yet.' : error}</p>
  if (!folder) return <p className="file-tree-note">Loading folder…</p>
  if (ancestors.includes(pathKey(folder.path))) return <p className="file-tree-note">Linked folder already shown above.</p>
  if (depth > 20) return <button className="file-tree-note" onClick={() => api('/reveal', { path }).catch(reportError)}>Open this deep folder in Explorer</button>
  const entries = folder.entries.filter(entry => entry.directory || entry.name.toLowerCase().includes(tree.query.toLowerCase()))
  return <div role="group" {...tree.dropProps(folder.path)}>{entries.map(entry => {
    const expanded = tree.expanded.has(pathKey(entry.path))
    return <div role="none" key={entry.path}>
      <div role="none" className={`file-entry ${entry.directory ? 'has-reveal' : ''}`} {...(entry.directory ? tree.dropProps(entry.path) : {})}>
      <button role="treeitem" data-path={entry.path} aria-level={depth + 1} aria-expanded={entry.directory ? expanded : undefined} aria-selected={pathKey(tree.selected) === pathKey(entry.path)}
        className={`file-row ${entry.directory ? 'directory' : ''} ${pathKey(tree.selected) === pathKey(entry.path) ? 'selected' : ''} ${tree.dropTarget === pathKey(entry.path) ? 'drop-target' : ''}`}
        style={{ paddingLeft: 8 + Math.min(depth, 10) * 14 }} title={entry.path}
        onClick={() => entry.directory ? tree.toggle(entry.path) : tree.preview(entry)}
        onContextMenu={event => tree.contextMenu(event, entry.path, entry.directory)}
        draggable onDragStart={event => tree.drag(event, entry.path, entry.directory)}
        {...tree.dropProps(entry.directory ? entry.path : folder.path)}>
        <Icon name="arrow" size={11} style={{ visibility: entry.directory ? 'visible' : 'hidden', transform: expanded ? 'rotate(90deg)' : undefined }} />
        <Icon name={entry.directory ? 'folder' : 'files'} size={15} /><span>{entry.name}</span>
        {!entry.directory && <small>{entry.size < 1024 * 1024 ? `${Math.max(1, Math.round(entry.size / 1024))}k` : `${(entry.size / (1024 * 1024)).toFixed(1)}m`}</small>}
      </button>
      {entry.directory && <RevealFolder path={entry.path} name={entry.name} />}
      </div>
      {entry.directory && expanded && <FolderBranch path={entry.path} depth={depth + 1} ancestors={[...ancestors, pathKey(folder.path)]} tree={tree} />}
    </div>
  })}{!entries.length && <p className="file-tree-note" style={{ paddingLeft: 22 + depth * 14 }}>{tree.query ? 'No matching files.' : 'Empty folder · drop files here'}</p>}
    {folder.truncated && <p className="file-tree-note">First 1,500 entries shown. Open Explorer for the complete folder.</p>}
  </div>
}

function treeKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'))
  const current = rows.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0) return
  event.preventDefault()
  const row = rows[current], expanded = row.getAttribute('aria-expanded')
  if (event.key === 'ArrowRight' && expanded === 'false') return row.click()
  if (event.key === 'ArrowLeft' && expanded === 'true' && current > 0) return row.click()
  let next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current + (event.key === 'ArrowUp' ? -1 : 1)
  if (event.key === 'ArrowLeft') {
    next = current - 1
    while (next > 0 && Number(rows[next].getAttribute('aria-level')) >= Number(row.getAttribute('aria-level'))) next--
  }
  rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus()
}

export default function FilesRail() {
  const { repo, projects, settings } = useDesktop()
  const selectedProject = projects.find(project => project.id === settings.selectedProjectId)
  const repositories = projects.flatMap(project => project.repositories.map(repository => ({ ...repository, projectId: project.id, projectName: project.name })))
  const storageKey = `mrmak.files.${pathKey(repo)}`
  const [open, setOpen] = useState(() => localStorage.getItem(`${storageKey}.open`) === 'true')
  const [panel, setPanel] = useState<'files' | 'projects' | 'knowledge' | 'process' | 'inbox' | 'skills' | 'mcp' | 'settings'>('files')
  const [skillAgent, setSkillAgent] = useState<'codex' | 'claude'>('codex')
  const [skillSource, setSkillSource] = useState<'hub' | 'linked'>('hub')
  const [skillCreateOpen, setSkillCreateOpen] = useState(false)
  const [skillRevision, setSkillRevision] = useState(0)
  const [selectedSkillRepositoryId, setSelectedSkillRepositoryId] = useState('')
  const skillRoot = selectedProject?.repositories.find(repository => repository.id === selectedSkillRepositoryId)?.repositoryPath || selectedProject?.repositories.find(repository => repository.available)?.repositoryPath || selectedProject?.repositories[0]?.repositoryPath || repo
  const hubSkillFolder = `${repo}/${skillAgent === 'codex' ? '.agents' : '.claude'}/skills`
  const nativeSkillFolder = `${skillRoot}/${skillAgent === 'codex' ? '.agents' : '.claude'}/skills`
  const [root, setRoot] = useState(repo)
  const currentRepository = repositories.find(repository => repository.repositoryPath && pathKey(repository.repositoryPath) === pathKey(root))
  const [typedPath, setTypedPath] = useState(repo)
  const [rootFolder, setRootFolder] = useState<Folder | null>(null)
  const [mode, setMode] = useState<'main' | 'all'>('main')
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(`${storageKey}.expanded`) || '[]'); return new Set(Array.isArray(saved) ? saved.filter(item => typeof item === 'string') : []) } catch { return new Set() }
  })
  const [selected, setSelected] = useState(repo)
  const [destination, setDestination] = useState(repo)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [revision, setRevision] = useState(0)
  const [dropTarget, setDropTarget] = useState('')
  const [copying, setCopying] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ path: string; directory: boolean; resource?: LibraryResource; x: number; y: number } | null>(null)
  const [recycleTarget, setRecycleTarget] = useState<string | null>(null)
  const [unlinkTarget, setUnlinkTarget] = useState<LibraryResource | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const copyLock = useRef(false)
  const internalDrag = useRef<{ path: string; directory: boolean; handled: boolean } | null>(null)
  const recycleLock = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const loaded = useCallback((folder: Folder) => setRootFolder(folder), [])
  useEffect(() => { localStorage.setItem(`${storageKey}.open`, String(open)) }, [storageKey, open])
  useEffect(() => { localStorage.setItem(`${storageKey}.expanded`, JSON.stringify([...expanded].slice(-300))) }, [storageKey, expanded])
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [contextMenu])
  useEffect(() => {
    if (!open) return
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 10000)
    return () => { window.removeEventListener('focus', refresh); clearInterval(timer) }
  }, [open, refresh])
  useEffect(() => {
    const complete = (event: Event) => {
      const result = (event as CustomEvent<{ dropped: boolean; error?: string }>).detail
      if (result.error) setError(result.error)
      const gesture = internalDrag.current
      window.setTimeout(() => {
        if (internalDrag.current !== gesture) return
        if (!gesture?.handled) setStatus(result.dropped ? 'Path handed to the destination.' : '')
        internalDrag.current = null
      }, 150)
    }
    const recycled = (event: Event) => {
      const result = (event as CustomEvent<{ path: string; recycled: boolean; error?: string }>).detail
      recycleLock.current = false
      if (result.error) { setError(result.error); setStatus(''); return }
      void api('/resources/recycled', { path: result.path }).catch(cause => setError(message(cause)))
      setStatus(`${fileName(result.path)} moved to Recycle Bin.`)
      const preview = desktopState().preview
      if (preview && (pathKey(preview.path) === pathKey(result.path) || pathKey(preview.path).startsWith(pathKey(result.path) + '/'))) setPreview(null)
      const parent = result.path.replace(/[\\/][^\\/]+$/, '')
      setSelected(parent); setDestination(parent); refresh()
    }
    window.addEventListener('mrmak-native-drag-result', complete)
    window.addEventListener('mrmak-recycle-result', recycled)
    return () => { window.removeEventListener('mrmak-native-drag-result', complete); window.removeEventListener('mrmak-recycle-result', recycled) }
  }, [refresh])
  const navigate = (path: string) => { setRoot(path); setTypedPath(path); setSelected(path); setDestination(path); if (pathKey(path) !== pathKey(root)) setRootFolder(null); setQuery(''); setError('') }
  const showPanel = (next: typeof panel) => {
    if (open && panel === next) { setOpen(false); return }
    if (next === 'skills') { setMode('all'); navigate(skillSource === 'linked' && selectedProject ? nativeSkillFolder : hubSkillFolder) }
    if (next === 'files' && panel !== 'files') { setMode('main'); navigate(repo) }
    setPanel(next); setOpen(true)
  }
  useEffect(() => onServiceEvent(event => {
    if (event.type !== 'navigate' || event.window !== 'workspace' || !event.section || !['projects', 'files', 'knowledge', 'process', 'inbox', 'skills', 'mcp', 'settings'].includes(event.section)) return
    setPanel(event.section as typeof panel); setOpen(true)
    if (event.section === 'files') { setMode('main'); setRoot(repo); setTypedPath(repo); setQuery('') }
    if (event.section === 'skills') { setMode('all'); setSkillSource('hub'); setRoot(`${repo}/.agents/skills`); setTypedPath(`${repo}/.agents/skills`); setSkillAgent('codex'); setQuery('') }
  }), [repo])
  const toggle = (path: string) => {
    setSelected(path); setDestination(path)
    setExpanded(current => { const next = new Set(current), key = pathKey(path); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  const copy = useCallback(async (files: File[], folder: string) => {
    if (copyLock.current || !files.length) return
    if (files.length > 100) { setError('Copy up to 100 files at a time.'); return }
    if (files.some(file => file.size > 1024 * 1024 * 1024)) { setError('Choose files of 1 GB or less.'); return }
    copyLock.current = true; setCopying(true); setError(''); setDropTarget('')
    let count = 0, renamed = 0
    try {
      for (const file of files) {
        setStatus(`Copying ${count + 1} of ${files.length} to ${fileName(folder)}…`)
        const result = await uploadFile(file, folder)
        count++; if (result.renamed) renamed++
      }
      setStatus(`Copied ${count} ${count === 1 ? 'file' : 'files'} to ${fileName(folder)}.${renamed ? ' Existing files kept; copies renamed.' : ''}`)
    } catch (error) { setError(message(error)); setStatus(count ? `Copied ${count} of ${files.length} files before the error.` : '') }
    finally {
      copyLock.current = false; setCopying(false); setSelected(folder); setDestination(folder)
      setExpanded(current => new Set([...current, pathKey(folder)])); refresh()
    }
  }, [refresh])
  const dropFiles = useCallback(async (event: DragEvent, folder: string) => {
    event.preventDefault(); event.stopPropagation(); setDropTarget('')
    const gesture = internalDrag.current
    if (gesture) {
      gesture.handled = true
      if (gesture.directory) { setStatus(''); setError('Drop folders into Chats to insert their paths. Use Explorer to move folders.'); return }
      if (copyLock.current) return
      copyLock.current = true; setCopying(true); setError('')
      try {
        const result = await api<{ path: string; moved: boolean }>('/files/move', { path: gesture.path, folder })
        setStatus(result.moved ? `Moved ${fileName(result.path)} to ${fileName(folder)}.` : '')
        if (result.moved) { setSelected(result.path); setDestination(folder); setExpanded(current => new Set([...current, pathKey(folder)])) }
      } catch (error) { setError(message(error)); setStatus('') }
      finally { copyLock.current = false; setCopying(false); refresh() }
      return
    }
    if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setError('Drop individual files into a folder. Folder transfers are available in Explorer.'); return }
    await copy(Array.from(event.dataTransfer.files), folder)
  }, [copy, refresh])
  const deleteKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Delete') { treeKeys(event); return }
    event.preventDefault(); event.stopPropagation()
    const path = (event.target as HTMLElement).closest('[role="treeitem"]')?.getAttribute('data-path')
    if (event.repeat || !path || recycleLock.current || copyLock.current) return
    setRecycleTarget(path)
  }
  const recycle = (path: string) => {
    setRecycleTarget(null)
    if (recycleLock.current || copyLock.current) return
    recycleLock.current = true; setError(''); setStatus(`Moving ${fileName(path)} to Recycle Bin…`)
    api('/files/recycle', { path }).catch(error => { recycleLock.current = false; setError(message(error)); setStatus('') })
  }
  const openContextMenu = (event: MouseEvent, path: string, directory: boolean, resource?: LibraryResource) => {
    event.preventDefault(); event.stopPropagation()
    if (path) setSelected(path)
    setContextMenu({ path, directory, resource, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)) })
  }
  const hubFileContextMenu = (event: MouseEvent, path: string, resource?: LibraryResource) => openContextMenu(event, path, false, resource)
  const dropProps = (folder: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = copyLock.current ? 'none' : 'copy'; setDropTarget(pathKey(folder))
    },
    onDragLeave: (event: DragEvent) => {
      event.stopPropagation()
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget('')
    },
    onDrop: (event: DragEvent) => {
      // eslint-disable-next-line react-hooks/refs -- This returned event handler runs on a user drop, never during render.
      void dropFiles(event, folder)
    },
  })
  const tree: TreeControls = {
    expanded, selected, dropTarget, query, revision, toggle, dropProps,
    contextMenu: (event, path, directory) => openContextMenu(event, path, directory),
    preview: entry => { setSelected(entry.path); setDestination(entry.path.replace(/[\\/][^\\/]+$/, '')); api<Preview>(`/preview?path=${encodeURIComponent(entry.path)}`).then(setPreview).catch(reportError) },
    drag: (event, path, directory) => {
      // Hand the held mouse gesture to Windows OLE with real file paths.
      event.preventDefault(); internalDrag.current = { path, directory, handled: false }; setError(''); setStatus(directory ? 'Drop into Chats to insert this folder path. Esc cancels.' : 'Drop into Chats to insert a path, or into another folder to move. Esc cancels.')
      api('/files/drag', { paths: [path] }).catch(error => { internalDrag.current = null; setError(message(error)); setStatus('') })
    },
  }
  return <aside className={`files-container ${open ? 'expanded' : ''}`}>
    {open && <div className="hub-rail-content">
    {open && <label className="hub-workspace-select">WORKSPACE<select aria-label="Active workspace" value={settings.selectedProjectId || ''} onChange={event => { void api('/settings', { selectedProjectId: event.target.value || null }).then(() => { setMode(panel === 'skills' ? 'all' : 'main'); setSelectedSkillRepositoryId(''); const project = projects.find(item => item.id === event.target.value); const linkedFolder = project?.repositories.find(item => item.available)?.repositoryPath; if (!linkedFolder) setSkillSource('hub'); navigate(panel === 'skills' ? linkedFolder && skillSource === 'linked' ? `${linkedFolder}/${skillAgent === 'codex' ? '.agents' : '.claude'}/skills` : `${repo}/${skillAgent === 'codex' ? '.agents' : '.claude'}/skills` : repo); window.location.hash = '' }).catch(reportError) }}><option value="">Mr. Mik Hub · Global</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}{!project.available ? ' · folder missing' : ''}</option>)}</select></label>}
    {open && panel === 'settings' && <WorkspaceSettings onClose={() => setOpen(false)} />}
    {open && panel === 'mcp' && <McpPanel onClose={() => setOpen(false)} />}
    {open && panel === 'projects' && <ProjectsPanel onClose={() => setOpen(false)} onSelect={() => { setMode('main'); navigate(repo) }} />}
    {open && (panel === 'knowledge' || panel === 'process' || panel === 'inbox') && <div className="files-panel hub-panel"><header><h2>{panel === 'process' ? 'Processes' : panel[0].toUpperCase() + panel.slice(1)}</h2><button className="desk-icon" onClick={() => setOpen(false)} aria-label={`Close ${panel}`}><Icon name="close" size={17} /></button></header><HubTree section={panel} fileRevision={revision} onFileContextMenu={hubFileContextMenu} /></div>}
    {open && (panel === 'files' || panel === 'skills') && <div className="files-panel"><header><h2>{panel === 'skills' ? 'Skills' : 'Files'}</h2><div>
      {panel === 'skills' ? <button className="desk-icon" onClick={() => setSkillCreateOpen(value => !value)} title="Add skill" aria-label="Add skill"><Icon name="plus" size={16} /></button> : mode === 'all' && <button className="desk-icon" disabled={copying} onClick={() => input.current?.click()} title={`Copy files into ${fileName(destination)}`} aria-label="Add files"><Icon name="plus" size={16} /></button>}
      <button className="desk-icon" onClick={refresh} title="Refresh files"><Icon name="refresh" size={15} /></button><button className="desk-icon" onClick={() => setOpen(false)} title="Collapse files"><Icon name="close" size={17} /></button>
    </div></header>
      <input ref={input} type="file" multiple hidden onChange={event => { void copy(Array.from(event.target.files || []), destination); event.target.value = '' }} />
      {panel === 'skills' && skillCreateOpen && <SkillCreate agent={skillAgent} initialTarget={skillSource} preferredLinkedId={selectedSkillRepositoryId} onClose={() => setSkillCreateOpen(false)} onCreated={skill => { setSkillCreateOpen(false); setSkillRevision(value => value + 1); setSkillSource(skill.repositoryId ? 'linked' : 'hub'); if (skill.repositoryId) setSelectedSkillRepositoryId(skill.repositoryId); navigate(skill.path.replace(/[\\/][^\\/]+$/, '')) }} />}
      {panel === 'skills' && <><div className="skill-navigation"><div className="skill-agent-tabs" role="group" aria-label="Skill agent"><button aria-pressed={skillAgent === 'codex'} onClick={() => { setSkillAgent('codex'); navigate(skillSource === 'linked' && selectedProject ? `${skillRoot}/.agents/skills` : `${repo}/.agents/skills`) }}>Codex</button><button aria-pressed={skillAgent === 'claude'} onClick={() => { setSkillAgent('claude'); navigate(skillSource === 'linked' && selectedProject ? `${skillRoot}/.claude/skills` : `${repo}/.claude/skills`) }}>Claude</button></div><div className="skill-source-tabs" role="group" aria-label="Skill location"><button aria-pressed={skillSource === 'hub' || !selectedProject} onClick={() => { setSkillSource('hub'); navigate(hubSkillFolder) }}>Hub</button><button aria-pressed={skillSource === 'linked' && !!selectedProject} disabled={!selectedProject?.repositories.some(item => item.available)} onClick={() => { setSkillSource('linked'); navigate(nativeSkillFolder) }}>Linked project</button></div></div>
      {skillSource === 'hub' || !selectedProject ? <HubSkills key={`${skillAgent}:${skillRevision}`} agent={skillAgent} /> : <NativeSkills key={`${skillAgent}:${selectedProject.id}:${selectedSkillRepositoryId}:${skillRevision}`} agent={skillAgent} projectId={selectedProject.id} repositoryId={selectedSkillRepositoryId || selectedProject.repositories.find(repository => repository.available)?.id || selectedProject.repositories[0]?.id || ''} />}
      </>}
      {panel === 'files' ? <><div className="file-mode"><button className={mode === 'main' ? 'selected' : ''} onClick={() => { setMode('main'); navigate(repo) }}>Main folders</button><button className={mode === 'all' ? 'selected' : ''} onClick={() => setMode('all')}>Browse files</button></div>{mode === 'all' && <div className="file-root-choice"><span>ROOT</span><DarkSelect label="File browser root" value={currentRepository ? currentRepository.projectId + ':' + currentRepository.id : ''} options={[{ value: '', label: 'Mr. Mik Hub / custom path' }, ...repositories.map(repository => ({ value: repository.projectId + ':' + repository.id, label: repository.projectName + ' · ' + repository.name, disabled: !repository.available }))]} onChange={value => { const repository = repositories.find(item => item.projectId + ':' + item.id === value); navigate(repository?.repositoryPath || repo) }} /></div>}</> : <div className="skill-locations"><strong>{skillSource === 'linked' && selectedProject ? 'Linked-project' : 'Hub'} {skillAgent === 'codex' ? 'Codex' : 'Claude'} skill files</strong>{skillSource === 'linked' && selectedProject && selectedProject.repositories.length > 1 && <label>Linked project<select aria-label="Native skill linked project" value={selectedSkillRepositoryId || selectedProject.repositories.find(item => item.available)?.id || selectedProject.repositories[0].id} onChange={event => { setSelectedSkillRepositoryId(event.target.value); const repository = selectedProject.repositories.find(item => item.id === event.target.value); if (repository?.repositoryPath) navigate(`${repository.repositoryPath}/${skillAgent === 'codex' ? '.agents' : '.claude'}/skills`) }}>{selectedProject.repositories.map(repository => <option key={repository.id} value={repository.id} disabled={!repository.available}>{repository.name}</option>)}</select></label>}<p>{skillSource === 'linked' && selectedProject ? `Browse the selected folder below. Native skill availability is decided by ${skillAgent === 'codex' ? 'Codex' : 'Claude'} when its chat starts.` : 'Browse Hub skill files below. Workspace availability is managed above.'}</p></div>}
      {(panel === 'skills' || mode === 'all') && <>
      <form className="file-path" onSubmit={event => { event.preventDefault(); setMode('all'); navigate(typedPath) }}><button type="button" title="Parent folder" onClick={() => { setMode('all'); navigate(rootFolder?.parent || repo) }}><Icon name="up" size={15} /></button><input value={typedPath} onChange={event => setTypedPath(event.target.value)} spellCheck={false} aria-label="Folder path" /><button type="submit" title="Open folder"><Icon name="arrow" size={14} /></button></form>
      <div className="file-filter"><Icon name="search" size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter file names…" aria-label="Filter file names in expanded folders" /></div>
      <div className={`file-list ${dropTarget === pathKey(destination) ? 'drop-area' : ''}`} role="tree" aria-label="Folder tree" onKeyDown={deleteKey} {...dropProps(destination)}>
        <div role="none" className="file-entry has-reveal" {...dropProps(root)}><button role="treeitem" aria-level={1} aria-expanded="true" aria-selected={pathKey(selected) === pathKey(root)} className={`file-row file-root-row ${dropTarget === pathKey(root) ? 'drop-target' : ''}`} onClick={() => { setSelected(root); setDestination(root) }} onContextMenu={event => tree.contextMenu(event, root, true)} {...dropProps(root)} title={root}><Icon name="arrow" size={11} style={{ transform: 'rotate(90deg)' }} /><Icon name="folder" size={15} /><span>{pathKey(root) === pathKey(repo) ? 'MR-MAK' : fileName(root)}</span></button><RevealFolder path={root} name={pathKey(root) === pathKey(repo) ? 'MR-MAK' : fileName(root)} /></div>
        <FolderBranch key={`${root}:${mode}`} path={root} mode={mode} tree={tree} onLoad={loaded} />
      </div>
      <div className="file-transfer-status" aria-live="polite">{error && <p className="desk-error-inline">{error}</p>}{status && <p>{status}</p>}<small title={destination}>{copying ? 'Transferring files…' : 'Drag to move · Delete to Recycle Bin'}</small></div>
      {panel === 'files' && <footer><button onClick={() => navigate(repo)}>MR-MAK root</button></footer>}
      </>}
      {panel === 'files' && mode === 'main' && <HubTree fileRevision={revision} onFileContextMenu={hubFileContextMenu} />}
    </div>}
    </div>}
    {contextMenu && <div className="file-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={event => event.stopPropagation()}>
      <button role="menuitem" onClick={() => { const item = contextMenu; setContextMenu(null); if (item.resource) void api<{ path: string }>(`/resources/location?kind=${encodeURIComponent(item.resource.kind)}&id=${encodeURIComponent(item.resource.id)}`).then(result => api('/reveal', { path: result.path })).catch(reportError); else void api('/reveal', { path: item.path }).catch(reportError) }}>Open in Explorer</button>
      {contextMenu.resource?.repositoryProjectId ? <button role="menuitem" className="danger" onClick={() => { setUnlinkTarget(contextMenu.resource || null); setContextMenu(null) }}>Remove link from Hub</button> : pathKey(contextMenu.path) !== pathKey(root) && <button role="menuitem" className="danger" onClick={() => { setRecycleTarget(contextMenu.path); setContextMenu(null) }}>Move to Recycle Bin</button>}
    </div>}
    {recycleTarget && <div className="file-confirm-backdrop" role="presentation"><div className="file-confirm" role="alertdialog" aria-modal="true" aria-labelledby="file-confirm-title" aria-describedby="file-confirm-text">
      <h3 id="file-confirm-title">Move to Recycle Bin?</h3><p id="file-confirm-text">{fileName(recycleTarget)} will be removed from {pathKey(recycleTarget).startsWith(pathKey(repo) + '/') ? 'the Mr. Mik Hub' : 'the linked folder'}. You can restore it from Windows Recycle Bin.</p>
      <div><button onClick={() => setRecycleTarget(null)}>Cancel</button><button className="danger" onClick={() => recycle(recycleTarget)}>Move to Recycle Bin</button></div>
    </div></div>}
    {unlinkTarget && <div className="file-confirm-backdrop" role="presentation"><div className="file-confirm" role="alertdialog" aria-modal="true" aria-labelledby="unlink-confirm-title" aria-describedby="unlink-confirm-text">
      <h3 id="unlink-confirm-title">Remove link from Hub?</h3><p id="unlink-confirm-text">{unlinkTarget.title} will disappear from the Mr. Mik library. Its original file in the linked project will not be changed.</p>
      <div><button onClick={() => setUnlinkTarget(null)}>Cancel</button><button className="danger" onClick={() => { const item = unlinkTarget; setUnlinkTarget(null); void api('/resources/unlink', { kind: item.kind, id: item.id }).then(refresh).catch(cause => setError(message(cause))) }}>Remove link</button></div>
    </div></div>}
    <div className="files-rail">{(['projects', 'files', 'knowledge', 'process', 'inbox', 'skills', 'mcp', 'settings'] as const).map(name => <button key={name} className={`rail-tool ${open && panel === name ? 'active' : ''}`} onClick={() => showPanel(name)} title={name === 'mcp' ? 'Tools' : name === 'process' ? 'Processes' : name === 'projects' ? 'Workspaces' : name[0].toUpperCase() + name.slice(1)} aria-label={`Toggle ${name}`} aria-pressed={open && panel === name}><Icon name={name} size={18} /><span>{name === 'process' ? 'Processes' : name === 'mcp' ? 'Tools' : name === 'projects' ? 'Workspaces' : name}</span></button>)}<button className="rail-tool" title="Workspace help" aria-label="Open Workspace help" onClick={() => setHelpOpen(true)}><Icon name="help" size={18} /><span>Help</span></button><div className="rail-spacer" /><button className="desk-icon" title="Show Chats" onClick={() => windowAction('chats')}><Icon name="chats" size={18} /></button></div>
    {helpOpen && <HelpSite onClose={() => setHelpOpen(false)} />}
  </aside>
}
