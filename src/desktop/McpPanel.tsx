import { useCallback, useEffect, useRef, useState } from 'react'
import { api, useDesktop } from './client'
import { AgentLogo, Icon } from './Icons'
import type { AgentId } from './types'
import DarkSelect from './DarkSelect'
import './mcp.css'
import './mcp-editor.css'

type Check = { status: 'available' | 'agent-auth' | 'timeout' | 'unavailable'; toolCount: number | null; moreTools?: boolean; checkedAt: string; stale?: boolean }
type Server = {
  id: string; name: string; client: 'codex' | 'claude' | 'kimi' | 'cursor'; scope: string; enabled: boolean
  readiness: string; transport: string; endpoint: string; executable: string | null; plugin: string | null
  sources: { scope: string; path: string; effective: boolean }[]; missingEnv: string[]; credentialNames: string[]; canCheck: boolean; connection: Check | null
}
type Inventory = { scannedAt: string; servers: Server[]; sources: { client: string; scope: string; path: string }[]; problems: { path: string; message: string }[] }
type Managed = { scope: string; file: string; servers: { name: string; transport: string; enabled: boolean; managed?: boolean }[]; disabledMcpServers?: string[]; disabledGlobal?: string[]; note: string }
type ScopeRow = { agent?: 'codex' | 'claude'; kind: 'plugin' | 'skill' | 'mcp'; id: string; name: string; source: string; version?: string | null; installed?: boolean; globalEnabled: boolean; globalOverride: boolean | null; projectOverride: boolean | null; editable: boolean; globalEditable: boolean; projectEditable: boolean; projectDefined: boolean; managedBy?: string; note: string }
type ScopeInventory = { trust: string; rows: ScopeRow[]; duplicates: { name: string; sources: string[] }[]; notice: string }
const clients = { codex: 'Codex', claude: 'Claude', kimi: 'Kimi', cursor: 'Cursor' }
const scopes: Record<string, string> = { project: 'Linked project', local: 'Linked project · this PC', global: 'Global', plugin: 'Plugin', managed: 'Managed' }
const stateLabel: Record<string, string> = { configured: 'Enabled', disabled: 'Disabled', managed: 'Host managed', 'missing-env': 'Needs setup', 'missing-command': 'Not installed', approval: 'Needs approval', 'invalid-config': 'Invalid configuration', 'unsupported-check': 'Check in agent' }
const checkLabel: Record<string, string> = { available: 'Available', 'agent-auth': 'Check login in agent', timeout: 'Timed out', unavailable: 'Not reachable' }

