import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, useDesktop } from './client'
import { Icon } from './Icons'
import type { AgentId } from './types'
import DarkSelect from './DarkSelect'
import OpenCodeMcpEditor from './OpenCodeMcpEditor'
import ManagedBrowserTools from './ManagedBrowserTools'
import ToolEntry, { ToolScopeSelect } from './ToolEntry'
import ToolDefinitionActions from './ToolDefinitionActions'
import WorkspaceDialog from './WorkspaceDialog'
import AnchoredMenu from './AnchoredMenu'
import './tools-panel.css'
import McpRecoveryControls, { type McpRecoveryUndo } from './McpRecoveryControls'
import './mcp.css'
import './mcp-editor.css'

type Check = { status: 'available' | 'agent-auth' | 'timeout' | 'unavailable'; toolCount: number | null; moreTools?: boolean; checkedAt: string; stale?: boolean }
type Server = {
  id: string; name: string; client: 'codex' | 'claude' | 'opencode' | 'kimi' | 'cursor'; scope: string; enabled: boolean
  readiness: string; transport: string; endpoint: string; executable: string | null; plugin: string | null
  sources: { scope: string; path: string; effective: boolean }[]; missingEnv: string[]; credentialNames: string[]; canCheck: boolean; connection: Check | null
  configurationIssue?: string
}
type Inventory = { scannedAt: string; servers: Server[]; sources: { client: string; scope: string; path: string }[]; problems: { path: string; message: string }[]; recoveryCandidates?: { id: string }[] }
type Managed = { scope: string; file: string; servers: { name: string; transport: string; enabled: boolean; managed?: boolean; inheritedCopy?: boolean }[]; disabledMcpServers?: string[]; disabledGlobal?: string[]; note: string }
type ScopeRow = { agent?: 'codex' | 'claude' | 'opencode'; kind: 'plugin' | 'skill' | 'mcp'; id: string; name: string; source: string; version?: string | null; installed?: boolean; globalEnabled: boolean; effective?: boolean; globalOverride: boolean | null; projectOverride: boolean | null; editable: boolean; globalEditable: boolean; projectEditable: boolean; projectDefined: boolean; managedBy?: string; cliSupport?: 'unsupported'; note: string }
type ScopeInventory = { trust: string; rows: ScopeRow[]; duplicates: { name: string; sources: string[] }[]; notice: string }
const clients: Record<string, string> = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }
const scopes: Record<string, string> = { project: 'Linked project', local: 'Linked project · this PC', global: 'Global', plugin: 'Plugin', managed: 'Managed' }
const stateLabel: Record<string, string> = { configured: 'Enabled', disabled: 'Disabled', managed: 'Host managed', 'missing-env': 'Needs setup', 'missing-command': 'Not installed', approval: 'Needs approval', 'invalid-config': 'Invalid configuration', 'unsupported-check': 'Check in agent' }
const checkLabel: Record<string, string> = { available: 'Available', 'agent-auth': 'Check login in agent', timeout: 'Timed out', unavailable: 'Not reachable' }

