import { useCallback, useEffect, useState } from 'react'
import { api, onServiceEvent, reportError, selectChat, sendEvent, useDesktop, windowAction } from './client'
import type { AgentId, ChatSession } from './types'
import { AgentLogo, Icon, Nose } from './Icons'
import TerminalPane from './TerminalPane'
import TerminalControl from './TerminalControl'
import SessionLogo from './SessionLogo'
import { chatActivityLabel } from './chatActivity'
import ChatTabs from './ChatTabs'
import CodexModelMenu from './CodexModelMenu'
import DarkSelect from './DarkSelect'
import { orderedChats, tabColors } from './chatOrder'

function NewChat({ close, initial }: { close: () => void; initial?: { projectId?: string | null; cardId?: string | null } | null }) {
  const state = useDesktop()
  const [agent, setAgent] = useState<AgentId>(initial ? 'codex' : state.settings.defaultAgent)
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(state.repo)
  const [projectId, setProjectId] = useState(initial?.projectId || state.settings.selectedProjectId || '')
  const [cardId, setCardId] = useState(initial?.cardId || '')
  const [repositoryId, setRepositoryId] = useState('')
  const [cards, setCards] = useState<{ id: string; title: string; projectId?: string | null; repositoryId?: string | null }[]>([])
  const [bypass, setBypass] = useState(state.settings.defaultBypass)
  const [resumeId, setResumeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void api<{ entities: typeof cards }>('/workspace').then(value => setCards(value.entities)).catch(reportError) }, [])
  const project = state.projects.find(item => item.id === projectId)
  const cardRepositoryId = cards.find(item => item.id === cardId && item.projectId === projectId)?.repositoryId
  const effectiveRepositoryId = repositoryId || (cardId && cards.length ? project?.repositories.find(item => item.id === cardRepositoryId && item.available)?.id || 'hub' : project?.repositories.find(item => item.available)?.id || 'hub')
  const selectedRepository = project?.repositories.find(item => item.id === effectiveRepositoryId)
  async function launch(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const session = await api<ChatSession>('/sessions', { agent, name: name.trim() || undefined, projectId: projectId || null, repositoryId: projectId ? effectiveRepositoryId : null, cardId: cardId || null, cwd, bypass, resumeId: resumeId.trim() || undefined })
      await api('/settings', { defaultAgent: agent, defaultBypass: bypass })
      selectChat(session.id); close()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false) }
  }
  return <div className="desk-scrim" onClick={close}><form className="desk-dialog" onClick={event => event.stopPropagation()} onSubmit={launch}>
    <div className="desk-dialog-heading"><div><span className="desk-eyebrow">A PLACE FOR THE NEXT THING</span><h2>New chat</h2></div><button type="button" className="desk-icon" onClick={close} aria-label="Close"><Icon name="close" /></button></div>
    <div className="agent-picker">{state.agents.map(item => <button type="button" key={item.id} className={`agent-choice ${agent === item.id ? 'selected' : ''}`} onClick={() => setAgent(item.id)} disabled={!item.available} style={{ '--agent-color': item.color } as React.CSSProperties}><span className="agent-mark"><AgentLogo agent={item.id} size={23} /></span><span>{item.label}<small>{item.available ? item.subscription ? 'Your subscription' : 'Local terminal' : 'Not installed'}</small></span>{agent === item.id && <span className="choice-check">✓</span>}</button>)}</div>
    <label className="desk-field">Chat name <small>English only</small><input autoFocus placeholder="e.g. Dream Game · animations" value={name} onChange={event => setName(event.target.value)} maxLength={100} /></label>
    <div className="desk-field">Workspace<DarkSelect label="Workspace" value={projectId} options={[{ value: '', label: 'Hub / custom folder' }, ...state.projects.map(project => ({ value: project.id, label: project.name }))]} onChange={value => { setProjectId(value); setCardId(''); setRepositoryId('') }} /></div>
    {projectId && <><div className="desk-field">Card <small>optional</small><DarkSelect label="Card" value={cardId} options={[{ value: '', label: 'No card' }, ...cards.filter(card => card.projectId === projectId).map(card => ({ value: card.id, label: card.title }))]} onChange={value => { setCardId(value); setRepositoryId('') }} /></div><div className="desk-field">Working project<DarkSelect label="Working project" value={effectiveRepositoryId} options={[{ value: 'hub', label: 'No linked project · workspace planning' }, ...(project?.repositories.map(repository => ({ value: repository.id, label: `${repository.name}${repository.available ? '' : ' · missing'}`, disabled: !repository.available })) || [])]} onChange={setRepositoryId} /></div></>}
    <label className="desk-field">Working folder<input value={projectId ? selectedRepository?.repositoryPath || 'Mr. Mik workspace planning area' : cwd} onChange={event => setCwd(event.target.value)} readOnly={!!projectId} required spellCheck={false} /></label>
    {projectId && agent === 'codex' && <p className="desk-muted">Scoped Workspace Bridge enabled. Other linked projects are discoverable but do not become the working folder.</p>}
    {agent !== 'shell' && <><label className="desk-check"><input type="checkbox" checked={bypass} onChange={event => setBypass(event.target.checked)} /><span>Bypass agent permission prompts<small>Same Windows account and file access as your usual terminal.</small></span></label><details className="desk-details"><summary>Resume an existing CLI conversation</summary><p>For a conversation started outside Mr. Mik, copy its ID from your CLI's session details or resume picker. Chats created here return automatically.</p><label className="desk-field">Native session ID<input value={resumeId} onChange={event => setResumeId(event.target.value)} placeholder="Optional session ID" /></label></details></>}
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
    <button className="desk-primary" disabled={busy || !state.connected}>{busy ? 'Opening…' : 'Open chat'}<Icon name="arrow" size={16} /></button>
  </form></div>
}

