import { useEffect, useState } from 'react'
import { api, onServiceEvent, reportError, selectChat, setPreview, useDesktop } from './client'
import type { AgentId, ChatSession, LibraryResource, Preview, Project } from './types'
import type { WorkspaceEntity } from '../types'
import './projects.css'

type CodexItem = { kind: 'plugin' | 'mcp' | 'skill'; id: string; name: string; source: string; location: string; version?: string | null; installed?: boolean; bundledSkills?: string[]; globalEnabled: boolean; projectOverride: boolean | null; editable: boolean; note: string }
type CodexScopes = { trust: string; file: string; globalFile: string; notice: string; rows: CodexItem[]; duplicates: { name: string; sources: string[] }[] }
type EffectiveCodex = { checkedAt: string; projectLayerLoaded: boolean; plugins: Record<string, boolean>; mcp: Record<string, boolean>; skills: { path: string; enabled: boolean }[]; note: string }

async function openProjectChat(projectId: string, agent: AgentId = 'codex') {
  const session = await api<ChatSession>('/sessions', { projectId, agent, name: 'Project Planning' })
  selectChat(session.id)
}

export default function ProjectHub() {
  const state = useDesktop()
  const selected = state.settings.selectedProjectId || ''
  const project = state.projects.find(item => item.id === selected)
  const [panel, setPanel] = useState('')
  const [name, setName] = useState(''), [location, setLocation] = useState(''), [editing, setEditing] = useState('')
  const [type, setType] = useState('other'), [associateCard, setAssociateCard] = useState('')
  const [details, setDetails] = useState<Project | null>(null)
  const [ide, setIde] = useState<string | null>(null)
  const [resources, setResources] = useState<LibraryResource[]>([])
  const [cards, setCards] = useState<WorkspaceEntity[]>([])
  const [scope, setScope] = useState('relevant'), [query, setQuery] = useState('')
  const [documentPath, setDocumentPath] = useState('')
  const [cardTitle, setCardTitle] = useState(''), [noteCard, setNoteCard] = useState(''), [noteTitle, setNoteTitle] = useState(''), [noteText, setNoteText] = useState('')
  const [artifactCard, setArtifactCard] = useState(''), [artifactPath, setArtifactPath] = useState('')
  const [codexScopes, setCodexScopes] = useState<CodexScopes | null>(null)
  const [effective, setEffective] = useState<EffectiveCodex | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => onServiceEvent(event => { if (['projects-changed', 'workspace-changed'].includes(event.type)) setRevision(value => value + 1) }), [])
  useEffect(() => {
    let active = true
    if (panel === 'projects') {
      api<{ entities: WorkspaceEntity[] }>('/workspace').then(value => { if (active) setCards(value.entities) }).catch(reportError)
      api<{ ide: string | null }>('/projects/ide').then(value => { if (active) setIde(value.ide) }).catch(reportError)
      if (selected) api<Project>(`/projects/${selected}`).then(value => { if (active) setDetails(value) }).catch(reportError)
    } else if (panel === 'codex' && selected) {
      api<CodexScopes>(`/codex/scopes?projectId=${encodeURIComponent(selected)}`).then(value => { if (active) setCodexScopes(value) }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    } else if (['knowledge', 'process', 'inbox'].includes(panel)) {
      api<LibraryResource[]>(`/resources?kind=${panel}&projectId=${encodeURIComponent(selected)}&scope=${scope}`).then(value => { if (active) setResources(value) }).catch(reportError)
    }
    return () => { active = false }
  }, [panel, selected, scope, revision])
  const action = async (callback: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await callback(); setRevision(value => value + 1) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const visibleResources = resources.filter(item => item.kind === panel && (scope === 'all' || (scope === 'global' ? !item.projectId : scope === 'project' ? item.projectId === selected : !item.projectId || item.projectId === selected)))
  const choose = (id: string) => { void api('/settings', { selectedProjectId: id || null }).catch(reportError); locationHashReset() }
  const recentChats = state.sessions.filter(session => session.projectId === selected).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6)
  function locationHashReset() { window.location.hash = '' }
  return <>
    <nav className="project-toolbar" aria-label="Project workspace">
      <label>Workspace <select aria-label="Active project workspace" value={selected} onChange={event => choose(event.target.value)}><option value="">Mr. Mik Hub · all cards</option>{state.projects.map(item => <option key={item.id} value={item.id}>{item.name}{!item.available ? ' · missing folder' : ''}</option>)}{selected && !project && <option value={selected}>Unlinked project</option>}</select></label>
      {['projects', 'knowledge', 'process', 'inbox', ...(project ? ['codex'] : [])].map(value => <button key={value} aria-pressed={panel === value} onClick={() => { setPanel(panel === value ? '' : value); setError('') }}>{value === 'process' ? 'Processes' : value === 'codex' ? 'Codex tools' : value[0].toUpperCase() + value.slice(1)}</button>)}
      {project && <button disabled={!project.available} onClick={() => void openProjectChat(project.id).catch(reportError)}>New Codex Chat</button>}
    </nav>
    {panel && <section className="project-library" aria-label={panel === 'projects' ? 'Projects' : panel === 'codex' ? 'Codex tools' : 'Shared library'}>
      <header><h2>{panel === 'process' ? 'Processes' : panel === 'codex' ? 'Codex tools' : panel[0].toUpperCase() + panel.slice(1)} <small>{project?.name || 'Mr. Mik Hub'}</small></h2><button onClick={() => setPanel('')} aria-label="Close project panel">Close</button></header>
      {error && <p role="alert">{error}</p>}
      {panel === 'codex' ? <>
        <p>Configure this repository’s Codex CLI settings without copying installations or changing your personal config. Current chats keep their original settings.</p>
        {codexScopes ? <><p>{codexScopes.notice} Trust: {codexScopes.trust}. Project file: <code>{codexScopes.file}</code></p>
          <button disabled={busy} onClick={() => void action(async () => { setEffective(await api<EffectiveCodex>(`/codex/effective?projectId=${encodeURIComponent(selected)}`)) })}>Check resolved Codex config</button>
          {effective && <div><p>{effective.note} Checked {new Date(effective.checkedAt).toLocaleString()}. Project config layer: {effective.projectLayerLoaded ? 'loaded' : 'not confirmed'}.</p><p>Plugins: {Object.entries(effective.plugins).map(([id, enabled]) => `${id} (${enabled ? 'on' : 'off'})`).join(' · ') || 'none'}</p><p>MCP: {Object.entries(effective.mcp).map(([id, enabled]) => `${id} (${enabled ? 'on' : 'off'})`).join(' · ') || 'none'}</p><p>Explicit skill overrides: {effective.skills.map(item => `${item.path} (${item.enabled ? 'on' : 'off'})`).join(' · ') || 'none'}</p></div>}
          {codexScopes.duplicates.map(item => <p key={item.name}>Possible duplicate skill “{item.name}”: {item.sources.join(' + ')}. Codex may list both rather than merge them.</p>)}
          {(['plugin', 'skill', 'mcp'] as const).map(kind => <div key={kind}><h3>{kind === 'plugin' ? 'Plugins' : kind === 'skill' ? 'Standalone skills' : 'MCP servers'}</h3>
            {codexScopes.rows.filter(item => item.kind === kind).map(item => <article className="codex-scope-row" key={`${kind}:${item.id}`}><div><strong>{item.name}</strong>{item.version && <small> · {item.version}</small>}<p>{item.source} · {item.projectOverride == null ? 'Inherited / discovered' : item.projectOverride ? 'Enabled in project' : 'Disabled in project'}{item.globalEnabled ? ' · enabled globally' : ''}</p>{item.bundledSkills?.length ? <p>Bundled skills: {item.bundledSkills.join(', ')}</p> : null}{item.note && <p>{item.note}</p>}<code>{item.location}</code></div><div className="project-actions"><button disabled={busy || !item.editable || item.installed === false} onClick={() => void action(() => api('/codex/scopes', { projectId: selected, kind, id: item.id, enabled: true }))}>Enable here</button><button disabled={busy || !item.editable} onClick={() => void action(() => api('/codex/scopes', { projectId: selected, kind, id: item.id, enabled: false }))}>Disable here</button>{item.projectOverride !== null && item.editable && <button disabled={busy} onClick={() => void action(() => api('/codex/scopes', { projectId: selected, kind, id: item.id, enabled: null }))}>Inherit</button>}</div>{!item.editable && <small>Already configured outside Mr. Mik or host-managed; edit its source directly.</small>}</article>)}
            {!codexScopes.rows.some(item => item.kind === kind) && <p>No {kind} entries found for this project.</p>}
          </div>)}
          <p>Important: enabling here does not turn off a globally enabled component in other projects. Disable its global setting separately if you want opt-in-only behavior. Workspace-managed plugins may not honor repository overrides.</p><button onClick={() => void api('/reveal', { path: codexScopes.globalFile }).catch(reportError)}>Show personal Codex config in Explorer</button>
        </> : <p>Reading Codex settings…</p>}
      </> : panel === 'projects' ? <>
        <form onSubmit={event => { event.preventDefault(); void action(async () => { const saved = await api<Project>('/projects', { id: editing || undefined, name, type, repositoryPath: location }); if (associateCard) await api('/cards/assign', { id: associateCard, projectId: saved.id }); setName(''); setLocation(''); setType('other'); setAssociateCard(''); setEditing(''); choose(saved.id) }) }}>
          <h3>{editing ? 'Relink / rename project' : 'Add existing project'}</h3>
          <label>Name<input required value={name} onChange={event => setName(event.target.value)} maxLength={100} /></label>
          <label>Repository folder<input required placeholder="Absolute external repository path" value={location} onChange={event => setLocation(event.target.value)} /></label>
          <label>Type (optional)<select value={type} onChange={event => setType(event.target.value)}><option value="other">Other</option><option value="software">Software</option><option value="unity">Unity</option></select></label>
          <label>Associate existing card (optional)<select value={associateCard} onChange={event => setAssociateCard(event.target.value)}><option value="">None</option>{cards.filter(card => !card.projectId || card.projectId === editing).map(card => <option key={card.id} value={card.id}>{card.title}</option>)}</select></label>
          <p>Registers a location only. No repository copies, config changes or automatic trust.</p>
          <button disabled={busy}>Save project</button>{editing && <button type="button" onClick={() => { setEditing(''); setName(''); setLocation('') }}>Cancel</button>}
        </form>
        <div className="project-list">{state.projects.map(item => <article key={item.id}><button onClick={() => choose(item.id)}>{item.name}</button><small>{item.available ? 'Available' : 'Relink required'}</small><code>{item.repositoryPath || 'No local location'}</code><button onClick={() => { setEditing(item.id); setName(item.name); setType(item.type || 'other'); setLocation(item.repositoryPath || '') }}>Relink / rename</button><button disabled={busy} onClick={() => { if (window.confirm(`Remove ${item.name} from Mr. Mik? Repository, cards and history will be retained.`)) void action(async () => { await api(`/projects/${item.id}`, {}, 'DELETE'); if (selected === item.id) choose('') }) }}>Remove registration</button></article>)}</div>
        {details && details.id === selected && <article><h3>{details.name}</h3><p>Git branch: {details.branch || 'Not detected'}</p><p>{Object.entries(details.detected || {}).filter(([, found]) => found).map(([file]) => file).join(' · ')}</p><div className="project-actions">{(['codex', 'claude', 'shell'] as const).map(agent => <button key={agent} disabled={!details.available || !state.agents.find(item => item.id === agent)?.available} onClick={() => void openProjectChat(details.id, agent).catch(reportError)}>New {agent === 'shell' ? 'Terminal' : agent} Chat</button>)}<button disabled={!details.available} onClick={() => void api('/reveal', { path: details.repositoryPath }).catch(reportError)}>Open Explorer</button><button disabled={!details.available || !ide} onClick={() => void api('/projects/open-ide', { projectId: details.id }).catch(reportError)}>Open IDE{ide ? ` · ${ide}` : ''}</button></div><p>Codex project chats receive a scoped Workspace Bridge, not writable hub access.</p><h4>Recent chats</h4>{recentChats.map(chat => <div className="resource-row" key={chat.id}><button onClick={() => void action(async () => { if (!chat.open || chat.status !== 'running') await api(`/sessions/${chat.id}/resume`, {}); selectChat(chat.id); setPanel('') })}>{chat.name} · {chat.agent}<small>{new Date(chat.updatedAt).toLocaleString()}</small></button></div>)}{!recentChats.length && <p>No chats for this project yet.</p>}</article>}
        <form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/cards', { projectId: selected || null, title: cardTitle }); setCardTitle('') }) }}><label>New card in {project?.name || 'Hub'}<input required value={cardTitle} onChange={event => setCardTitle(event.target.value)} maxLength={160} /></label><button disabled={busy}>Create card</button></form>
        <h3>Card associations</h3>{cards.map(card => <div key={card.id}><div className="resource-row"><a href={`#/${encodeURIComponent(card.id)}`} onClick={() => { if (card.projectId && state.projects.some(item => item.id === card.projectId)) void api('/settings', { selectedProjectId: card.projectId }).catch(reportError); else void api('/settings', { selectedProjectId: null }).catch(reportError); setPanel('') }}>{card.title}</a><button onClick={() => { setNoteCard(noteCard === card.id ? '' : card.id); setNoteTitle(''); setNoteText('') }}>Add note</button>{card.projectId && <button onClick={() => { setArtifactCard(artifactCard === card.id ? '' : card.id); setArtifactPath('') }}>Link artifact</button>}<select aria-label={`Project for ${card.title}`} disabled={busy} value={card.projectId || ''} onChange={event => void action(() => api('/cards/assign', { id: card.id, projectId: event.target.value || null }))}><option value="">Hub · no project</option>{state.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}{card.projectId && !state.projects.some(item => item.id === card.projectId) && <option value={card.projectId}>Unlinked project</option>}</select></div>{noteCard === card.id && <form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/cards/note', { id: card.id, projectId: card.projectId || null, title: noteTitle, text: noteText }); setNoteCard(''); setNoteTitle(''); setNoteText('') }) }}><label>Note title<input required maxLength={160} value={noteTitle} onChange={event => setNoteTitle(event.target.value)} /></label><label>Markdown<textarea value={noteText} onChange={event => setNoteText(event.target.value)} rows={7} /></label><button disabled={busy}>Save note</button></form>}{artifactCard === card.id && <form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/cards/artifact', { id: card.id, projectId: card.projectId, path: artifactPath }); setArtifactCard(''); setArtifactPath('') }) }}><label>Repository-relative artifact path<input required placeholder="build/report.pdf" value={artifactPath} onChange={event => setArtifactPath(event.target.value)} /></label><button disabled={busy}>Link existing file</button></form>}{card.artifacts?.filter(artifact => artifact.projectId === card.projectId).map(artifact => <div className="resource-row" key={artifact.path}><button onClick={() => void api<Preview>(`/cards/artifact/preview?projectId=${encodeURIComponent(card.projectId || '')}&id=${encodeURIComponent(card.id)}&path=${encodeURIComponent(artifact.path)}`).then(setPreview).catch(reportError)}>{artifact.title}<small>{artifact.path}</small></button></div>)}</div>)}
      </> : <>
        <p>{panel === 'inbox' ? 'One shared Inbox. Assignment never moves the original file.' : 'Documents stay in the shared library. Procedures run only when explicitly requested; no full documents are loaded into chats automatically.'}</p>
        <div className="project-actions"><select aria-label="Library scope" value={scope} onChange={event => setScope(event.target.value)}><option value="all">All projects</option><option value="global">{panel === 'inbox' ? 'Unassigned' : 'Global only'}</option><option value="relevant">{selected ? 'Global + active project' : 'Global / unassigned'}</option><option value="project" disabled={!selected}>Active project only</option></select><input aria-label="Search library" placeholder="Filter title or path" value={query} onChange={event => setQuery(event.target.value)} /></div>
        {panel === 'knowledge' && project && <form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/resources/link', { projectId: selected, path: documentPath }); setDocumentPath('') }) }}><label>Link technical documentation from {project.name}<input required placeholder="docs/architecture.md" value={documentPath} onChange={event => setDocumentPath(event.target.value)} /></label><button disabled={busy}>Link without copying</button></form>}
        {visibleResources.filter(item => `${item.title} ${item.path}`.toLowerCase().includes(query.toLowerCase())).map(item => <div className="resource-row" key={item.id}><button onClick={() => void api<Preview>(`/resources/preview?kind=${item.kind}&id=${encodeURIComponent(item.id)}`).then(setPreview).then(() => setPanel('')).catch(reportError)}>{item.title}<small>{item.repositoryProjectId ? 'Repository link · ' : ''}{item.path}</small></button><select aria-label={`Project for ${item.title}`} disabled={busy || !!item.repositoryProjectId} value={item.projectId || ''} onChange={event => void action(() => api('/resources/assign', { kind: item.kind, path: item.path, projectId: event.target.value || null }))}><option value="">{panel === 'inbox' ? 'Unassigned' : 'Global'}</option>{state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}{item.projectId && !state.projects.some(project => project.id === item.projectId) && <option value={item.projectId}>Unlinked project</option>}</select></div>)}
        {!visibleResources.length && <p>No resources match this scope. Add documents through Files; they remain compatible without metadata.</p>}
      </>}
    </section>}
  </>
}