export default function McpPanel({ onClose, workspaceScope }: { onClose: () => void; workspaceScope?: ReactNode }) {
  const state = useDesktop()
  const profileId = 'system'
  const claudeProfileId = 'system'
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
  const [, setManaged] = useState<Managed | null>(null)
  const [claudeManaged, setClaudeManaged] = useState<Managed | null>(null)
  const [claudeGlobal, setClaudeGlobal] = useState<Managed | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingDefinition, setEditingDefinition] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  // Undo survives closing a tool popup, scoped to its original native source.
  const [recoveryUndo, setRecoveryUndo] = useState<Record<string, McpRecoveryUndo | undefined>>({})
  const [openCodeInitial, setOpenCodeInitial] = useState<{ name: string; transport: string } | undefined>()
  const [editorAgent, setEditorAgent] = useState<'codex' | 'claude' | 'opencode'>('codex')
  const [showHidden, setShowHidden] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem('mrmak.tools.hidden') || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [] } catch { return [] } })
  const [visibleSystemIds, setVisibleSystemIds] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem('mrmak.tools.visible-system') || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [] } catch { return [] } })
  const [tools, setTools] = useState<ScopeInventory | null>(null)
  const [claudeTools, setClaudeTools] = useState<ScopeInventory | null>(null)
  const [openCodeTools, setOpenCodeTools] = useState<ScopeInventory | null>(null)
  const [editName, setEditName] = useState(''), [transport, setTransport] = useState('http'), [address, setAddress] = useState(''), [command, setCommand] = useState(''), [argumentsText, setArgumentsText] = useState('')
  const [claudeName, setClaudeName] = useState(''), [claudeTransport, setClaudeTransport] = useState('http'), [claudeAddress, setClaudeAddress] = useState(''), [claudeCommand, setClaudeCommand] = useState(''), [claudeArgs, setClaudeArgs] = useState('')
  const [editing, setEditing] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const confirmationResult = useRef<((value: boolean) => void) | null>(null)
  const confirmChange = (message: string) => new Promise<boolean>(resolve => { confirmationResult.current?.(false); confirmationResult.current = resolve; setConfirmation(message) })
  const decide = (value: boolean) => { confirmationResult.current?.(value); confirmationResult.current = null; setConfirmation('') }
  useEffect(() => () => { confirmationResult.current?.(false) }, [])
  const generation = useRef(0)
  const refreshRef = useRef<(() => Promise<void>) | null>(null)
  const invalidate = useCallback(() => { generation.current++ }, [])
  // Repository validity depends on the live project list; this callback must refresh when it changes.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const refresh = useCallback(async () => {
    const request = ++generation.current
    // Keep inventory diagnostics visible even if a malformed native config
    // prevents loading the editors or scope controls.
    const inventoryRequest = api<Inventory>(`/mcp?claudeProfileId=${encodeURIComponent(claudeProfileId)}&profileId=${encodeURIComponent(profileId)}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)
    void inventoryRequest.then(value => { if (request === generation.current) setInventory(value) }).catch(cause => { if (request === generation.current) setError(String(cause.message || cause)) })
    void api<ScopeInventory>(`/opencode/scopes?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`).then(value => { if (request === generation.current) setOpenCodeTools(value) }).catch(cause => { if (request === generation.current) setError(String(cause.message || cause)) })
    void api<ScopeInventory>(`/claude/scopes?profileId=${encodeURIComponent(claudeProfileId)}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`).then(value => { if (request === generation.current) setClaudeTools(value) }).catch(cause => { if (request === generation.current) setError(String(cause.message || cause)) })
    try { const [result, definitions, claude, claudeUser, scoped] = await Promise.all([inventoryRequest, api<Managed>(`/codex/mcp-managed?profileId=${encodeURIComponent(profileId)}&scope=${definitionScope}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`), projectId ? api<Managed>(`/claude/mcp-managed?profileId=${encodeURIComponent(claudeProfileId)}&scope=local&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`) : Promise.resolve(null), api<Managed>(`/claude/mcp-managed?profileId=${encodeURIComponent(claudeProfileId)}&scope=global`), api<ScopeInventory>(`/codex/scopes?profileId=${encodeURIComponent(profileId)}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)]); if (request === generation.current) { setInventory(result); setManaged(definitions); setClaudeManaged(claude); setClaudeGlobal(claudeUser); setTools(scoped); setError('') } }
    catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : String(error)) }
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  }, [projectId, repositoryId, definitionScope, profileId, claudeProfileId])
  const refreshCurrent = useCallback(async () => { await refreshRef.current?.() }, [])
  useEffect(() => { refreshRef.current = refresh; return () => { if (refreshRef.current === refresh) refreshRef.current = null } }, [refresh])
  useEffect(() => {
    let active = true
    // Never bind the previous folder's entries to the newly selected scope.
    // A normal refresh keeps the list; changing its context clears it first.
    void Promise.resolve().then(() => {
      if (!active) return
      setInventory(null); setTools(null); setClaudeTools(null); setOpenCodeTools(null)
      setManaged(null); setClaudeManaged(null); setClaudeGlobal(null); setError('')
      return refresh()
    })
    const onFocus = () => { void refresh() }; window.addEventListener('focus', onFocus)
    const timer = window.setInterval(onFocus, 30000)
    return () => { active = false; invalidate(); window.removeEventListener('focus', onFocus); clearInterval(timer) }
  }, [refresh, invalidate])
  const check = async (server: Server) => {
    setBusy(value => new Set([...value, server.id])); setError('')
    try { await api('/mcp/check', { profileId, claudeProfileId, id: server.id, projectId, repositoryId }); await refreshCurrent() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(value => { const next = new Set(value); next.delete(server.id); return next }) }
  }
  const changeManaged = async (action: 'save' | 'toggle' | 'remove', name: string, enabled?: boolean) => {
    if (definitionScope === 'global' && !await confirmChange(`Change the personal Codex MCP configuration for all projects? ${name}`)) return
    if (action === 'remove' && !await confirmChange(`Remove Mr. Mik's ${name} MCP definition from ${definitionScope} config?`)) return
    setEditing(true); setError('')
    try {
      await api('/codex/mcp-managed', { profileId, scope: definitionScope, projectId, repositoryId, action, name, transport, url: address, command, args: argumentsText.split('\n').map(value => value.trim()).filter(Boolean), enabled: enabled ?? true })
      setEditName(''); setAddress(''); setCommand(''); setArgumentsText(''); await refreshCurrent(); setEditorOpen(false)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setEditing(false) }
  }
  const changeClaude = async (action: 'save' | 'toggle' | 'remove' | 'override', name: string, enabled?: boolean | null) => {
    if (definitionScope === 'project' && !projectId) return
    if (action === 'remove' && !await confirmChange(`Remove Mr. Mik's Claude MCP definition ${name} from ${definitionScope === 'global' ? 'your user configuration' : 'this linked project'}?`)) return
    setEditing(true); setError('')
    try {
      await api('/claude/mcp-managed', { profileId: claudeProfileId, projectId, repositoryId, scope: definitionScope === 'global' ? 'global' : 'local', action, name, transport: claudeTransport, url: claudeAddress, command: claudeCommand, args: claudeArgs.split('\n').map(value => value.trim()).filter(Boolean), enabled: action === 'override' ? enabled : enabled ?? true })
      setClaudeName(''); setClaudeAddress(''); setClaudeCommand(''); setClaudeArgs(''); await refreshCurrent(); setEditorOpen(false)
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
      try { await api('/claude/mcp-managed', { profileId: claudeProfileId, projectId, repositoryId, scope, action: scope === 'global' ? 'toggle' : 'override', name: server.name, enabled }); await refreshCurrent() }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      finally { setEditing(false) }
    }
    return <div className="mcp-scope-controls"><label>Global<ToolScopeSelect compact disabled={editing || !global && !local} label={`${server.name} global Claude MCP`} value={global?.enabled ? 'on' : 'off'} options={[{ value: 'on', label: 'On' }, { value: 'off', label: global ? 'Off' : 'Off · not global' }]} onChange={value => void change('global', value === 'on')} /></label>{projectId && <label>Linked project<ToolScopeSelect compact disabled={editing} label={`${server.name} linked Claude MCP`} value={claudeManaged?.disabledMcpServers?.includes(server.name) ? 'off' : local?.enabled ? 'on' : 'inherit'} options={[{ value: 'inherit', label: 'Inherit', disabled: !!local && !local.inheritedCopy }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void change('local', value === 'inherit' ? null : value === 'on')} /></label>}</div>
  }
  const systemServer = (server: Server) => server.client === 'codex' && ['node_repl', 'cua_repl', 'codex_app'].includes(server.name)
  const systemPlugin = (id: string) => id.startsWith('codex-app-tools@')
  const hiddenEntry = (id: string, system = false) => system ? !visibleSystemIds.includes(id) : hiddenIds.includes(id)
  const isHidden = (id: string, system = false) => !showHidden && hiddenEntry(id, system)
  const visible = (inventory?.servers || []).filter(server => Object.prototype.hasOwnProperty.call(clients, server.client) && (client === 'all' || server.client === client)
    && (kind === 'all' || kind === 'mcp')
    && (scope === 'all' || (scope === 'project' ? !!projectId && (server.sources.some(source => ['project', 'local'].includes(source.scope)) || (['claude', 'opencode'].includes(server.client) && server.scope !== 'managed') || server.client === 'codex' && (server.plugin ? tools?.rows.some(row => row.kind === 'plugin' && row.id === server.plugin && row.projectEditable) : tools?.rows.some(row => row.kind === 'mcp' && row.id === server.name && row.projectEditable))) : scope === 'global' ? server.sources.some(source => source.scope === 'global') : server.scope === scope))
    && `${server.name} ${server.endpoint} ${server.plugin || ''}`.toLowerCase().includes(query.toLowerCase()) && !isHidden(server.id, systemServer(server)) && (!server.plugin || !isHidden(`plugin:${server.plugin}`, systemPlugin(server.plugin))))
  const visibleComponents = [...(tools?.rows || []), ...(claudeTools?.rows || []).map(row => ({ ...row, agent: 'claude' as const })), ...(openCodeTools?.rows || []).map(row => ({ ...row, agent: 'opencode' as const }))].filter(row => row.kind === 'plugin' && (client === 'all' || client === (row.agent || 'codex'))
    && (kind === 'all' || row.kind === kind)
    && (scope === 'all' || scope === 'plugin' && row.kind === 'plugin' || scope === 'project' && row.projectEditable || scope === 'global' && row.globalEditable)
    && `${row.name} ${row.source}`.toLowerCase().includes(query.toLowerCase()) && !isHidden(`plugin:${row.id}`, systemPlugin(row.id)))
  const toggleTool = async (row: ScopeRow, scopeChoice: 'global' | 'project', enabled: boolean | null) => {
    if (row.agent === 'opencode') {
      setEditing(true); setError('')
      try { await api('/opencode/scopes', { projectId: scopeChoice === 'global' && row.kind !== 'plugin' ? null : projectId, repositoryId, kind: row.kind, id: row.id, scope: scopeChoice, enabled }); await refreshCurrent() }
      catch (cause) { setError(String((cause as Error).message || cause)) }
      finally { setEditing(false) }
      return
    }
    if (row.agent === 'claude') {
      setEditing(true); setError('')
      try { await api('/claude/scopes', { profileId: claudeProfileId, projectId, repositoryId, kind: row.kind, id: row.id, scope: scopeChoice, enabled }); await refreshCurrent() }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      finally { setEditing(false) }
      return
    }
    if (scopeChoice === 'global' && !await confirmChange(`Change ${row.name} in your personal Codex configuration for all projects?`)) return
    setEditing(true); setError('')
    try { await api('/codex/scopes', { profileId, projectId, repositoryId, kind: row.kind, id: row.id, scope: scopeChoice, enabled }); await refreshCurrent() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setEditing(false) }
  }
  const controls = (row: ScopeRow) => <div className="mcp-scope-controls">
    {row.agent === 'opencode' && <><label>Global<ToolScopeSelect compact disabled={editing || !row.globalEditable} label={`${row.name} global OpenCode setting`} value={row.globalOverride === null ? 'default' : row.globalOverride ? 'on' : 'off'} options={[{ value: 'default', label: 'Default', disabled: true }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void toggleTool(row, 'global', value === 'on')} /></label>{projectId && <label>Linked project<ToolScopeSelect compact disabled={editing || !row.projectEditable} label={`${row.name} project OpenCode setting`} value={row.projectOverride === null ? 'inherit' : row.projectOverride ? 'on' : 'off'} options={[{ value: 'inherit', label: 'Inherit' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void toggleTool(row, 'project', value === 'inherit' ? null : value === 'on')} /></label>}</>}
    {row.agent === 'claude' ? <><label>Global<ToolScopeSelect compact disabled={editing || !row.globalEditable} label={`${row.name} global Claude setting`} value={row.globalOverride === null ? 'inherit' : row.globalOverride ? 'on' : 'off'} options={[{ value: 'inherit', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void toggleTool(row, 'global', value === 'inherit' ? null : value === 'on')} /></label>{projectId && <label>Linked project<ToolScopeSelect compact disabled={editing || !row.projectEditable} label={`${row.name} project Claude setting`} value={row.projectOverride === null ? 'inherit' : row.projectOverride ? 'on' : 'off'} options={[{ value: 'inherit', label: 'Inherit' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void toggleTool(row, 'project', value === 'inherit' ? null : value === 'on')} /></label>}</> : <>
    {row.agent !== 'opencode' && row.kind !== 'skill' && <label>Global<ToolScopeSelect icon="" label={`${row.name} global setting`} disabled={!row.globalEditable || editing} value={row.globalOverride === null ? row.kind === 'mcp' && row.globalEnabled ? 'true' : 'default' : String(row.globalOverride)} onChange={value => void toggleTool(row, 'global', value === 'true')} options={[{ value: 'default', label: 'Default', disabled: true }, { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]} /></label>}
    {row.agent !== 'opencode' && projectId && <label>Linked project<ToolScopeSelect icon="" label={`${row.name} project setting`} disabled={!row.projectEditable || editing} value={row.projectOverride === null ? row.projectDefined ? 'default' : 'inherit' : String(row.projectOverride)} onChange={value => void toggleTool(row, 'project', value === 'inherit' ? null : value === 'true')} options={[{ value: 'inherit', label: 'Inherit', disabled: row.projectDefined }, ...(row.projectDefined ? [{ value: 'default', label: 'Defined here', disabled: true }] : []), { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]} /></label>}
    {row.agent !== 'opencode' && !row.globalEditable && row.kind !== 'skill' && <small>{row.managedBy === 'Host/workspace-managed' ? 'Managed by host' : 'No global definition'}</small>}
    </>}
  </div>
  return <div className="files-panel mcp-panel tools-panel"><header><h2>Tools</h2><div>
    <button className="desk-icon" aria-label="Add MCP server" title="Add MCP server" onClick={() => { setEditingDefinition(false); setEditName(''); setClaudeName(''); setOpenCodeInitial(undefined); setEditorOpen(true) }}><Icon name="plus" size={16} /></button>
    <button className="desk-icon" onClick={() => void refresh()} title="Refresh MCP configurations" aria-label="Refresh MCP configurations"><Icon name="refresh" size={15} /></button>
    <button className="desk-icon" onClick={onClose} aria-label="Close MCP"><Icon name="close" size={17} /></button>
  </div></header>
    {workspaceScope}
    {project && project.repositories.length > 1 && <div className="mcp-repository-choice"><span>Linked project</span><DarkSelect appearance="workspace" icon="" label="Linked project for tools" value={repositoryId} options={project.repositories.map(repository => ({ value: repository.id, label: repository.name + (repository.available ? '' : ' · missing'), disabled: !repository.available }))} onChange={setSelectedRepositoryId} /></div>}
    {editorOpen && <WorkspaceDialog label="Add MCP server" busy={editing} close={() => setEditorOpen(false)}><header><h3>{editingDefinition ? 'Edit MCP server' : 'Add MCP server'}</h3><button className="desk-icon" aria-label="Close MCP editor" disabled={editing} onClick={() => setEditorOpen(false)}><Icon name="close" size={16} /></button></header><div className="mcp-editor-view tools-editor-dialog"><div className="mcp-editor-tabs" role="group" aria-label="MCP agent"><button disabled={editing || editingDefinition} aria-pressed={editorAgent === 'codex'} onClick={() => setEditorAgent('codex')}>Codex</button><button disabled={editing || editingDefinition} aria-pressed={editorAgent === 'claude'} onClick={() => setEditorAgent('claude')}>Claude</button><button disabled={editing || editingDefinition} aria-pressed={editorAgent === 'opencode'} onClick={() => setEditorAgent('opencode')}>OpenCode</button></div>
      <div className="mcp-editor-scope"><span>Configuration scope</span><DarkSelect appearance="workspace" icon="" label="MCP configuration scope" disabled={editing} value={definitionScope} options={[{ value: 'global', label: 'Global · all projects' }, { value: 'project', label: 'Selected linked project', disabled: !projectId }]} onChange={value => { setManagedScope(value); setEditingDefinition(false); setOpenCodeInitial(undefined); setEditName(''); setClaudeName('') }} /></div>
      {editorAgent === 'opencode' && <OpenCodeMcpEditor key={`${definitionScope}:${projectId}:${repositoryId}`} projectId={projectId} repositoryId={repositoryId} scope={definitionScope} initialDefinition={openCodeInitial} showDefinitions={false} onBusyChange={setEditing} onCancel={() => setEditorOpen(false)} onSaved={async () => { await refreshCurrent(); setEditorOpen(false) }} />}
    {editorAgent === 'codex' && <section className="mcp-editor"><details className="tools-editor-notes"><summary>Configuration notes</summary><p>Definitions created here are kept in a separate section of Codex config. Existing manual and plugin definitions remain at their source. Affected open chats resume when safe; otherwise apply the pending MCP update in Chats.</p>
      <p>Use the list below to switch servers on or off. This form creates or edits definitions owned by Mr. Mik.</p>
      </details><form onSubmit={event => { event.preventDefault(); void changeManaged('save', editName) }}><label>Server name<input disabled={editing} readOnly={editingDefinition} required pattern="[A-Za-z_][A-Za-z_0-9\-]*" maxLength={64} value={editName} onChange={event => setEditName(event.target.value)} /></label><label>Transport<DarkSelect appearance="workspace" icon="" label="Codex MCP transport" disabled={editing} value={transport} options={[{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Local process (stdio)' }]} onChange={setTransport} /></label>{transport === 'http' ? <label>MCP URL<input disabled={editing} required type="url" placeholder="https://example.com/mcp" value={address} onChange={event => setAddress(event.target.value)} /></label> : <><label>Command<input disabled={editing} required value={command} onChange={event => setCommand(event.target.value)} placeholder="node" /></label><label>Arguments · one per line<textarea disabled={editing} value={argumentsText} onChange={event => setArgumentsText(event.target.value)} rows={3} /></label></>}<footer><button type="button" disabled={editing} onClick={() => setEditorOpen(false)}>Cancel</button><button disabled={editing || definitionScope === 'project' && !projectId}>Save definition</button></footer></form>
      <p>Editing an existing entry requires re-entering its endpoint or command; secrets are never returned to this form. For headers, environment variables and plugin-managed entries, edit their source configuration.</p>
    </section>}
    {editorAgent === 'claude' && <section className="mcp-editor"><details className="tools-editor-notes"><summary>Configuration notes</summary><p>{definitionScope === 'global' ? 'User-scope definitions apply in every Claude project on this computer. Global Off keeps an inactive private definition; project On can use it locally. Native approvals still apply.' : 'Local definitions belong to the selected linked project. Main-project chats can also use its enabled MCPs. The linked folder is not modified.'} Affected chats update silently when idle and their input is empty.</p>
      <p>{definitionScope === 'global' ? claudeGlobal?.note : claudeManaged?.note}</p>
      </details><form onSubmit={event => { event.preventDefault(); void changeClaude('save', claudeName) }}><label>Server name<input disabled={editing} readOnly={editingDefinition} required pattern="[A-Za-z_][A-Za-z_0-9\-]*" maxLength={64} value={claudeName} onChange={event => setClaudeName(event.target.value)} /></label><label>Transport<DarkSelect appearance="workspace" icon="" label="Claude MCP transport" disabled={editing} value={claudeTransport} options={[{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Local process (stdio)' }]} onChange={setClaudeTransport} /></label>{claudeTransport === 'http' ? <label>MCP URL<input disabled={editing} required type="url" placeholder="https://example.com/mcp" value={claudeAddress} onChange={event => setClaudeAddress(event.target.value)} /></label> : <><label>Command<input disabled={editing} required value={claudeCommand} onChange={event => setClaudeCommand(event.target.value)} placeholder="node" /></label><label>Arguments · one per line<textarea disabled={editing} value={claudeArgs} onChange={event => setClaudeArgs(event.target.value)} rows={3} /></label></>}<footer><button type="button" disabled={editing} onClick={() => setEditorOpen(false)}>Cancel</button><button disabled={editing || definitionScope === 'project' && !projectId}>Save definition</button></footer></form>
      <p>Existing entries require a fresh endpoint or command to edit. Credentials are never shown here; configure authenticated servers in Claude itself.</p>
    </section>}{error && <p role="alert" className="desk-error-inline">{error}</p>}</div></WorkspaceDialog>}
    <>
    <div className="tools-controls"><div className="tools-kind-tabs" role="group" aria-label="Tool type">{[{ value: 'all', label: 'All' }, { value: 'mcp', label: 'MCP' }, { value: 'plugin', label: 'Plugins' }].map(item => <button key={item.value} aria-pressed={kind === item.value} onClick={() => setKind(item.value)}>{item.label}</button>)}</div></div>
    <div className="file-filter mcp-search-row"><Icon name="search" size={14} /><input aria-label="Find MCP" placeholder="Find a tool or server…" value={query} onChange={event => setQuery(event.target.value)} /><AnchoredMenu label="Tool filters" icon="settings" menuOwner="tools-filters" appearance="workspace" placement="below">{() => <div className="tools-filter-fields"><label>Provider<DarkSelect appearance="workspace" icon="" label="Filter MCP by agent" value={client} onChange={setClient} options={[{ value: 'all', label: 'All agents' }, ...Object.entries(clients).map(([value,label]) => ({value,label}))]} /></label><label>Scope<DarkSelect appearance="workspace" icon="" label="Filter MCP by scope" value={scope} onChange={setScope} options={[{value:'all',label:'All scopes'},{value:'project',label:'Linked projects',disabled:!repositoryId},{value:'global',label:'Global'},{value:'plugin',label:'Plugin-provided'}]} /></label><label className="tools-hidden-choice"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />Show hidden tools</label></div>}</AnchoredMenu></div>
    <div className="mcp-scroll">
      <ManagedBrowserTools />
      {error && <p className="desk-error-inline" role="alert">{error}</p>}

      {visibleComponents.map(row => <div key={`${projectId}:${repositoryId}:${row.agent || 'codex'}:${row.kind}:${row.id}`} data-tool-id={`${row.kind}:${row.id}`}><ToolEntry name={row.name} subtitle={`${clients[row.agent || 'codex']} · ${row.cliSupport === 'unsupported' ? 'Unavailable in CLI' : 'Plugin'}`} agent={row.agent || 'codex'} hidden={hiddenEntry(`plugin:${row.id}`, systemPlugin(row.id))} inherited={!!projectId && row.projectOverride === null && !row.projectDefined} value={(projectId ? row.effective ?? row.projectOverride ?? row.globalEnabled : row.globalEnabled) ? 'On' : 'Off'} locked={!row.globalEditable && (!projectId || !row.projectEditable)} availability={controls(row)} onVisibility={() => toggleVisibility(`plugin:${row.id}`, systemPlugin(row.id))}>
        {() => <><p className="mcp-note">{row.managedBy || row.source}{row.version && ` · ${row.version}`}</p>{row.installed === false && <p className="mcp-note">Not installed on this computer.</p>}{row.note && <p className="mcp-note">{row.note}</p>}</>}
      </ToolEntry></div>)}
      {visible.map(server => {
        const row = (server.client === 'codex' ? tools : server.client === 'opencode' ? openCodeTools : claudeTools)?.rows.find(item => item.kind === 'mcp' && item.id === server.name)
        const locked = !!server.plugin || server.scope === 'managed' || server.client !== 'claude' && (!row || !row.globalEditable && (!projectId || !row.projectEditable))
        const recoveryKey = JSON.stringify([profileId, projectId, repositoryId, server.id])
        const inherited = !!projectId && (server.client === 'claude' ? !server.sources.some(source => ['local', 'project'].includes(source.scope)) && !claudeManaged?.disabledMcpServers?.includes(server.name) : row?.projectOverride === null && !row.projectDefined)
        return <div key={`${projectId}:${repositoryId}:${server.id}`} data-mcp-id={server.id}><ToolEntry name={server.name} agent={server.client as AgentId} subtitle={`${clients[server.client]} · ${server.connection?.toolCount != null ? `${server.connection.toolCount}${server.connection.moreTools ? '+' : ''} tools` : stateLabel[server.readiness] || server.readiness}`} hidden={hiddenEntry(server.id, systemServer(server)) || !!server.plugin && hiddenEntry(`plugin:${server.plugin}`, systemPlugin(server.plugin))} value={server.enabled ? 'On' : 'Off'} inherited={inherited} locked={locked} availability={server.client === 'claude' ? claudeServerControls(server) : row ? controls({ ...row, agent: server.client as 'codex' | 'opencode' }) : null} onCheck={server.canCheck ? () => void check(server) : undefined} checking={busy.has(server.id)} checkDisabled={busy.size >= 2} connected={server.connection?.status === 'available' && !server.connection.stale} onVisibility={server.plugin && systemPlugin(server.plugin) ? undefined : () => toggleVisibility(server.id, systemServer(server))}>
        {close => <>
        <p className="mcp-subtitle">{clients[server.client]}<span>·</span>{scopes[server.scope] || server.scope}<span>·</span>{server.transport === 'stdio' ? 'Local process' : server.transport.toUpperCase()}</p>
        <p className="mcp-endpoint" title={server.endpoint || server.executable || ''}>{server.endpoint || server.executable}</p>
        {server.missingEnv.length > 0 && <p className="mcp-note">Add to .env: {server.missingEnv.join(', ')}</p>}
        {server.readiness === 'missing-command' && <p className="mcp-note">Install this server on this computer.</p>}
        {server.readiness === 'approval' && <p className="mcp-note">Approve this project server in Claude.</p>}
        {server.readiness === 'invalid-config' && <p className="mcp-note">{server.configurationIssue || 'Claude HTTP entries need an explicit type such as "http".'}</p>}
        {['codex', 'claude', 'opencode'].includes(server.client) && !server.plugin && <McpRecoveryControls profileId={profileId} key={`${profileId}:${projectId}:${repositoryId}:${server.id}`} name={server.name} agent={server.client} projectId={projectId} repositoryId={repositoryId} undo={recoveryUndo[recoveryKey]} onUndoChange={value => setRecoveryUndo(current => ({ ...current, [recoveryKey]: value }))} eligible={!!inventory?.recoveryCandidates?.some(candidate => candidate.id === server.id)} onChanged={refreshCurrent} />}
        {server.plugin && <p className="mcp-note">Provided by {server.plugin}.</p>}
        <div className="mcp-check"><span className={server.connection?.status === 'available' && !server.connection.stale ? 'available' : ''}>{busy.has(server.id) ? 'Checking…' : server.connection ? `${server.connection.stale ? 'Last check: ' : ''}${checkLabel[server.connection.status]}` : 'Connection not checked'}{!busy.has(server.id) && server.connection?.toolCount != null && <small>{server.connection.toolCount}{server.connection.moreTools ? '+' : ''} tools</small>}</span>

        </div>
        {server.connection && <p className="mcp-check-time">Checked {new Date(server.connection.checkedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>}
        {server.connection?.status === 'agent-auth' && <p className="mcp-note">This check cannot reuse the agent’s private login. Use /mcp in that agent to see its authenticated connection.</p>}
        {server.connection?.status === 'unavailable' && <p className="mcp-note">The server did not complete the MCP handshake. A local companion app may need to be running.</p>}
        <details className="mcp-sources"><summary>Configuration{server.sources.length > 1 ? ` · ${server.sources.length} locations` : ''}</summary>{server.sources.map(source => <div className="tools-configuration-source" key={source.path}><span>{scopes[source.scope] || source.scope}{source.effective ? ' · effective source' : ' · lower priority'}</span><code>{source.path}</code><button className="tools-reveal" aria-label={`Show ${scopes[source.scope] || source.scope} configuration in Explorer`} title="Show in Explorer" onClick={() => api('/reveal', { path: source.path }).catch(error => setError(String(error.message || error)))}><Icon name="folder" size={16} /></button></div>)}{server.credentialNames.length > 0 && <p>Credentials are hidden.</p>}{!server.plugin && <ToolDefinitionActions agent={server.client as 'codex' | 'claude' | 'opencode'} name={server.name} projectId={projectId} repositoryId={repositoryId} onChanged={refreshCurrent} onEdit={definition => { close(); setEditingDefinition(true); setManagedScope(definition.scope); setEditorAgent(server.client as 'codex' | 'claude' | 'opencode'); if (server.client === 'codex') { setEditName(definition.name); setTransport(definition.transport); setAddress(''); setCommand(''); setArgumentsText('') } else if (server.client === 'claude') { setClaudeName(definition.name); setClaudeTransport(definition.transport); setClaudeAddress(''); setClaudeCommand(''); setClaudeArgs('') } else setOpenCodeInitial(definition); setEditorOpen(true) }} />}</details>
        <details className="tools-status-help"><summary>Availability</summary><p className="mcp-note">Enabled means configured. Checks use a temporary connection; each chat has its own MCP session. Settings are shared across accounts of the same provider. Native policy and project trust remain authoritative.</p></details>
        </>}
        </ToolEntry></div>
      })}
      {inventory && !visible.length && !visibleComponents.length && <p className="mcp-empty">No integrations match these filters.</p>}
    </div>
    <footer className="tools-footer"><span>{visible.length + visibleComponents.length} integrations</span><button type="button" onClick={() => setDiagnosticsOpen(true)}><Icon name="info" size={14} />Diagnostics{inventory?.problems.length ? ` · ${inventory.problems.length}` : ''}</button></footer></>
    {confirmation && <WorkspaceDialog label="Confirm tool configuration" close={() => decide(false)}><h3>Confirm configuration change</h3><p>{confirmation}</p><footer><button onClick={() => decide(false)}>Cancel</button><button onClick={() => decide(true)}>Confirm</button></footer></WorkspaceDialog>}
    {diagnosticsOpen && <WorkspaceDialog label="Tools diagnostics" close={() => setDiagnosticsOpen(false)}><header><h3>Tools diagnostics</h3><button className="desk-icon" aria-label="Close diagnostics" onClick={() => setDiagnosticsOpen(false)}><Icon name="close" size={16} /></button></header><p>Enabled means configured. Checks use a temporary connection, not the current chat connection.</p><p>Codex project trust: {tools?.trust || 'Unknown'}. Settings are shared across accounts.</p>{openCodeTools?.notice && <p>OpenCode: {openCodeTools.notice}</p>}{inventory?.problems.map(problem => <p key={problem.path} className="mcp-problem">{problem.message}<small>{problem.path}</small></p>)}<label className="tools-command">Native chat status<input readOnly value="/mcp" /></label><footer><button onClick={() => { navigator.clipboard.writeText('/mcp').then(() => setCopied(true)).catch(cause => setError(String(cause.message || cause))) }}>{copied ? 'Copied /mcp' : 'Copy /mcp for chat status'}</button><button onClick={() => setDiagnosticsOpen(false)}>Close</button></footer></WorkspaceDialog>}

  </div>
}