function History({ close, choose, cards }: { close: () => void; choose: (id: string) => void; cards: { id: string; title: string }[] }) {
  const state = useDesktop()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [opening, setOpening] = useState<string | null>(null)
  const [action, setAction] = useState<string | null>(null)
  const [recoveryId, setRecoveryId] = useState<string | null>(null)
  const [nativeId, setNativeId] = useState('')
  const [forgetting, setForgetting] = useState<ChatSession | null>(null)
  const [deletion, setDeletion] = useState<{ chatId: string; token: string; chatName: string; agent: string; nativeId: string; bytes: number; files: string[]; warning: string } | null>(null)
  const [deleteName, setDeleteName] = useState('')
  const [error, setError] = useState('')
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
  return <section className="chat-history" aria-label="Chat history">
    <header><span><Icon name="history" /><strong>History</strong><small>{historySessions.filter(item => !item.archived).length} conversations</small></span><button className="desk-icon" aria-label="Close history" onClick={close}><Icon name="close" /></button></header>
    <div className="history-search"><Icon name="search" size={16} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a conversation…" aria-label="Search chat history" /></div>
    <div className="history-scope">Workspace<DarkSelect label="History workspace" value={projectFilter} options={[{ value: 'all', label: 'All workspaces' }, { value: 'hub', label: 'Hub' }, { value: 'external', label: 'Unassigned folders' }, ...[...new Set([...state.projects.map(project => project.id), ...state.sessions.map(item => item.projectId).filter((id): id is string => !!id)])].map(id => ({ value: id, label: state.projects.find(project => project.id === id)?.name || 'Unlinked workspace' }))]} onChange={setProjectFilter} /></div>
    <div className="history-filters">{[['all', 'All'], ['pinned', 'Pinned'], ['codex', 'Codex'], ['claude', 'Claude'], ['archived', 'Archived']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {error && <p className="history-error" role="alert">{error}</p>}
    <div className="history-list">{items.map(item => <article key={item.id} className="history-item">
      <button className="history-open" onClick={() => void open(item)} disabled={!!opening || !!action} title={`Open ${item.name} · ${chatActivityLabel(item)}`}><span className="history-agent" style={{ color: state.agents.find(agent => agent.id === item.agent)?.color }}><SessionLogo session={item} size={24} /></span><span><strong>{item.name}</strong><small>{state.agents.find(agent => agent.id === item.agent)?.label} · {item.open ? 'Open' : new Date(item.updatedAt || item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {state.projects.find(project => project.id === item.projectId)?.name || item.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0]}{item.repositoryId && item.projectId ? ` / ${state.projects.find(project => project.id === item.projectId)?.repositories.find(repository => repository.id === item.repositoryId)?.name || 'Unlinked project'}` : ''}{item.cardId ? ` / ${cards.find(card => card.id === item.cardId)?.title || 'Card'}` : ''}</small>{item.preview && <p>{item.preview}</p>}{item.repositoryId && item.projectId && !state.projects.find(project => project.id === item.projectId)?.repositories.some(repository => repository.id === item.repositoryId) && <em>Linked project removed · this chat cannot resume from Mr. Mik</em>}{!item.nativeId && item.hasConversation && item.agent === 'codex' && <em>Native ID not saved · recovery may be needed</em>}</span><Icon name={opening === item.id ? 'refresh' : 'arrow'} size={16} /></button>
      <div className="history-item-actions">
        <div className="history-association">Workspace<DarkSelect label={`Associate ${item.name} with workspace`} title="Association changes organization only. The native conversation and working folder stay unchanged." compact value={item.projectId || ''} options={[{ value: '', label: 'No association' }, ...state.projects.map(project => ({ value: project.id, label: project.name })), ...(item.projectId && !state.projects.some(project => project.id === item.projectId) ? [{ value: item.projectId, label: 'Unlinked workspace' }] : [])]} onChange={value => { setError(''); void api(`/sessions/${item.id}`, { projectId: value || null }, 'PATCH').catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) }} /></div>
        <button className={`history-action ${item.pinned ? 'active' : ''}`} aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`} onClick={() => api(`/sessions/${item.id}`, { pinned: !item.pinned }, 'PATCH').catch(reportError)}><Icon name="pin" size={13} /></button>
        <button className="history-action" disabled={item.open || !!action} onClick={() => void archive(item)}>{item.archived ? 'Restore' : 'Archive'}</button>
        <details className="history-more"><summary aria-label={`More actions for ${item.name}`}>···</summary><div><button disabled={item.open || !!action} onClick={() => setForgetting(item)}>Remove from Mr. Mik</button>{['codex', 'claude'].includes(item.agent) && <button className="danger" disabled={item.open || !!action || !item.nativeId} onClick={() => void planNativeDelete(item)}>Delete native chat…</button>}</div></details>
      </div>
      {recoveryId === item.id && <form className="history-recovery" onSubmit={event => void reconnect(event, item)}><p>Mr. Mik could not identify this CLI conversation automatically. Enter its native session ID to resume it; the saved terminal screen is unchanged.</p><div><input aria-label={`Native ID for ${item.name}`} value={nativeId} onChange={event => setNativeId(event.target.value)} placeholder="Native session ID" required /><button disabled={!!opening}>Resume</button></div></form>}
    </article>)}{!items.length && <p className="desk-muted">{query ? 'No matching conversations.' : filter === 'archived' ? 'No archived conversations.' : filter === 'pinned' ? 'Pin a conversation to keep it close at hand.' : 'Closed chats will be here when you need them.'}</p>}</div>
    <footer>Archive hides a closed chat. Remove from Mr. Mik keeps its native CLI conversation. Native deletion is separate and irreversible.</footer>
    {forgetting && <div className="desk-scrim" onClick={() => setForgetting(null)}><div className="desk-dialog history-delete-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Remove chat from Mr. Mik"><div className="desk-dialog-heading"><div><span className="desk-eyebrow">MR. MIK HISTORY</span><h2>Remove this chat?</h2></div><button className="desk-icon" onClick={() => setForgetting(null)} aria-label="Cancel"><Icon name="close" /></button></div><p><strong>{forgetting.name}</strong> will disappear from Mr. Mik History and its saved terminal screen will be removed.</p><p>{forgetting.nativeId ? 'The native CLI conversation will remain available by its ID.' : 'No native CLI ID was captured, so Mr. Mik may not be able to recover this conversation later.'}</p>{error && <p className="desk-error-inline" role="alert">{error}</p>}<div className="portable-actions"><button onClick={() => setForgetting(null)}>Cancel</button><button className="danger" disabled={!!action} onClick={() => void forget(forgetting)}>Remove from Mr. Mik</button></div></div></div>}
    {deletion && <div className="desk-scrim" onClick={() => setDeletion(null)}><div className="desk-dialog history-delete-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Permanently delete native chat"><div className="desk-dialog-heading"><div><span className="desk-eyebrow">PERMANENT DELETION</span><h2>Delete native chat?</h2></div><button className="desk-icon" onClick={() => setDeletion(null)} aria-label="Cancel"><Icon name="close" /></button></div><p>{deletion.warning}</p><p><strong>{deletion.chatName}</strong> · {deletion.agent} · {deletion.nativeId}</p><p>{deletion.files.length} target{deletion.files.length === 1 ? '' : 's'} · {Math.ceil(deletion.bytes / 1024)} KB transcript</p><ul>{deletion.files.map(file => <li key={file}>{file}</li>)}</ul><label className="desk-field">Type the chat name to confirm<input value={deleteName} onChange={event => setDeleteName(event.target.value)} autoFocus /></label>{error && <p className="desk-error-inline" role="alert">{error}</p>}<div className="portable-actions"><button onClick={() => setDeletion(null)}>Cancel</button><button className="danger" disabled={!!action || deleteName !== deletion.chatName} onClick={() => void deleteNative()}>Delete permanently</button></div></div></div>}
  </section>
}

export default function Chats() {
  const state = useDesktop()
  const [newChat, setNewChat] = useState(false)
  const [switcher, setSwitcher] = useState(false)
  const [history, setHistory] = useState(false)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')
  const [pinned, setPinned] = useState(false)
  const [fontSize, setFontSize] = useState(() => state.settings.terminalFontSize || 13)
  const [attachmentNotice, setAttachmentNotice] = useState({ id: '', text: '' })
  const [compose, setCompose] = useState<{ projectId?: string | null; cardId?: string | null } | null>(null)
  const [workspaceCards, setWorkspaceCards] = useState<{ id: string; title: string }[]>([])
  useEffect(() => {
    const refreshCards = () => { void api<{ entities: { id: string; title: string }[] }>('/workspace').then(value => setWorkspaceCards(value.entities)).catch(reportError) }
    refreshCards()
    return onServiceEvent(event => { if (event.type === 'workspace-changed') refreshCards() })
  }, [])
  const attachmentStatus = useCallback((id: string, text: string) => setAttachmentNotice(current => text || current.id === id ? { id, text } : current), [])
  const active = orderedChats(state.sessions)
  const session = active.find(item => item.id === state.selectedId) || active[0]
  const agent = state.agents.find(item => item.id === session?.agent)
  const sessionProject = state.projects.find(item => item.id === session?.projectId)
  const sessionRepository = sessionProject?.repositories.find(item => item.id === session?.repositoryId)
  const sessionCard = workspaceCards.find(item => item.id === session?.cardId)
  const hubScope = sessionProject?.name || (session?.cwd === state.repo ? 'Global Hub' : 'No Hub association')
  const workingFolderName = sessionRepository?.repositoryPath?.split(/[\\/]/).filter(Boolean).slice(-1)[0]
  const workingScope = sessionRepository ? (!workingFolderName || sessionRepository.name.toLowerCase() === workingFolderName.toLowerCase() ? sessionRepository.name : `${sessionRepository.name} · ${workingFolderName}`) : (session?.repositoryId ? 'Unlinked project' : sessionProject ? 'Workspace planning' : session?.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || '')
  const running = session?.status === 'running' || session?.status === 'starting'
  const filtered = active.filter(item => `${item.name} ${item.agent} ${item.cwd}`.toLowerCase().includes(query.toLowerCase()))
  const choose = (id: string) => { selectChat(id); setSwitcher(false); setMenu(false); setHistory(false); setRenaming(false) }
  const closeChat = (id: string) => api(`/sessions/${id}`, {}, 'DELETE').catch(reportError)
  useEffect(() => onServiceEvent(event => {
    if (event.type === 'navigate' && event.window === 'chats' && event.compose) { setCompose(event.compose); setNewChat(true) }
  }), [])
  useEffect(() => {
    if (!state.connected || !session?.unread || history || switcher || newChat) return
    let timer = 0
    const viewed = () => {
      clearTimeout(timer)
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible' && document.hasFocus()) sendEvent({ type: 'seen', id: session.id, completionVersion: session.completionVersion })
      }, 600)
    }
    viewed()
    window.addEventListener('focus', viewed)
    window.addEventListener('blur', viewed)
    document.addEventListener('visibilitychange', viewed)
    return () => { clearTimeout(timer); window.removeEventListener('focus', viewed); window.removeEventListener('blur', viewed); document.removeEventListener('visibilitychange', viewed) }
  }, [state.connected, session?.id, session?.unread, session?.completionVersion, history, switcher, newChat])
  useEffect(() => {
    document.title = 'Mr. Mik — Chats'
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyT') { event.preventDefault(); setNewChat(true) }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyP') { event.preventDefault(); setSwitcher(value => !value) }
      if (event.key === 'Escape') { setSwitcher(false); setMenu(false); setNewChat(false); setHistory(false) }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyH') { event.preventDefault(); setHistory(value => !value) }
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
  }, [state.sessions, session?.id])
  const changeFont = (delta: number) => { const value = Math.max(10, Math.min(24, fontSize + delta)); setFontSize(value); api('/settings', { terminalFontSize: value }).catch(reportError) }
  async function rename(event: React.FormEvent) { event.preventDefault(); if (!session) return; try { await api(`/sessions/${session.id}`, { name: title }, 'PATCH'); setRenaming(false) } catch (error) { reportError(error) } }

  return <div className="chats-surface">
    <header className="chats-header"><div className="chats-brand"><Nose size={25} tone="black" /><span>Mr. Mik <b>Chats</b></span></div><div className="chats-header-actions"><button className={`desk-icon ${pinned ? 'active' : ''}`} title="Keep Chats above other windows" onClick={() => { setPinned(!pinned); windowAction('chats', 'pin', !pinned) }}><Icon name="pin" size={16} /></button><button className="desk-icon" title="Show Workspace" onClick={() => windowAction('workspace')}><Icon name="workspace" size={18} /></button></div></header>
    <div className="chat-tabs-row"><ChatTabs items={active} selectedId={session?.id} agents={state.agents} choose={choose} close={closeChat} /><div className="chat-tab-actions"><button className="desk-icon new-chat-button" onClick={() => setNewChat(true)} title="New chat · Ctrl+Shift+T" aria-label="New chat"><Icon name="plus" /></button><button className="desk-icon" title="Fork selected conversation" aria-label="Fork selected conversation" disabled={!session?.nativeId || !['codex', 'claude'].includes(session?.agent || '') || session?.activity === 'working'} onClick={() => { if (session) void api(`/sessions/${session.id}/fork`, {}).catch(reportError) }}><Icon name="fork" size={16} /></button><button className={`desk-icon ${switcher ? 'active' : ''}`} onClick={() => { setSwitcher(value => !value); setHistory(false) }} title="Find a chat · Ctrl+Shift+P" aria-label="Find a chat"><Icon name="search" size={16} /></button><button className={`history-button ${history ? 'active' : ''}`} onClick={() => { setHistory(value => !value); setSwitcher(false); setMenu(false) }} title="History · Ctrl+Shift+H"><Icon name="history" size={15} /><span>History</span></button></div></div>
    <div className="chat-body">
    {history && <History close={() => setHistory(false)} choose={choose} cards={workspaceCards} />}
    {switcher && <div className="chat-switcher"><div className="switcher-search"><Icon name="search" size={16} /><input autoFocus placeholder="Find any chat…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="switcher-list">{filtered.map(item => <button key={item.id} onClick={() => choose(item.id)} className={session?.id === item.id ? 'selected' : ''}><span className="agent-letter" style={{ color: state.agents.find(a => a.id === item.agent)?.color }}><SessionLogo session={item} size={19} /></span><span><strong>{item.name}</strong><small>{item.cwd}</small></span><span className="switcher-state">{chatActivityLabel(item)}</span></button>)}{!filtered.length && <p className="desk-muted">No matching chats.</p>}</div></div>}
    {session ? <>
      <div className="chat-context"><span className="agent-label" style={{ color: agent?.color }}>{agent?.label}</span>{(session.agent === 'codex' || session.agent === 'claude') && <CodexModelMenu key={session.id} sessionId={session.id} running={running} agent={session.agent} />}<span className="chat-scopes" title={`Workspace: ${hubScope}\nWorking project: ${workingScope}\nWorking folder: ${session.cwd}${sessionCard ? `\nCard: ${sessionCard.title}` : ''}`}><span><b>Card</b> {sessionCard?.title || 'None linked'}</span></span><button className="desk-icon" title="Attach file paths · drop files or folders · Ctrl+V for screenshots" aria-label="Attach files" onClick={() => window.dispatchEvent(new Event('mrmak-attach-file'))}><Icon name="attach" size={16} /></button><button className="desk-icon" title="Chat options" onClick={() => setMenu(!menu)}><Icon name="more" size={18} /></button></div>
      {menu && <div className="chat-options">{renaming ? <form className="inline-rename" onSubmit={rename}><input autoFocus value={title} onChange={event => setTitle(event.target.value)} aria-label="English chat name" /><button type="submit">Save</button></form> : <button onClick={() => { setTitle(session.name); setRenaming(true) }}>Rename chat</button>}<button onClick={() => api(`/sessions/${session.id}`, { pinned: !session.pinned }, 'PATCH').catch(reportError)}>{session.pinned ? 'Unpin from History' : 'Pin in History'}</button><button onClick={() => api('/reveal', { path: session.cwd }).catch(reportError)}>Show working folder</button><button onClick={() => api(`/sessions/${session.id}/clear`, {}).then(() => setMenu(false)).catch(reportError)} title="Clear visible scrollback; keep the agent conversation">Clear terminal scrollback</button><div className="chat-color-setting"><span>Tab color</span><div role="group" aria-label="Tab color"><button className={`tab-color-swatch no-color ${!session.tabColor ? 'selected' : ''}`} aria-label="No tab color" aria-pressed={!session.tabColor} onClick={() => api(`/sessions/${session.id}`, { tabColor: null }, 'PATCH').catch(reportError)} title="No color" />{tabColors.map(color => <button key={color.value} className={`tab-color-swatch ${session.tabColor === color.value ? 'selected' : ''}`} style={{ '--swatch': color.value } as React.CSSProperties} aria-label={`${color.name} tab color`} aria-pressed={session.tabColor === color.value} title={color.name} onClick={() => api(`/sessions/${session.id}`, { tabColor: color.value }, 'PATCH').catch(reportError)} />)}</div></div><div className="terminal-appearance-setting"><span>Terminal appearance <small>All chats</small></span><div role="group" aria-label="Terminal appearance">{[['focus', 'Focus'], ['original', 'CLI colors']].map(([value, label]) => <button key={value} aria-pressed={(state.settings.terminalAppearance || 'focus') === value} onClick={() => api('/settings', { terminalAppearance: value }).catch(reportError)}>{label}</button>)}</div><p><i className="legend-user" />You <i className="legend-agent" />Agent <i className="legend-detail" />Details</p></div><div className="font-control"><span>Terminal text</span><button onClick={() => changeFont(-1)}>−</button><span>{fontSize}</span><button onClick={() => changeFont(1)}>+</button></div><button onClick={() => { closeChat(session.id); setMenu(false) }}>Close tab · save conversations in History</button></div>}
      <TerminalPane key={session.id} id={session.id} agent={session.agent} fontSize={fontSize} appearance={state.settings.terminalAppearance || 'focus'} onAttachmentStatus={attachmentStatus} />
      {!running && <div className="terminal-reconnect"><span>{session.restoreError || 'Reconnecting to your conversation…'}</span><button onClick={() => api(`/sessions/${session.id}/resume`, {}).catch(reportError)}>Reconnect</button></div>}
      <footer className="chat-status">{attachmentNotice.id === session.id && attachmentNotice.text ? <span className="attachment-status" role="status"><Icon name="attach" size={12} /><span>{attachmentNotice.text}</span></span> : <><span><i className={state.connected ? 'connected-dot' : 'disconnected-dot'} />{state.connected ? running ? 'Connected · autosaved' : 'Reconnecting…' : 'Reconnecting…'}</span><span title={session.effort ? 'Reasoning effort · terminal permissions' : undefined}>{session.effort && `${session.effort} · `}{session.agent === 'shell' ? 'Windows' : session.bypass ? 'Bypass' : 'CLI permissions'}</span><span className="status-shortcut">Ctrl+V · image</span></>}<TerminalControl key={session.id} session={session} /></footer>
    </> : <div className="chats-empty"><div className="empty-orbit"><Nose size={64} tone="black" /></div><span className="desk-eyebrow">ROOM TO THINK</span><h1>Your agents,<br />close at hand.</h1><p>A chat for each task.<br />Keep this window beside whatever<br />you are working on.</p><button className="desk-primary" onClick={() => setNewChat(true)}><Icon name="plus" size={17} />Open your first chat</button><div className="empty-agent-names"><span>Claude</span><span>Codex</span><span>Kimi</span></div><small>Your subscriptions. Your local files.</small></div>}
    </div>
    {newChat && <NewChat key={`${compose?.projectId || ''}:${compose?.cardId || ''}`} initial={compose} close={() => { setNewChat(false); setCompose(null) }} />}
  </div>
}
