import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onServiceEvent, useDesktop } from './client'
import type { MakScope, Operation, ReasoningEffort } from './types'
import { Icon, Nose } from './Icons'
import DarkSelect from './DarkSelect'
import ReasoningSelect from './ReasoningSelect'
import { useReasoningCapabilities } from './useReasoningCapabilities'
import ReactMarkdown from 'react-markdown'
import './mak.css'
import './mak-targets.css'

interface Confirmation { id: string; operationId: string; label: string; details: string; scope: MakScope }
interface MakState { history: Operation[]; state: string; confirmations: Confirmation[]; active: string | null; selected: string | null; effort?: ReasoningEffort; model?: string | null; conversations: { id: string; title: string; canFork: boolean; nativeUnavailable?: string | null }[] }
export default function MakPanel({ onClose }: { onClose: () => void }) {
  const { settings, projects, sessions, selectedId, notices } = useDesktop()
  const projectId = settings.selectedProjectId || null
  const project = projects.find(item => item.id === projectId)
  const [data, setData] = useState<MakState>({ history: [], state: 'idle', confirmations: [], active: null, selected: null, conversations: [] })
  const [showHistory, setShowHistory] = useState(false)
  const reasoning = useReasoningCapabilities(data.model)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState<'conversation' | 'activity'>('conversation')
  const [repositoryId, setRepositoryId] = useState('card')
  const [cardId, setCardId] = useState(() => { try { return decodeURIComponent(window.location.hash.replace(/^#\//, '').split('/')[0] || '') } catch { return '' } })
  const [cards, setCards] = useState<{ id: string; title: string; repositoryId?: string | null }[]>([])
  const currentCard = cards.find(item => item.id === cardId)
  const workingId = currentCard ? currentCard.repositoryId || '' : project?.repositories.some(item => item.id === repositoryId) ? repositoryId : ''
  const mounted = useRef(true)
  const scroll = useRef<HTMLDivElement>(null)
  const load = useCallback(async () => {
    const result = await api<MakState>(`/coordinator?projectId=${encodeURIComponent(projectId || '')}`)
    if (mounted.current) setData(result)
  }, [projectId])
  useEffect(() => {
    let live = true
    mounted.current = true
    void load().catch(cause => { if (live) setError(String(cause)) })
    const loadCards = () => api<{ entities: { id: string; title: string; projectId?: string | null; repositoryId?: string | null }[] }>('/workspace').then(registry => { if (live) setCards(registry.entities.filter(item => (item.projectId || null) === projectId)) }).catch(() => {})
    void loadCards()
    const timer = window.setInterval(() => void load().catch(() => {}), 2000)
    const off = onServiceEvent(event => {
      if (['coordinator-state', 'coordinator-result', 'coordinator-confirmation'].includes(event.type)) void load().catch(() => {})
      if (event.type === 'workspace-changed') void loadCards()
    })
    return () => { live = false; mounted.current = false; clearInterval(timer); off() }
  }, [projectId, load])
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [data.history.length])
  const pending = data.history.find(item => item.status === 'running')
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    if (!pending || stopping) return
    setStopping(true); setError('')
    try { await api('/coordinator/cancel', { id: pending.id }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setStopping(false) }
  }
  const submit = async () => {
    if (!text.trim() || sending || pending) return
    const currentText = text.trim()
    const scope: MakScope = { projectId, repositoryId: workingId || null, cardId: currentCard?.id || null, selectedId: sessions.find(item => item.id === selectedId && (item.projectId || null) === projectId)?.id || null }
    setSending(true); setError(''); setText('')
    try { await api('/coordinator', { id: crypto.randomUUID(), text: currentText, scope, conversationId: data.selected }); await load() }
    catch (cause) { if (mounted.current) { setError(cause instanceof Error ? cause.message : String(cause)); setText(currentText) } }
    finally { setSending(false) }
  }
  const respond = async (id: string, approved: boolean) => {
    try { await api('/coordinator/confirm', { id, approved }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const changeConversation = async (action: 'new' | 'fork' | 'select' | 'retry', id?: string) => {
    setSending(true); setError('')
    try { await api('/coordinator/conversation', { projectId, action, id }); await load() }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current) setSending(false) }
  }
  const changeEffort = async (effort: ReasoningEffort) => {
    setSending(true); setError('')
    try { await api('/coordinator/conversation', { projectId, action: 'effort', id: data.selected, effort }); await load() }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current) setSending(false) }
  }
  const changeModel = async (model: string) => {
    setSending(true); setError('')
    try { await api('/coordinator/conversation', { projectId, action: 'model', id: data.selected, model }); await load() }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current) setSending(false) }
  }
  return <section id="mak-conversation-panel" className="voice-panel mak-panel" aria-label="Mr. Mik conversation">
    <header><span><Nose size={24} /><strong>Mr. Mik</strong><small>{pending ? 'Working…' : 'At your service'}</small></span><div className="mak-header-actions"><button className="desk-icon" title="New Mik conversation" aria-label="New Mik conversation" disabled={sending || !!data.active} onClick={() => void changeConversation('new')}><Icon name="plus" size={15} /></button><button className="desk-icon" title="Fork Mik conversation" aria-label="Fork Mik conversation" disabled={sending || !!data.active || !data.conversations.find(item => item.id === data.selected)?.canFork} onClick={() => void changeConversation('fork')}><Icon name="fork" size={15} /></button><button className="desk-icon" title="Mik conversation History" aria-label="Mik conversation History" aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}><Icon name="history" size={15} /></button><button className="desk-icon" title="Hide conversation" aria-label="Close Mik" onClick={onClose}><Icon name="close" size={16} /></button></div></header>
    <div className="voice-tabs"><button className={tab === 'conversation' ? 'selected' : ''} onClick={() => setTab('conversation')}>Conversation</button><button className={tab === 'activity' ? 'selected' : ''} onClick={() => setTab('activity')}>Activity</button></div>
    <div className="mak-orientation"><strong>{project?.name || 'Global Hub'}</strong><small>Codex coordinator · {data.state}</small><p>Manage the Hub or coordinate visible worker chats. Requests keep their original workspace when you navigate.</p></div>
    {data.conversations.find(item => item.id === data.selected)?.nativeUnavailable && <p className="desk-error-inline">Native context not transferred. Visible History is retained; restore the native context before retrying, or explicitly start a new conversation.</p>}
    {tab === 'conversation' && showHistory && <div className="mak-targets"><DarkSelect label="Mik saved conversations" value={data.selected || ''} options={[{ value: '', label: 'No conversation yet', disabled: true }, ...data.conversations.map(item => ({ value: item.id, label: item.title }))]} onChange={id => { if (!sending && !data.active) void changeConversation('select', id) }} /></div>}
    {tab === 'conversation' && (cards.length > 0 || project) && <div className="mak-targets">
      {cards.length > 0 && <DarkSelect label="Mik card" value={currentCard?.id || ''} options={[{ value: '', label: 'No selected card' }, ...cards.map(card => ({ value: card.id, label: card.title }))]} onChange={id => { setCardId(id); setRepositoryId(cards.find(card => card.id === id)?.repositoryId || '') }} />}
      {currentCard ? <div className="mak-working-target"><small>Working project</small><span>{currentCard.repositoryId ? project?.repositories.find(item => item.id === currentCard.repositoryId)?.name || 'Linked project unavailable' : 'Workspace planning'}</span></div> : project && <DarkSelect label="Mik working project" value={workingId} options={[{ value: '', label: 'Workspace planning' }, ...project.repositories.map(item => ({ value: item.id, label: item.name, disabled: !item.available }))]} onChange={setRepositoryId} />}
    </div>}
    <div className="mak-conversation voice-messages" ref={scroll} aria-label="Mik conversation" aria-live="polite">
      {tab === 'conversation' ? <>{!data.history.length && <div className="voice-welcome"><p>One conversation.<br />Your whole workspace.</p><span>Ask Mik to organize cards, save a lesson, inspect a chat or prepare a task.</span></div>}
      {data.history.map(operation => <article className="mak-operation mak-exchange" key={operation.id}><p className="caption user"><span>You</span>{operation.text}</p><small>{operation.status} · {new Date(operation.at).toLocaleString()}</small>{operation.result && <div className="mak-answer caption assistant"><span>Mr. Mik</span><ReactMarkdown>{operation.result}</ReactMarkdown></div>}</article>)}</> : <>{notices.filter(notice => sessions.some(session => session.id === notice.sessionId && (session.projectId || null) === projectId)).length === 0 && <p className="desk-muted">Terminal attention requests and exits for this workspace appear here.</p>}{[...notices].reverse().filter(notice => sessions.some(session => session.id === notice.sessionId && (session.projectId || null) === projectId)).map(notice => <button className="activity-item" key={notice.id} onClick={() => void api(`/sessions/${notice.sessionId}/focus`, {}).catch(cause => setError(String(cause)))}><Icon name="bell" size={16} /><span><strong>{notice.name}</strong><small>{notice.text}</small></span><time>{new Date(notice.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></button>)}</>}
    </div>
    {data.confirmations.filter(item => item.scope.projectId === projectId).map(item => <div className="mak-confirmation" key={item.id} role="group" aria-label="Mik confirmation"><strong>{item.label}</strong><small>{project?.name || 'Global Hub'}</small><pre>{item.details}</pre><div><button className="history-action" onClick={() => void respond(item.id, false)}>Decline</button><button className="history-action" onClick={() => void respond(item.id, true)}>Approve</button></div></div>)}
    {error && <p role="alert" className="mak-error">{error}</p>}
    {tab === 'conversation' && <div className="mak-reasoning"><DarkSelect label="Mik model" compact title="Model for the next Mik request" value={data.model || reasoning.data?.codex.model || ''} options={reasoning.data?.codex.models?.map(item => ({ value: item.model, label: item.label })) || [{ value: '', label: 'Model · loading…' }]} disabled={sending || !!pending || !!data.active || data.selected === 'legacy' || !reasoning.data?.codex.models?.length} onChange={value => void changeModel(value)} /><ReasoningSelect label="Mik reasoning" compact value={data.effort || settings.coordinatorEffort || 'medium'} efforts={reasoning.data?.codex.efforts} disabled={sending || !!pending || !!data.active || data.selected === 'legacy'} onChange={value => void changeEffort(value)} />{reasoning.error && <span title={reasoning.error}>Unavailable</span>}</div>}
    {tab === 'conversation' && data.history.some(item => item.status === 'failed') && <button className="history-action mak-retry" disabled={sending || !!data.active || data.selected === 'legacy'} onClick={() => void changeConversation('retry')}>Retry connection</button>}
    {tab === 'conversation' && <form className="mak-composer" onSubmit={event => { event.preventDefault(); if (!pending) void submit() }}><textarea aria-label="Message Mik" placeholder={data.selected === 'legacy' ? 'Previous History is view-only · start a new conversation' : 'Ask Mik…'} disabled={data.selected === 'legacy'} value={text} maxLength={30000} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!pending) void submit() } }} />{pending ? <button type="button" className="desk-icon" title="Stop Mik request · worker chats continue" aria-label="Stop Mik request" disabled={stopping} onClick={() => void stop()}><Icon name="stop" size={18} /></button> : <button className="desk-icon" title="Send to Mik" aria-label="Send to Mik" disabled={sending || !text.trim() || data.selected === 'legacy'}><Icon name="send" size={18} /></button>}</form>}
  </section>
}