export default function McpPanel({ onClose }: { onClose: () => void }) {
  const state = useDesktop()
  const project = state.projects.find(item => item.id === state.settings.selectedProjectId)
  const projectId = project?.repositories.length ? project.id : ''
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('')
  const repositoryId = selectedRepositoryId && project?.repositories.some(item => item.id === selectedRepositoryId && item.available) ? selectedRepositoryId : project?.repositories.find(item => item.available)?.id || ''
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [client, setClient] = useState('all')
  const [scope, setScope] = useState('all')
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [managedScope, setManagedScope] = useState(projectId ? 'project' : 'global')
  const definitionScope = projectId ? managedScope : 'global'
  const [managed, setManaged] = useState<Managed | null>(null)
  const [claudeManaged, setClaudeManaged] = useState<Managed | null>(null)
  const [claudeGlobal, setClaudeGlobal] = useState<Managed | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorAgent, setEditorAgent] = useState<'codex' | 'claude'>('codex')
  const [showHidden, setShowHidden] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem('mrmak.tools.hidden') || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [] } catch { return [] } })
  const [visibleSystemIds, setVisibleSystemIds] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem('mrmak.tools.visible-system') || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [] } catch { return [] } })
  const [tools, setTools] = useState<ScopeInventory | null>(null)
  const [claudeTools, setClaudeTools] = useState<ScopeInventory | null>(null)
  const [editName, setEditName] = useState(''), [transport, setTransport] = useState('http'), [address, setAddress] = useState(''), [command, setCommand] = useState(''), [argumentsText, setArgumentsText] = useState('')
  const [claudeName, setClaudeName] = useState(''), [claudeTransport, setClaudeTransport] = useState('http'), [claudeAddress, setClaudeAddress] = useState(''), [claudeCommand, setClaudeCommand] = useState(''), [claudeArgs, setClaudeArgs] = useState('')
  const [editing, setEditing] = useState(false)
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  // Repository validity depends on the live project list; this callback must refresh when it changes.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const refresh = useCallback(async () => {
    const request = ++generation.current
    void api<ScopeInventory>(`/claude/scopes?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`).then(value => { if (request === generation.current) setClaudeTools(value) }).catch(cause => { if (request === generation.current) setError(String(cause.message || cause)) })
    try { const [result, definitions, claude, claudeUser, scoped] = await Promise.all([api<Inventory>(`/mcp?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`), api<Managed>(`/codex/mcp-managed?scope=${definitionScope}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`), projectId ? api<Managed>(`/claude/mcp-managed?scope=local&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`) : Promise.resolve(null), api<Managed>('/claude/mcp-managed?scope=global'), api<ScopeInventory>(`/codex/scopes?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)]); if (request === generation.current) { setInventory(result); setManaged(definitions); setClaudeManaged(claude); setClaudeGlobal(claudeUser); setTools(scoped); setError('') } }
    catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : String(error)) }
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  }, [projectId, repositoryId, definitionScope])
  useEffect(() => {
    void Promise.resolve().then(refresh); const onFocus = () => { void refresh() }; window.addEventListener('focus', onFocus)
    const timer = window.setInterval(onFocus, 30000)
    return () => { invalidate(); window.removeEventListener('focus', onFocus); clearInterval(timer) }
  }, [refresh, invalidate])
  const check = async (server: Server) => {
    setBusy(value => new Set([...value, server.id])); setError('')
    try { await api('/mcp/check', { id: server.id, projectId, repositoryId }); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(value => { const next = new Set(value); next.delete(server.id); return next }) }
  }
  const changeManaged = async (action: 'save' | 'toggle' | 'remove', name: string, enabled?: boolean) => {
    if (definitionScope === 'global' && !window.confirm(`Change the personal Codex MCP configuration for all projects? ${name}`)) return
    if (action === 'remove' && !window.confirm(`Remove Mr. Mik's ${name} MCP definition from ${definitionScope} config?`)) return
    setEditing(true); setError('')
    try {
      await api('/codex/mcp-managed', { scope: definitionScope, projectId, repositoryId, action, name, transport, url: address, command, args: argumentsText.split('\n').map(value => value.trim()).filter(Boolean), enabled: enabled ?? true })
      setEditName(''); setAddress(''); setCommand(''); setArgumentsText(''); await refresh()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setEditing(false) }
  }
  const changeClaude = async (action: 'save' | 'toggle' | 'remove' | 'override', name: string, enabled?: boolean | null) => {
    if (definitionScope === 'project' && !projectId) return
    if (action === 'remove' && !window.confirm(`Remove Mr. Mik's Claude MCP definition ${name} from ${definitionScope === 'global' ? 'your user configuration' : 'this linked project'}?`)) return
    setEditing(true); setError('')
    try {
      await api('/claude/mcp-managed', { projectId, repositoryId, scope: definitionScope === 'global' ? 'global' : 'local', action, name, transport: claudeTransport, url: claudeAddress, command: claudeCommand, args: claudeArgs.split('\n').map(value => value.trim()).filter(Boolean), enabled: action === 'override' ? enabled : enabled ?? true })
      setClaudeName(''); setClaudeAddress(''); setClaudeCommand(''); setClaudeArgs(''); await refresh()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setEditing(false) }
  }
  const toggleVisibility = (id: string, system: boolean) => {
    if (system) { const next = visibleSystemIds.includes(id) ? visibleSystemIds.filter(item => item !== id) : [...visibleSystemIds, id]; setVisibleSystemIds(next); localStorage.setItem('mrmak.tools.visible-system', JSON.stringify(next)) }
    else { const next = hiddenIds.includes(id) ? hiddenIds.filter(item => item !== id) : [...hiddenIds, id]; setHiddenIds(next); localStorage.setItem('mrmak.tools.hidden', JSON.stringify(next)) }
  }
  const claudeServerControls = (server: Server) => {
    if (server.plugin || server.scope === 'managed') return <p className="mcp-note">{server.plugin ? 'Use the Claude plugin entry to manage this server.' : 'Managed by Claude policy.'}</p>
    const global = claudeGlobal?.servers.find(item => item.name === server.name)
    const local = claudeManaged?.servers.find(item => item.name === server.name)
    const change = async (scope: 'global' | 'local', enabled: boolean | null) => {
      setEditing(true); setError('')
      try { await api('/claude/mcp-managed', { projectId, repositoryId, scope, action: scope === 'global' ? 'toggle' : 'override', name: server.name, enabled }); await refresh() }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      finally { setEditing(false) }
    }
    return <div className="mcp-scope-controls">{global && <label>Global<DarkSelect compact disabled={editing} label={`${server.name} global Claude MCP`} value={global.enabled ? 'on' : 'off'} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void change('global', value === 'on')} /></label>}{projectId && <label>Linked project<DarkSelect compact disabled={editing} label={`${server.name} linked Claude MCP`} value={claudeManaged?.disabledMcpServers?.includes(server.name) ? 'off' : global?.enabled === false && local?.enabled ? 'on' : 'inherit'} options={[{ value: 'inherit', label: 'Inherit' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void change('local', value === 'inherit' ? null : value === 'on')} /></label>}</div>
  }
  const systemServer = (server: Server) => server.client === 'codex' && ['node_repl', 'cua_repl', 'codex_app'].includes(server.name)
  const systemPlugin = (id: string) => id.startsWith('codex-app-tools@')
  const hiddenEntry = (id: string, system = false) => system ? !visibleSystemIds.includes(id) : hiddenIds.includes(id)
  const isHidden = (id: string, system = false) => !showHidden && hiddenEntry(id, system)
  const visible = (inventory?.servers || []).filter(server => (client === 'all' || server.client === client)
    && (kind === 'all' || kind === 'mcp')
    && (scope === 'all' || (scope === 'project' ? !!projectId && (server.sources.some(source => ['project', 'local'].includes(source.scope)) || (server.client === 'claude' && server.scope !== 'managed') || server.client === 'codex' && (server.plugin ? tools?.rows.some(row => row.kind === 'plugin' && row.id === server.plugin && row.projectEditable) : tools?.rows.some(row => row.kind === 'mcp' && row.id === server.name && row.projectEditable))) : scope === 'global' ? server.sources.some(source => source.scope === 'global') : server.scope === scope))
    && `${server.name} ${server.endpoint} ${server.plugin || ''}`.toLowerCase().includes(query.toLowerCase()) && !isHidden(server.id, systemServer(server)) && (!server.plugin || !isHidden(`plugin:${server.plugin}`, systemPlugin(server.plugin))))
  const visibleComponents = [...(tools?.rows || []), ...(claudeTools?.rows || []).map(row => ({ ...row, agent: 'claude' as const }))].filter(row => row.kind === 'plugin' && (client === 'all' || client === (row.agent || 'codex'))
    && (kind === 'all' || row.kind === kind)
    && (scope === 'all' || scope === 'plugin' && row.kind === 'plugin' || scope === 'project' && row.projectEditable || scope === 'global' && row.globalEditable)
    && `${row.name} ${row.source}`.toLowerCase().includes(query.toLowerCase()) && !isHidden(`plugin:${row.id}`, systemPlugin(row.id)))
  const toggleTool = async (row: ScopeRow, scopeChoice: 'global' | 'project', enabled: boolean | null) => {
    if (row.agent === 'claude') {
      setEditing(true); setError('')
      try { await api('/claude/scopes', { projectId, repositoryId, kind: row.kind, id: row.id, scope: scopeChoice, enabled }); await refresh() }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      finally { setEditing(false) }
      return
    }
    if (scopeChoice === 'global' && !window.confirm(`Change ${row.name} in your personal Codex configuration for all projects?`)) return
    setEditing(true); setError('')
    try { await api('/codex/scopes', { projectId, repositoryId, kind: row.kind, id: row.id, scope: scopeChoice, enabled }); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setEditing(false) }
  }
  const controls = (row: ScopeRow) => <div className="mcp-scope-controls">
    {row.agent === 'claude' ? <><label>Global<DarkSelect compact disabled={editing || !row.globalEditable} label={`${row.name} global Claude setting`} value={row.globalOverride === null ? 'inherit' : row.globalOverride ? 'on' : 'off'} options={[{ value: 'inherit', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void toggleTool(row, 'global', value === 'inherit' ? null : value === 'on')} /></label>{projectId && <label>Linked project<DarkSelect compact disabled={editing || !row.projectEditable} label={`${row.name} project Claude setting`} value={row.projectOverride === null ? 'inherit' : row.projectOverride ? 'on' : 'off'} options={[{ value: 'inherit', label: 'Inherit' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void toggleTool(row, 'project', value === 'inherit' ? null : value === 'on')} /></label>}</> : <>
    {row.kind !== 'skill' && <label>Global<select aria-label={`${row.name} global setting`} disabled={!row.globalEditable || editing} value={row.globalOverride === null ? row.kind === 'mcp' && row.globalEnabled ? 'true' : 'default' : String(row.globalOverride)} onChange={event => void toggleTool(row, 'global', event.target.value === 'true')}><option value="default" disabled>Default</option><option value="true">On</option><option value="false">Off</option></select></label>}
    {projectId && <label>Linked project<select aria-label={`${row.name} project setting`} disabled={!row.projectEditable || editing} value={row.projectOverride === null ? row.projectDefined ? 'default' : 'inherit' : String(row.projectOverride)} onChange={event => void toggleTool(row, 'project', event.target.value === 'inherit' ? null : event.target.value === 'true')}><option value="inherit" disabled={row.projectDefined}>Inherit</option>{row.projectDefined && <option value="default" disabled>Defined here</option>}<option value="true">On</option><option value="false">Off</option></select></label>}
    {!row.globalEditable && row.kind !== 'skill' && <small>{row.managedBy === 'Host/workspace-managed' ? 'Managed by host' : 'No global definition'}</small>}
    </>}
  </div>
  return <div className="files-panel mcp-panel"><header><h2>{editorOpen ? 'Add MCP server' : 'Tools'}</h2><div>
    {editorOpen && <button className="desk-icon" onClick={() => setEditorOpen(false)} title="Back to Tools" aria-label="Back to Tools"><Icon name="arrow" size={15} style={{ transform: 'rotate(180deg)' }} /></button>}
    <button className="desk-icon" onClick={() => void refresh()} title="Refresh MCP configurations" aria-label="Refresh MCP configurations"><Icon name="refresh" size={15} /></button>
    <button className="desk-icon" onClick={onClose} aria-label="Close MCP"><Icon name="close" size={17} /></button>
  </div></header>
    {!editorOpen && <div className="mcp-summary"><strong>{state.projects.find(project => project.id === projectId)?.name || 'Mr. Mik Hub'}</strong><p>{visible.length + visibleComponents.length} integrations shown · A definition is not proof of a live chat connection.</p></div>}
    {project && project.repositories.length > 1 && <div className="mcp-repository-choice"><span>Linked project</span><DarkSelect label="Linked project for tools" value={repositoryId} options={project.repositories.map(repository => ({ value: repository.id, label: repository.name + (repository.available ? '' : ' · missing'), disabled: !repository.available }))} onChange={setSelectedRepositoryId} /></div>}
    {editorOpen ? <div className="mcp-editor-view"><div className="mcp-editor-tabs" role="group" aria-label="MCP agent"><button aria-pressed={editorAgent === 'codex'} onClick={() => setEditorAgent('codex')}>Codex</button><button aria-pressed={editorAgent === 'claude'} onClick={() => setEditorAgent('claude')}>Claude</button></div>
      <div className="mcp-editor-scope"><span>Configuration scope</span><DarkSelect label="MCP configuration scope" value={definitionScope} options={[{ value: 'global', label: 'Global · all projects' }, { value: 'project', label: 'Selected linked project', disabled: !projectId }]} onChange={value => { setManagedScope(value); setEditName(''); setClaudeName('') }} /></div>
    {editorAgent === 'codex' && <section className="mcp-editor"><p>Definitions created here are kept in a separate section of Codex config. Existing manual and plugin definitions remain at their source. Changes apply to new Codex chats.</p>
      <p>Use the list below to switch servers on or off. This form creates or edits definitions owned by Mr. Mik.</p>{managed?.servers.map(item => <div className="mcp-managed-row" key={item.name}><span>{item.name} · {item.transport}</span><div><button disabled={editing} onClick={() => { setEditName(item.name); setTransport(item.transport); setAddress(''); setCommand(''); setArgumentsText('') }}>Edit</button><button disabled={editing} onClick={() => void changeManaged('remove', item.name)}>Remove</button></div></div>)}
      <form onSubmit={event => { event.preventDefault(); void changeManaged('save', editName) }}><label>Server name<input required pattern="[A-Za-z_][A-Za-z_0-9-]*" maxLength={64} value={editName} onChange={event => setEditName(event.target.value)} /></label><label>Transport<DarkSelect label="Codex MCP transport" value={transport} options={[{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Local process (stdio)' }]} onChange={setTransport} /></label>{transport === 'http' ? <label>MCP URL<input required type="url" placeholder="https://example.com/mcp" value={address} onChange={event => setAddress(event.target.value)} /></label> : <><label>Command<input required value={command} onChange={event => setCommand(event.target.value)} placeholder="node" /></label><label>Arguments · one per line<textarea value={argumentsText} onChange={event => setArgumentsText(event.target.value)} rows={3} /></label></>}<button disabled={editing || definitionScope === 'project' && !projectId}>Save definition</button></form>
      <p>Editing an existing entry requires re-entering its endpoint or command; secrets are never returned to this form. For headers, environment variables and plugin-managed entries, edit their source configuration.</p>
    </section>}
    {editorAgent === 'claude' && <section className="mcp-editor"><p>{definitionScope === 'global' ? 'User-scope definitions apply in every Claude project on this computer. Global Off keeps an inactive private definition; project On can use it locally. Native approvals still apply.' : 'Local definitions apply only to this linked project. The linked folder is not modified.'} Changes apply to new Claude chats.</p>
      <p>{definitionScope === 'global' ? claudeGlobal?.note : claudeManaged?.note}</p>{(definitionScope === 'global' ? claudeGlobal : claudeManaged)?.servers.map(item => <div className="mcp-managed-row" key={item.name}><span>{item.name} · {item.transport}{definitionScope === 'project' ? ` · ${item.enabled ? 'on' : 'off'}` : ''}</span><div><button disabled={editing || item.managed === false} title={item.managed === false ? 'External definition: toggle in Tools; edit its original source' : 'Edit definition'} onClick={() => { setClaudeName(item.name); setClaudeTransport(item.transport); setClaudeAddress(''); setClaudeCommand(''); setClaudeArgs('') }}>Edit</button>{definitionScope === 'project' && <button disabled={editing} onClick={() => void changeClaude('toggle', item.name, !item.enabled)}>{item.enabled ? 'Disable' : 'Enable'}</button>}<button disabled={editing || item.managed === false} onClick={() => void changeClaude('remove', item.name)}>Remove</button></div></div>)}
      <form onSubmit={event => { event.preventDefault(); void changeClaude('save', claudeName) }}><label>Server name<input required pattern="[A-Za-z_][A-Za-z_0-9-]*" maxLength={64} value={claudeName} onChange={event => setClaudeName(event.target.value)} /></label><label>Transport<DarkSelect label="Claude MCP transport" value={claudeTransport} options={[{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Local process (stdio)' }]} onChange={setClaudeTransport} /></label>{claudeTransport === 'http' ? <label>MCP URL<input required type="url" placeholder="https://example.com/mcp" value={claudeAddress} onChange={event => setClaudeAddress(event.target.value)} /></label> : <><label>Command<input required value={claudeCommand} onChange={event => setClaudeCommand(event.target.value)} placeholder="node" /></label><label>Arguments · one per line<textarea value={claudeArgs} onChange={event => setClaudeArgs(event.target.value)} rows={3} /></label></>}<button disabled={editing || definitionScope === 'project' && !projectId}>Save definition</button></form>
      <p>Existing entries require a fresh endpoint or command to edit. Credentials are never shown here; configure authenticated servers in Claude itself.</p>
    </section>}</div> : <>
    <p className="mcp-intro">Installed integrations stay on this computer. Global changes affect new chats everywhere; project settings apply to the selected linked folder{projectId ? ` (Codex trust: ${tools?.trust || 'checking'})` : ''}.</p>
    <button className="mcp-add-button" onClick={() => setEditorOpen(true)}>+ Add MCP server</button>
    <div className="mcp-filters"><label>Agent<select aria-label="Filter MCP by agent" value={client} onChange={event => setClient(event.target.value)}><option value="all">All agents</option>{Object.entries(clients).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>Type<select aria-label="Filter tools by type" value={kind} onChange={event => setKind(event.target.value)}><option value="all">MCP + plugins</option><option value="mcp">MCP</option><option value="plugin">Plugins</option></select></label><label>Manage<select aria-label="Filter MCP by scope" value={scope} onChange={event => setScope(event.target.value)}><option value="all">All scopes</option><option value="project" disabled={!repositoryId}>Linked projects</option><option value="global">Global</option><option value="plugin">Plugin-provided</option></select></label></div>
    <div className="file-filter mcp-search-row"><Icon name="search" size={14} /><input aria-label="Find MCP" placeholder="Find a tool or server…" value={query} onChange={event => setQuery(event.target.value)} /><button className="mcp-eye-toggle" type="button" aria-label={showHidden ? 'Hide hidden tools' : 'Show hidden tools'} title={showHidden ? 'Hide hidden tools' : 'Show hidden tools'} aria-pressed={showHidden} onClick={() => setShowHidden(value => !value)}><Icon name={showHidden ? 'eye' : 'eyeOff'} size={15} /></button></div>
    <div className="mcp-scroll">
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
      {inventory?.problems.map(problem => <p key={problem.path} className="mcp-problem">{problem.message}<small>{problem.path}</small></p>)}
      {visibleComponents.map(row => <article className={`mcp-server${hiddenEntry(`plugin:${row.id}`, systemPlugin(row.id)) ? ' is-hidden' : ''}`} key={`${row.kind}:${row.id}`} data-tool-id={`${row.kind}:${row.id}`}>
        <div className="mcp-server-title"><span className="mcp-provider"><AgentLogo agent={row.agent || 'codex'} size={16} /></span><h3>{row.name}</h3><span className="mcp-state">Plugin</span><button className="mcp-entry-eye" type="button" aria-label={`${hiddenEntry(`plugin:${row.id}`, systemPlugin(row.id)) ? 'Show' : 'Hide'} ${row.name} in Tools`} title={`${hiddenEntry(`plugin:${row.id}`, systemPlugin(row.id)) ? 'Show' : 'Hide'} in Tools`} onClick={() => toggleVisibility(`plugin:${row.id}`, systemPlugin(row.id))}><Icon name={hiddenEntry(`plugin:${row.id}`, systemPlugin(row.id)) ? 'eye' : 'eyeOff'} size={14} /></button></div>
        <p className="mcp-subtitle">{row.agent === 'claude' ? 'Claude' : 'Codex'}<span>·</span>{row.managedBy || row.source}{row.version && <><span>·</span>{row.version}</>}</p>
        {row.installed === false && <p className="mcp-note">Not installed on this computer.</p>}
        {controls(row)}
        {row.note && row.kind === 'plugin' && !row.projectEditable && <p className="mcp-note">{row.note}</p>}
      </article>)}
      {visible.map(server => <article className={`mcp-server${hiddenEntry(server.id, systemServer(server)) || !!server.plugin && hiddenEntry(`plugin:${server.plugin}`, systemPlugin(server.plugin)) ? ' is-hidden' : ''}`} key={server.id} data-mcp-id={server.id}>
        <div className="mcp-server-title"><span className="mcp-provider">{server.client === 'cursor' ? <Icon name="terminal" size={16} /> : <AgentLogo agent={server.client as AgentId} size={16} />}</span><h3>{server.name}</h3><span className={`mcp-state ${server.readiness}`}>{server.client === 'codex' && server.plugin && server.readiness === 'managed' ? 'Plugin-provided' : stateLabel[server.readiness] || server.readiness}</span>{!(server.plugin && systemPlugin(server.plugin)) && <button className="mcp-entry-eye" type="button" aria-label={`${hiddenEntry(server.id, systemServer(server)) ? 'Show' : 'Hide'} ${server.name} in Tools`} title={`${hiddenEntry(server.id, systemServer(server)) ? 'Show' : 'Hide'} in Tools`} onClick={() => toggleVisibility(server.id, systemServer(server))}><Icon name={hiddenEntry(server.id, systemServer(server)) ? 'eye' : 'eyeOff'} size={14} /></button>}</div>
        <p className="mcp-subtitle">{clients[server.client]}<span>·</span>{scopes[server.scope] || server.scope}<span>·</span>{server.transport === 'stdio' ? 'Local process' : server.transport.toUpperCase()}</p>
        <p className="mcp-endpoint" title={server.endpoint || server.executable || ''}>{server.endpoint || server.executable}</p>
        {server.missingEnv.length > 0 && <p className="mcp-note">Add to .env: {server.missingEnv.join(', ')}</p>}
        {server.readiness === 'missing-command' && <p className="mcp-note">Install this server on this computer.</p>}
        {server.readiness === 'approval' && <p className="mcp-note">Approve this project server in Claude.</p>}
        {server.readiness === 'invalid-config' && <p className="mcp-note">Claude HTTP entries need an explicit type such as "http".</p>}
        {server.plugin && <p className="mcp-note">Provided by {server.plugin}.</p>}
        {server.client === 'codex' && !server.plugin && (() => { const row = tools?.rows.find(item => item.kind === 'mcp' && item.id === server.name); return row ? controls(row) : null })()}
        {server.client === 'codex' && server.plugin && <p className="mcp-note">Use the {server.plugin} plugin entry in this list to enable or disable the whole plugin.</p>}
        {server.client === 'claude' && claudeServerControls(server)}
        <div className="mcp-check"><span className={server.connection?.status === 'available' && !server.connection.stale ? 'available' : ''}>{busy.has(server.id) ? 'Checking…' : server.connection ? `${server.connection.stale ? 'Last check: ' : ''}${checkLabel[server.connection.status]}` : 'Connection not checked'}{!busy.has(server.id) && server.connection?.toolCount != null && <small>{server.connection.toolCount}{server.connection.moreTools ? '+' : ''} tools</small>}</span>
          {server.canCheck && <button onClick={() => void check(server)} disabled={busy.has(server.id) || busy.size >= 2} aria-label={`Check ${server.name} for ${clients[server.client]}`}>Check</button>}
        </div>
        {server.connection && <p className="mcp-check-time">Checked {new Date(server.connection.checkedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>}
        {server.connection?.status === 'agent-auth' && <p className="mcp-note">This check cannot reuse the agent’s private login. Use /mcp in that agent to see its authenticated connection.</p>}
        {server.connection?.status === 'unavailable' && <p className="mcp-note">The server did not complete the MCP handshake. A local companion app may need to be running.</p>}
        <details className="mcp-sources"><summary>Configuration{server.sources.length > 1 ? ` · ${server.sources.length} locations` : ''}</summary>{server.sources.map(source => <div key={source.path}><span>{scopes[source.scope] || source.scope}{source.effective ? ' · effective source' : ' · lower priority'}</span><code>{source.path}</code><button onClick={() => api('/reveal', { path: source.path }).catch(error => setError(String(error.message || error)))}>Show in Explorer <Icon name="external" size={12} /></button></div>)}{server.credentialNames.length > 0 && <p>Credentials are hidden.</p>}</details>
      </article>)}
      {inventory && !visible.length && !visibleComponents.length && <p className="mcp-empty">No integrations match these filters.</p>}
    </div>
    <footer className="mcp-footer"><p>Enabled means configured. A check opens its own temporary connection; each chat keeps its own MCP session. Desktop app connectors are managed by their host.</p><button onClick={() => { navigator.clipboard.writeText('/mcp').then(() => setCopied(true)).catch(error => setError(String(error.message || error))) }}>{copied ? 'Copied /mcp' : 'Copy /mcp for chat status'}</button></footer></>}
  </div>
}
