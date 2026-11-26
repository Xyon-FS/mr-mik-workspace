import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onServiceEvent, reportError, selectChat, sendEvent, useDesktop, windowAction } from './client'
import type { AgentId, ChatSession } from './types'
import { AgentLogo, Icon, Nose } from './Icons'
import TerminalPane from './TerminalPane'
import { shortcutChord, useChatShortcuts } from './chatShortcuts'
import GraphicalChat from './GraphicalChat'
import StartingChat from './StartingChat'
import ProviderGraphicalChat from './ProviderGraphicalChat'
import NativeMessageActions from './NativeMessageActions'
import TerminalControl from './TerminalControl'
import SessionLogo from './SessionLogo'
import { chatActivityLabel } from './chatActivity'
import ProjectChatNavigation from './ProjectChatNavigation'
import CliSessionPicker from './CliSessionPicker'
import ClaudeCliPermissionsSelect from './ClaudeCliPermissionsSelect'
import ConversationActions from './ConversationActions'
import { ConversationChrome } from './ConversationChrome'
import CliChatDetails from './CliChatDetails'
import './chat-navigation-ui.css'
import './chat-concept-ui.css'
import './chat-refinements.css'
import DarkSelect from './DarkSelect'
import CodexPermissionsSelect from './CodexPermissionsSelect'
import { codexPermissionsOptions } from './codexPermissions'
import type { CodexPermissions } from './types'
import { orderedChats } from './chatOrder'
import AccountProfileSelect from './AccountProfileSelect'
import { useChatDialogFocus } from './useChatDialogFocus'

function NewChat({ close, initial }: { close: () => void; initial?: { projectId?: string | null; cardId?: string | null; repositoryId?: string } | null }) {
  const dialog = useChatDialogFocus<HTMLFormElement>(true, close)
  const state = useDesktop()
  const [agent, setAgent] = useState<AgentId>(initial ? 'codex' : state.settings.defaultAgent)
  const [name, setName] = useState('')
  const cwd = state.repo
  const [projectId, setProjectId] = useState(initial?.projectId !== undefined ? initial.projectId || '' : state.settings.selectedProjectId || '')
  const [cardId, setCardId] = useState(initial?.cardId || '')
  const [repositoryId, setRepositoryId] = useState(initial?.repositoryId || '')
  const [cards, setCards] = useState<{ id: string; title: string; projectId?: string | null; repositoryId?: string | null }[]>([])
  const [bypass, setBypass] = useState(state.settings.defaultBypass)
  const [codexPermissions, setCodexPermissions] = useState<CodexPermissions>(state.settings.defaultCodexPermissions || (state.settings.defaultBypass ? 'bypass' : 'ask'))
  const [claudePermissions, setClaudePermissions] = useState<'ask' | 'bypass'>(state.settings.defaultClaudePermissions || (state.settings.defaultBypass ? 'bypass' : 'ask'))
  const [accountProfileId, setAccountProfileId] = useState('')
  const [claudeProfileId, setClaudeProfileId] = useState('system')
  const [resumeId, setResumeId] = useState('')
  const [chatInterface, setChatInterface] = useState('cli')
  const [busy, setBusy] = useState(false)
  const launching = useRef(false)
  const [error, setError] = useState('')
  useEffect(() => { void api<{ entities: typeof cards }>('/workspace').then(value => setCards(value.entities)).catch(reportError) }, [])
  const project = state.projects.find(item => item.id === projectId)
  const cardRepositoryId = cards.find(item => item.id === cardId && item.projectId === projectId)?.repositoryId
  const effectiveRepositoryId = repositoryId || (cardId && cards.length ? project?.repositories.find(item => item.id === cardRepositoryId && item.available)?.id || 'hub' : project?.repositories.find(item => item.available)?.id || 'hub')
  useEffect(() => {
    const timer = setTimeout(() => {
      void api('/codexpreparation', agent === 'codex' && chatInterface === 'chat' && accountProfileId
        ? { agent, chatInterface, accountProfileId, projectId: projectId || null, repositoryId: projectId ? effectiveRepositoryId : null, cardId: cardId || null, cwd, codexPermissions }
        : { cancel: true }).catch(() => {})
    }, 150)
    return () => { clearTimeout(timer); if (!launching.current) void api('/codexpreparation', { cancel: true }).catch(() => {}) }
  }, [agent, chatInterface, accountProfileId, projectId, effectiveRepositoryId, cardId, cwd, codexPermissions])
  async function launch(event: React.FormEvent) {
    event.preventDefault(); launching.current = true; setBusy(true); setError('')
    try {
      const session = await api<ChatSession>('/sessions', { agent, background: chatInterface === 'chat' && !resumeId.trim(), name: name.trim() || undefined, projectId: projectId || null, repositoryId: projectId ? effectiveRepositoryId : null, cardId: cardId || null, cwd, bypass: agent === 'claude' ? claudePermissions === 'bypass' : bypass, ...(['codex', 'claude'].includes(agent) ? { chatInterface } : {}), ...(agent === 'codex' ? { codexPermissions, accountProfileId } : agent === 'claude' ? { accountProfileId: claudeProfileId } : {}), resumeId: resumeId.trim() || undefined })
      selectChat(session.id); close()
      void api('/settings', { defaultAgent: agent, ...(agent === 'codex' ? { defaultCodexPermissions: codexPermissions } : agent === 'claude' ? { defaultClaudePermissions: claudePermissions } : { defaultBypass: bypass }) }).catch(reportError)
    } catch (err) { launching.current = false; setError(err instanceof Error ? err.message : String(err)); setBusy(false) }
  }
  return <div className="desk-scrim" onClick={close}><form ref={dialog} role="dialog" aria-modal="true" aria-label="New chat" tabIndex={-1} className="desk-dialog chat-create-dialog" onClick={event => event.stopPropagation()} onSubmit={launch}>
    <div className="desk-dialog-heading"><div><h2>New chat</h2></div><button type="button" className="desk-icon" onClick={close} aria-label="Close"><Icon name="close" /></button></div>
    <div className="agent-picker" role="group" aria-label="Platform">{state.agents.map(item => <button type="button" key={item.id} className={`agent-choice${agent === item.id ? ' selected' : ''}`} aria-label={item.label} aria-pressed={agent === item.id} disabled={!item.available} onClick={() => setAgent(item.id)}><span className="creation-provider-icon" style={{ color: item.color }}><AgentLogo agent={item.id} size={24} /></span><span>{item.label}<small>{item.subscription ? 'Your subscription' : 'Local terminal'}</small></span>{agent === item.id && <Icon name="check" size={14} />}</button>)}</div>
    <div className="desk-field">Interface<DarkSelect icon="" label="Chat interface" value={['codex', 'claude'].includes(agent) ? chatInterface : 'cli'} options={[{ value: 'cli', label: 'CLI' }, ...(['codex', 'claude'].includes(agent) ? [{ value: 'chat', label: 'Chat' }] : [])]} disabled={!['codex', 'claude'].includes(agent)} onChange={setChatInterface} /></div>
    {agent === 'codex' && <AccountProfileSelect value={accountProfileId} onChange={setAccountProfileId} />}{agent === 'claude' && <AccountProfileSelect agent="claude" value={claudeProfileId} onChange={setClaudeProfileId} />}
    <label className="desk-field">Chat name<input autoFocus placeholder="e.g. Dream Game · animations" value={name} onChange={event => setName(event.target.value)} maxLength={100} /></label>
    <div className="desk-field">Workspace<DarkSelect label="Workspace" value={projectId} options={[{ value: '', label: 'Global Hub' }, ...state.projects.map(project => ({ value: project.id, label: project.name }))]} onChange={value => { setProjectId(value); setCardId(''); setRepositoryId('') }} /></div>
    {<div className="chat-creation-pair"><div className="desk-field">Card<DarkSelect label="Card" value={cardId} options={[{ value: '', label: 'No card' }, ...cards.filter(card => projectId ? card.projectId === projectId : !card.projectId).map(card => ({ value: card.id, label: card.title }))]} onChange={value => { setCardId(value); setRepositoryId('') }} /></div><div className="desk-field">Working project<DarkSelect label="Working project" disabled={!projectId} value={effectiveRepositoryId} options={[{ value: 'hub', label: projectId ? 'Workspace' : 'Global Hub' }, ...(project?.repositories.map(repository => ({ value: repository.id, label: `${repository.name}${repository.available ? '' : ' · missing'}`, disabled: !repository.available })) || [])]} onChange={setRepositoryId} /></div></div>}

    {agent !== 'shell' && <>{agent === 'codex' ? <div className="desk-field">Codex permissions<CodexPermissionsSelect value={codexPermissions} onChange={setCodexPermissions} /></div> : agent === 'claude' ? <div className="desk-field">Claude permissions<DarkSelect label="Claude permissions" value={claudePermissions} options={[{ value: 'ask', label: 'Ask' }, { value: 'bypass', label: 'Bypass permissions' }]} onChange={value => setClaudePermissions(value as 'ask' | 'bypass')} /></div> : <label className="desk-check"><input type="checkbox" checked={bypass} onChange={event => setBypass(event.target.checked)} /><span>Bypass agent permission prompts<small>Same Windows account and file access as your usual terminal.</small></span></label>}{!(agent === 'claude' && chatInterface === 'chat') && <details className="desk-details"><summary>Resume from native ID</summary><label className="desk-field">Native session ID<input value={resumeId} onChange={event => setResumeId(event.target.value)} placeholder="Optional session ID" /></label></details>}</>}
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
    <button className="desk-primary" disabled={busy || !state.connected || agent === 'codex' && !accountProfileId}>{busy ? 'Opening…' : 'Open chat'}<Icon name="arrow" size={16} /></button>
  </form></div>
}

function History({ close, choose, cards, initialProject = 'all' }: { close: () => void; choose: (id: string) => void; cards: { id: string; title: string }[]; initialProject?: string }) {
  const dialog = useChatDialogFocus<HTMLElement>(true, close)
  const state = useDesktop()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState(initialProject)
  const [opening, setOpening] = useState<string | null>(null)
  const [action, setAction] = useState<string | null>(null)
  const [recoveryId, setRecoveryId] = useState<string | null>(null)
  const [nativeId, setNativeId] = useState('')
  const [forgetting, setForgetting] = useState<ChatSession | null>(null)
  const [deletion, setDeletion] = useState<{ chatId: string; token: string; chatName: string; agent: string; nativeId: string; bytes: number; files: string[]; nativeSessions?: { id: string; title: string }[]; warning: string } | null>(null)
  const [deleteName, setDeleteName] = useState('')
  const [error, setError] = useState('')
  const forgetDialog = useChatDialogFocus<HTMLDivElement>(!!forgetting, () => setForgetting(null))
  const deleteDialog = useChatDialogFocus<HTMLDivElement>(!!deletion, () => setDeletion(null))
  const historySessions = state.sessions.filter(item => !item.open || item.hasConversation || item.pinned || (item.agent === 'shell' && item.lastInputAt))
  const items = [...historySessions].filter(item => (filter === 'archived' ? !!item.archived : !item.archived) && (projectFilter === 'all' || (projectFilter === 'hub' ? !item.projectId && item.cwd.toLowerCase() === state.repo.toLowerCase() : projectFilter === 'external' ? !item.projectId && item.cwd.toLowerCase() !== state.repo.toLowerCase() : item.projectId === projectFilter)) && (filter === 'all' || filter === 'archived' || (filter === 'pinned' ? item.pinned : item.agent === filter)) && `${item.name} ${item.agent} ${item.cwd} ${item.preview || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
  async function open(item: ChatSession) {
    if (opening) return
    setOpening(item.id); setError('')
    try { if (!item.open || item.status !== 'running') await api(`/sessions/${item.id}/resume`, {}); choose(item.id); close() }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      if (message.includes('native conversation could not be located')) { setRecoveryId(item.id); setNativeId('') }
    } finally { setOpening(null) }
  }
  async function reconnect(event: React.FormEvent, item: ChatSession) {
    event.preventDefault(); setOpening(item.id); setError('')
    try { await api(`/sessions/${item.id}/resume`, { nativeId: nativeId.trim() }); choose(item.id); close() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOpening(null) }
  }
  async function archive(item: ChatSession) {
    setAction(item.id); setError('')
    try { await api(`/sessions/${item.id}/archive`, { archived: !item.archived }); setRecoveryId(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setAction(null) }
  }
  async function forget(item: ChatSession) {
    setAction(item.id); setError('')
    try { await api(`/sessions/${item.id}/forget`, {}, 'DELETE'); setRecoveryId(null); setForgetting(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setAction(null) }
  }
  async function planNativeDelete(item: ChatSession) {
    setAction(item.id); setError('')
    try { const plan = await api<Omit<NonNullable<typeof deletion>, 'chatId'>>(`/sessions/${item.id}/deleteplan`, {}); setDeletion({ ...plan, chatId: item.id }); setDeleteName('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setAction(null) }
  }
  async function deleteNative() {
    if (!deletion || deleteName !== deletion.chatName) return
    setAction(deletion.chatId); setError('')
    try { await api(`/sessions/${deletion.chatId}/deletenative`, { token: deletion.token, name: deleteName }); setDeletion(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setAction(null) }
  }
  async function changeWorkingProject(item: ChatSession, repositoryId: string) {
    if (action || opening) return
    const project = state.projects.find(project => project.id === item.projectId)
    const target = project?.repositories.find(repository => repository.id === repositoryId)?.name || 'Workspace planning'
    if (!window.confirm(`Continue this conversation in ${target}? Its messages and account are kept. Files are not moved; an incompatible card association is cleared. Permissions and tools are recalculated when you reopen the chat.`)) return
    setAction(item.id); setError('')
    try { await api(`/sessions/${item.id}/workingproject`, { repositoryId: repositoryId || null, expected: { cwd: item.cwd, projectId: item.projectId, repositoryId: item.repositoryId } }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setAction(null) }
  }
  return <div className="desk-scrim chat-history-scrim" onClick={close}><section ref={dialog} tabIndex={-1} className="chat-history" role="dialog" aria-modal="true" aria-label="Chat history" onClick={event => event.stopPropagation()}>
    <header><span><Icon name="history" /><strong>History</strong><small>{historySessions.filter(item => !item.archived).length} conversations</small></span><button className="desk-icon" aria-label="Close history" onClick={close}><Icon name="close" /></button></header>
    <div className="history-search"><Icon name="search" size={16} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a conversation…" aria-label="Search chat history" /></div>
    <div className="history-controls"><div className="history-scope">Workspace<DarkSelect label="History workspace" value={projectFilter} options={[{ value: 'all', label: 'All workspaces' }, { value: 'hub', label: 'Hub' }, { value: 'external', label: 'Unassigned folders' }, ...[...new Set([...state.projects.map(project => project.id), ...state.sessions.map(item => item.projectId).filter((id): id is string => !!id)])].map(id => ({ value: id, label: state.projects.find(project => project.id === id)?.name || 'Unlinked workspace' }))]} onChange={setProjectFilter} /></div>
    <div className="history-scope">Show<DarkSelect label="History filter" value={filter} options={[[ 'all', 'All' ], [ 'pinned', 'Pinned' ], [ 'codex', 'Codex' ], [ 'claude', 'Claude' ], [ 'opencode', 'OpenCode' ], [ 'archived', 'Archived' ]].map(([value, label]) => ({value, label}))} onChange={setFilter} /></div></div>
    {error && <p className="history-error" role="alert">{error}</p>}
    <div className="history-list">{items.map(item => <article key={item.id} className="history-item">
      <button className="history-open" onClick={() => void open(item)} disabled={!!opening || !!action} title={`Open ${item.name} · ${chatActivityLabel(item)}`}><span className="history-agent" style={{ color: state.agents.find(agent => agent.id === item.agent)?.color }}><SessionLogo session={item} size={24} combined /></span><span><strong className="history-title"><span>{item.name}</span><small className="history-interface">{item.chatInterface === 'chat' ? 'Chat' : 'CLI'}</small></strong><small>{(state.agents.find(agent => agent.id === item.agent)?.label || (item.agent === 'kimi' ? 'Kimi · saved' : item.agent))} · {item.open ? 'Open' : new Date(item.updatedAt || item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {state.projects.find(project => project.id === item.projectId)?.name || item.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0]}{item.repositoryId && item.projectId ? ` / ${state.projects.find(project => project.id === item.projectId)?.repositories.find(repository => repository.id === item.repositoryId)?.name || 'Unlinked project'}` : ''}{item.cardId ? ` / ${cards.find(card => card.id === item.cardId)?.title || 'Card'}` : ''}</small>{item.preview && <p>{item.preview}</p>}{item.repositoryId && item.projectId && !state.projects.find(project => project.id === item.projectId)?.repositories.some(repository => repository.id === item.repositoryId) && <em>Linked project removed · this chat cannot resume from Mr. Mik</em>}{!item.nativeId && item.hasConversation && item.agent === 'codex' && <em>Native ID not saved · recovery may be needed</em>}</span><Icon name={opening === item.id ? 'refresh' : 'arrow'} size={16} /></button>
      {item.nativeUnavailable && <p className="desk-error-inline" title={item.nativeUnavailable}>Native context not transferred · saved History/screen only</p>}
      <details className="history-management"><summary aria-label={`Manage ${item.name}`}><Icon name="filter" size={15} /></summary><div className="history-management-body">
      {item.agent === 'codex' && !item.open && <AccountProfileSelect compact value={item.accountProfileId || 'system'} onChange={profileId => { if (window.confirm('Continue this conversation with the selected account? Its existing context will be available to that account. No message is replayed.')) { setError(''); void api(`/sessions/${item.id}/account`, { profileId }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) } }} />}
      <div className="history-item-actions">
        <div className="history-location-selectors"><div className="history-association">Workspace<DarkSelect disabled={!!action || !!opening} label={`Associate ${item.name} with workspace`} title="Association changes organization only. Use Working project to change the actual working folder." compact value={item.projectId || ''} options={[{ value: '', label: 'No association' }, ...state.projects.map(project => ({ value: project.id, label: project.name })), ...(item.projectId && !state.projects.some(project => project.id === item.projectId) ? [{ value: item.projectId, label: 'Unlinked workspace' }] : [])]} onChange={value => { setError(''); void api(`/sessions/${item.id}`, { projectId: value || null }, 'PATCH').catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) }} /></div>
        <div className="history-association">Working project<DarkSelect label={`Working project for ${item.name}`} title={item.open ? 'Close this chat before changing its working project.' : !['codex', 'claude'].includes(item.agent) ? 'Working-folder changes are supported for Codex and Claude.' : 'Choose the folder used when this conversation is reopened.'} compact disabled={item.open || !!action || !!opening || !item.projectId || !['codex', 'claude'].includes(item.agent)} value={item.repositoryId || ''} options={[{ value: '', label: 'Workspace planning' }, ...(state.projects.find(project => project.id === item.projectId)?.repositories || []).map(repository => ({ value: repository.id, label: repository.name, disabled: !repository.available })), ...(item.repositoryId && !state.projects.find(project => project.id === item.projectId)?.repositories.some(repository => repository.id === item.repositoryId) ? [{ value: item.repositoryId, label: 'Unlinked project', disabled: true }] : [])]} onChange={value => { void changeWorkingProject(item, value) }} /></div></div>
        <button className={`history-action ${item.pinned ? 'active' : ''}`} aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`} onClick={() => api(`/sessions/${item.id}`, { pinned: !item.pinned }, 'PATCH').catch(reportError)}><Icon name="pin" size={13} /></button>
        <button className="history-action" disabled={item.open || !!action} onClick={() => void archive(item)}>{item.archived ? 'Restore' : 'Archive'}</button>
        <details className="history-more"><summary aria-label={`More actions for ${item.name}`}>···</summary><div><button disabled={item.open || !!action} onClick={() => setForgetting(item)}>Remove from Mr. Mik</button>{['codex', 'claude', 'opencode'].includes(item.agent) && <button className="danger" disabled={item.open || !!action || !item.nativeId} onClick={() => void planNativeDelete(item)}>Delete native chat…</button>}</div></details>
      </div>
      </div></details>
      {recoveryId === item.id && <form className="history-recovery" onSubmit={event => void reconnect(event, item)}><p>Mr. Mik could not identify this CLI conversation automatically. Enter its native session ID to resume it; the saved terminal screen is unchanged.</p><div><input aria-label={`Native ID for ${item.name}`} value={nativeId} onChange={event => setNativeId(event.target.value)} placeholder="Native session ID" required /><button disabled={!!opening}>Resume</button></div></form>}
    </article>)}{!items.length && <p className="desk-muted">{query ? 'No matching conversations.' : filter === 'archived' ? 'No archived conversations.' : filter === 'pinned' ? 'Pin a conversation to keep it close at hand.' : 'Closed chats will be here when you need them.'}</p>}</div>
    <footer>Archive hides a closed chat. Remove from Mr. Mik keeps its native CLI conversation. Native deletion is separate and irreversible.</footer>
    {forgetting && <div className="desk-scrim" onClick={() => setForgetting(null)}><div ref={forgetDialog} tabIndex={-1} className="desk-dialog history-delete-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Remove chat from Mr. Mik"><div className="desk-dialog-heading"><div><span className="desk-eyebrow">MR. MIK HISTORY</span><h2>Remove this chat?</h2></div><button className="desk-icon" onClick={() => setForgetting(null)} aria-label="Cancel"><Icon name="close" /></button></div><p><strong>{forgetting.name}</strong> will disappear from Mr. Mik History and its saved terminal screen will be removed.</p><p>{forgetting.nativeId ? 'The native CLI conversation will remain available by its ID.' : 'No native CLI ID was captured, so Mr. Mik may not be able to recover this conversation later.'}</p>{error && <p className="desk-error-inline" role="alert">{error}</p>}<div className="portable-actions"><button onClick={() => setForgetting(null)}>Cancel</button><button className="danger" disabled={!!action} onClick={() => void forget(forgetting)}>Remove from Mr. Mik</button></div></div></div>}
    {deletion && <div className="desk-scrim" onClick={() => setDeletion(null)}><div ref={deleteDialog} tabIndex={-1} className="desk-dialog history-delete-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Permanently delete native chat"><div className="desk-dialog-heading"><div><span className="desk-eyebrow">PERMANENT DELETION</span><h2>Delete native chat?</h2></div><button className="desk-icon" onClick={() => setDeletion(null)} aria-label="Cancel"><Icon name="close" /></button></div><p>{deletion.warning}</p><p><strong>{deletion.chatName}</strong> · {deletion.agent} · {deletion.nativeId}</p><p>{deletion.agent === 'opencode' ? `${deletion.nativeSessions?.length || 1} native database session${(deletion.nativeSessions?.length || 1) === 1 ? '' : 's'}` : `${deletion.files.length} target${deletion.files.length === 1 ? '' : 's'}`} · {Math.ceil(deletion.bytes / 1024)} KB transcript</p><ul>{deletion.nativeSessions?.map(member => <li key={member.id}>{member.title} · {member.id}</li>)}</ul><ul>{deletion.files.map(file => <li key={file}>{file}</li>)}</ul><label className="desk-field">Type the chat name to confirm<input value={deleteName} onChange={event => setDeleteName(event.target.value)} autoFocus /></label>{error && <p className="desk-error-inline" role="alert">{error}</p>}<div className="portable-actions"><button onClick={() => setDeletion(null)}>Cancel</button><button className="danger" disabled={!!action || deleteName !== deletion.chatName} onClick={() => void deleteNative()}>Delete permanently</button></div></div></div>}
  </section></div>
}

export default function Chats() {
  const state = useDesktop()
  const [newChat, setNewChat] = useState(false)
  const [switcher, setSwitcher] = useState(false)
  const searchDialog = useChatDialogFocus<HTMLDivElement>(switcher, () => setSwitcher(false))
  const [searchScope, setSearchScope] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const [historyProject, setHistoryProject] = useState('all')
  const [navigationExpanded, setNavigationExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [pinned, setPinned] = useState(false)
  const [compactChats, setCompactChats] = useState<Record<string, boolean>>({})
  const fontSize = state.settings.terminalFontSize || 13
  const [shortcuts] = useChatShortcuts()
  const [attachmentNotice, setAttachmentNotice] = useState({ id: '', text: '' })
  const [compose, setCompose] = useState<{ projectId?: string | null; cardId?: string | null; repositoryId?: string } | null>(null)
  const [workspaceCards, setWorkspaceCards] = useState<{ id: string; title: string }[]>([])
  const [accountChanging, setAccountChanging] = useState(false)
  const [graphicalDraft, setGraphicalDraft] = useState(false)
  const draftChanged = useCallback((value: boolean) => setGraphicalDraft(value), [])
  useEffect(() => {
    const refreshCards = () => { void api<{ entities: { id: string; title: string }[] }>('/workspace').then(value => setWorkspaceCards(value.entities)).catch(reportError) }
    refreshCards()
    return onServiceEvent(event => { if (event.type === 'workspace-changed') refreshCards() })
  }, [])
  const attachmentStatus = useCallback((id: string, text: string) => setAttachmentNotice(current => text || current.id === id ? { id, text } : current), [])
  const active = orderedChats(state.sessions)
  const session = active.find(item => item.id === state.selectedId) || active[0]
  const sessionProject = state.projects.find(item => item.id === session?.projectId)
  const sessionRepository = sessionProject?.repositories.find(item => item.id === session?.repositoryId)
  const sessionCard = workspaceCards.find(item => item.id === session?.cardId)
  const hubScope = sessionProject?.name || (session?.cwd === state.repo ? 'Global Hub' : 'No Hub association')
  const workingFolderName = sessionRepository?.repositoryPath?.split(/[\\/]/).filter(Boolean).slice(-1)[0]
  const workingScope = sessionRepository ? (!workingFolderName || sessionRepository.name.toLowerCase() === workingFolderName.toLowerCase() ? sessionRepository.name : `${sessionRepository.name} · ${workingFolderName}`) : (session?.repositoryId ? 'Unlinked project' : sessionProject ? 'Workspace planning' : session?.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || '')
  const savedKimi = session?.agent === 'kimi' && !['running', 'starting'].includes(session.status)
  const running = session?.status === 'running'
  const filtered = active.filter(item => (!searchScope || (item.projectId ? `project:${item.projectId}` : item.cwd.replace(/[\\/]+$/, '').toLowerCase() === state.repo.replace(/[\\/]+$/, '').toLowerCase() ? 'hub' : 'external') === searchScope) && `${item.name} ${item.agent} ${item.cwd} ${state.projects.find(project => project.id === item.projectId)?.name || 'Global Hub'} ${state.projects.find(project => project.id === item.projectId)?.repositories.find(repository => repository.id === item.repositoryId)?.name || ''}`.toLowerCase().includes(query.toLowerCase()))
  const choose = (id: string) => { selectChat(id); setSwitcher(false); setHistory(false) }
  const closeChat = (id: string) => api(`/sessions/${id}`, {}, 'DELETE').catch(reportError)
  useEffect(() => onServiceEvent(event => {
    if (event.type === 'navigate' && event.window === 'chats' && event.compose) { setCompose(event.compose); setNewChat(true) }
  }), [])
  useEffect(() => {
    if (state.connected && session && state.selectedId !== session.id) selectChat(session.id)
  }, [state.connected, state.selectedId, session])
  useEffect(() => {
    if (!state.connected || !session?.unread || history || switcher || newChat || navigationExpanded) return
    let timer = 0
    const viewed = () => {
      clearTimeout(timer)
      if (document.visibilityState !== 'visible' || !document.hasFocus() || document.querySelector('dialog[open]')) return
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible' && document.hasFocus() && !document.querySelector('dialog[open]')) sendEvent({ type: 'seen', id: session.id, completionVersion: session.completionVersion })
      }, 600)
    }
    viewed()
    const off = onServiceEvent(event => { if ((event.type === 'chat-view' && event.id === session.id) || (event.type === 'snapshot' && event.session?.id === session.id)) viewed() })
    window.addEventListener('focus', viewed)
    window.addEventListener('blur', viewed)
    document.addEventListener('visibilitychange', viewed)
    document.addEventListener('close', viewed, true)
    return () => { off(); clearTimeout(timer); window.removeEventListener('focus', viewed); window.removeEventListener('blur', viewed); document.removeEventListener('visibilitychange', viewed); document.removeEventListener('close', viewed, true) }
  }, [state.connected, session?.id, session?.unread, session?.completionVersion, history, switcher, newChat, navigationExpanded])
  useEffect(() => {
    document.title = 'Mr. Mik — Chats'
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"],dialog[open]')) return
      const chord = shortcutChord(event)
      if (chord === shortcuts.new) { event.preventDefault(); setNewChat(true) }
      if (chord === shortcuts.search) { event.preventDefault(); setSearchScope(null); setQuery(''); setSwitcher(value => !value) }
      if (event.key === 'Escape') { setSwitcher(false); setNewChat(false); setHistory(false) }
      if (chord === shortcuts.history) { event.preventDefault(); setHistoryProject('all'); setHistory(value => !value) }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyW' && session?.id) { event.preventDefault(); api(`/sessions/${session.id}`, {}, 'DELETE').catch(reportError) }
      const openChats = orderedChats(state.sessions)
      if (event.ctrlKey && event.code === 'Tab' && openChats.length) {
        event.preventDefault()
        const index = openChats.findIndex(item => item.id === session?.id)
        selectChat(openChats[(index + (event.shiftKey ? -1 : 1) + openChats.length) % openChats.length].id)
      }
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        const target = openChats[Number(event.key) - 1]
        if (target) { event.preventDefault(); selectChat(target.id) }
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [state.sessions, session?.id, shortcuts])
  const showHistory = (project = 'all') => { setHistoryProject(project); setHistory(true); setSwitcher(false) }
  const accountControl = session?.agent === 'codex' ? <AccountProfileSelect compact value={session.accountProfileId || ''} disabled={session.status === 'starting' || accountChanging || session.chatInterface === 'chat' && graphicalDraft || running && (session.activity !== 'idle' || !!session.codexPermissionsPending)} onChange={profileId => { setAccountChanging(true); void api(`/sessions/${session.id}/account`, { profileId }).catch(reportError).finally(() => setAccountChanging(false)) }} /> : session?.agent === 'claude' ? <div className="conversation-profile-readonly" title="This conversation keeps its original account">{session.accountProfileLabel || 'Claude · current account'}</div> : null
  const conversationActions = session ? <ConversationActions key={session.id} session={session} /> : null

  return <div className="chats-surface">
    <header className="chats-header"><div className="chats-brand"><Nose size={25} tone="black" /><span>Mr. Mik <b>Chats</b></span></div><div className="chats-header-actions"><button className="desk-icon" title="Restore default window layout" aria-label="Restore default window layout" onClick={() => windowAction('chats', 'layout')}><Icon name="layout" size={18} /></button><button className={`desk-icon ${pinned ? 'active' : ''}`} title="Keep Chats above other windows" onClick={() => { setPinned(!pinned); windowAction('chats', 'pin', !pinned) }}><Icon name="pin" size={16} /></button><button className="desk-icon" title="Show Workspace" onClick={() => windowAction('workspace')}><Icon name="workspace" size={18} /></button></div></header>
    <ProjectChatNavigation onSearch={scope => { setSearchScope(scope || null); setQuery(''); setSwitcher(true); setHistory(false) }} onHistory={showHistory} onExpandedChange={setNavigationExpanded} items={active} selectedId={session?.id} choose={choose} close={closeChat} newChat={(projectId, repositoryId) => { setCompose({ projectId, repositoryId }); setNewChat(true) }}>
    <div className="chat-tabs-row"><div className="project-chat-current">{session && <><SessionLogo session={session} combined feedback={false} /><div><strong>{session.name}</strong><small>{hubScope} · {workingScope}</small></div></>}</div>{session && session.chatInterface !== 'chat' && <div className="chat-tab-actions">{!savedKimi && <button type="button" className="desk-icon" aria-label="Attach files" title="Attach file or folder paths" onClick={() => window.dispatchEvent(new Event('mrmak-attach-file'))}><Icon name="attach" size={16} /></button>}{session.agent === 'codex' && <button type="button" className="desk-icon" aria-label={compactChats[session.id] ? 'Show operations' : 'Hide operations'} aria-pressed={!compactChats[session.id]} title="Toggle CLI operation conversational view" onClick={() => setCompactChats(current => ({ ...current, [session.id]: !current[session.id] }))}><Icon name={compactChats[session.id] ? 'eyeOff' : 'eye'} size={16} /></button>}</div>}</div>
    <div className="chat-body">
    {history && <History key={historyProject} initialProject={historyProject} close={() => setHistory(false)} choose={choose} cards={workspaceCards} />}
    {switcher && <div className="desk-scrim chat-search-scrim" onClick={() => setSwitcher(false)}><div ref={searchDialog} tabIndex={-1} className="chat-switcher" role="dialog" aria-modal="true" aria-label="Find a chat" onClick={event => event.stopPropagation()}><header className="chat-search-heading"><strong>{searchScope?.startsWith('project:') ? state.projects.find(project => `project:${project.id}` === searchScope)?.name || 'Workspace' : searchScope === 'hub' ? 'Global Hub' : searchScope === 'external' ? 'External folders' : 'Search'}</strong><button type="button" className="desk-icon" aria-label="Close search" onClick={() => setSwitcher(false)}><Icon name="close" size={16} /></button></header><div className="switcher-search"><Icon name="search" size={16} /><input autoFocus placeholder="Find any chat…" value={query} onChange={event => setQuery(event.target.value)} /></div><nav className="chat-search-tabs" aria-label="Search scope"><button type="button" aria-pressed="true">Open chats</button>{session?.chatInterface === 'chat' && <button type="button" onClick={() => { setSwitcher(false); requestAnimationFrame(() => window.dispatchEvent(new KeyboardEvent('keydown', { key:'f', ctrlKey:true, bubbles:true }))) }}>This conversation</button>}</nav><div className="switcher-list">{filtered.map(item => <button key={item.id} onClick={() => choose(item.id)} className={session?.id === item.id ? 'selected' : ''}><span className="agent-letter" style={{ color: state.agents.find(a => a.id === item.agent)?.color }}><SessionLogo session={item} size={19} /></span><span><strong>{item.name}</strong><small title={item.cwd}>{state.projects.find(project => project.id === item.projectId)?.name || 'Global Hub'} · {item.agent === 'claude' ? 'Claude' : item.agent === 'codex' ? 'Codex' : item.agent === 'shell' ? 'PowerShell' : 'OpenCode'} · {item.chatInterface === 'chat' ? 'Chat' : 'CLI'}</small></span><span className="switcher-state">{chatActivityLabel(item)}</span></button>)}{!filtered.length && <p className="desk-muted">No matching chats.</p>}</div></div></div>}
    {session ? <ConversationChrome.Provider value={{ account: accountControl, actions: conversationActions, summary: <dl className="graphical-info-rows"><div><dt>Conversation</dt><dd>{session.name}</dd></div><div><dt>Project</dt><dd>{hubScope}</dd></div><div><dt>Interface</dt><dd>{session.chatInterface === 'chat' ? 'Chat' : 'CLI'}</dd></div><div><dt>Platform</dt><dd>{session.agent === 'claude' ? 'Claude' : session.agent === 'codex' ? 'Codex' : session.agent === 'shell' ? 'PowerShell' : 'OpenCode'}</dd></div></dl>, context: <dl className="graphical-info-rows"><div><dt>Workspace</dt><dd>{hubScope}</dd></div><div><dt>Working project</dt><dd>{workingScope}</dd></div><div><dt>Card</dt><dd>{sessionCard?.title || 'None'}</dd></div></dl> }}>
      {session.toolRefresh && !session.toolRefresh.silent && <div className={`chat-tool-refresh ${session.toolRefresh.status}`} role="status"><Icon name="refresh" size={13} /><span title={session.toolRefresh.reason}>{session.toolRefresh.status === 'applied' ? session.toolRefresh.reason : session.toolRefresh.status === 'applying' ? 'Updating tools and skills…' : session.toolRefresh.reason}</span>{['pending', 'failed'].includes(session.toolRefresh.status) && <button className="desk-icon" aria-label="Apply native configuration to this chat" title="Apply tools and skills · requires an idle, empty native prompt" disabled={!running || session.activity !== 'idle'} onClick={() => void api(`/sessions/${session.id}/toolsrefresh`, {}).catch(reportError)}><Icon name="refresh" size={14} /></button>}</div>}
      {session.agent === 'opencode' && <NativeMessageActions key={`actions-${session.id}`} id={session.id} disabled={!running || session.activity !== 'idle'} />}
      {session.chatInterface === 'chat' ? session.status === 'starting' ? <StartingChat key={session.id} session={session} /> : session.agent === 'codex' ? <GraphicalChat key={session.id} session={session} serviceConnected={state.connected} onDraftChange={draftChanged} /> : <ProviderGraphicalChat key={session.id} session={session} serviceConnected={state.connected} onDraftChange={draftChanged} /> : <TerminalPane key={session.id} id={session.id} agent={session.agent} fontSize={fontSize} appearance={state.settings.terminalAppearance || 'focus'} compact={!!compactChats[session.id]} onNative={() => setCompactChats(current => ({ ...current, [session.id]: false }))} onAttachmentStatus={attachmentStatus} />}
      {state.connected && !running && session.status !== 'starting' && !savedKimi && <div className="terminal-reconnect"><span>{session.restoreError || 'Reconnecting to your conversation…'}</span><button onClick={() => api(`/sessions/${session.id}/resume`, {}).catch(reportError)}>Reconnect</button></div>}
      {session.chatInterface !== 'chat' && <div className="cli-session-toolbar"><CliSessionPicker key={`picker-${session.id}`} session={session} />{session.agent === 'codex' && <CodexPermissionsSelect compact icon="" value={session.codexPermissions || (session.bypass ? 'bypass' : 'ask')} disabled={accountChanging} onChange={value => void api(`/sessions/${session.id}/permissions`, { codexPermissions: value }).catch(reportError)} />}{session.agent === 'claude' && <ClaudeCliPermissionsSelect session={session} disabled={accountChanging} />}<span className="cli-session-spacer" /><CliChatDetails key={`details-${session.id}`} connected={state.connected && running}><dl className="graphical-info-rows"><div><dt>Account</dt><dd>{session.accountProfileLabel || (session.agent === 'claude' ? 'Claude · current account' : 'Native account')}</dd></div></dl>{session.codexPermissionsPending && <p role="status">Permissions pending · waits for an idle prompt</p>}</CliChatDetails>{!savedKimi && <TerminalControl key={session.id} session={session} />}</div>}
      <footer className="chat-status">{attachmentNotice.id === session.id && attachmentNotice.text ? <span className="attachment-status" role="status"><Icon name="attach" size={12} /><span>{attachmentNotice.text}</span></span> : <><span><i className={state.connected ? 'connected-dot' : 'disconnected-dot'} />{state.connected ? savedKimi ? 'Saved Kimi chat · read only' : running ? 'Saved' : '' : ''}</span><span title={session.effort ? 'Reasoning effort · terminal permissions' : undefined}>{session.agent === 'codex' && `${session.accountProfileId && session.accountProfileId !== 'system' ? (session.status === 'starting' ? 'Codex account' : session.accountProfileLabel) || 'Codex account' : 'Choose an account'}${session.chatInterface === 'chat' ? '' : ' · '}`}{session.chatInterface !== 'chat' && session.effort && `${session.effort} · `}{session.chatInterface === 'chat' ? '' : session.agent === 'shell' ? 'Windows' : session.agent === 'codex' ? session.codexPermissionsPending ? 'Permissions · waiting to restart' : codexPermissionsOptions.find(item => item.value === (session.codexPermissions || (session.bypass ? 'bypass' : 'ask')))?.label : session.bypass ? 'Bypass' : 'CLI permissions'}</span><span className="status-shortcut">Ctrl+V · image</span></>}</footer>
    </ConversationChrome.Provider> : <div className="chats-empty"><div className="empty-orbit"><Nose size={64} tone="black" /></div><span className="desk-eyebrow">ROOM TO THINK</span><h1>Your agents,<br />close at hand.</h1><p>A chat for each task.<br />Keep this window beside whatever<br />you are working on.</p><button className="desk-primary" onClick={() => setNewChat(true)}><Icon name="plus" size={17} />Open your first chat</button><div className="empty-agent-names"><span>Claude</span><span>Codex</span><span>OpenCode</span></div><small>Your subscriptions. Your local files.</small></div>}
    </div>
    </ProjectChatNavigation>
    {newChat && <NewChat key={`${compose?.projectId || ''}:${compose?.cardId || ''}:${compose?.repositoryId || ''}`} initial={compose} close={() => { setNewChat(false); setCompose(null) }} />}
  </div>
}
