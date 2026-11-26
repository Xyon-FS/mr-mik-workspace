import { GraphicalImage, GraphicalFile } from './GraphicalAssets'
import { insertSkillAtCursor } from './insertSkillMention'
import ConversationResults from './ConversationResults'
import useSendReceipt from './useSendReceipt'
import { readClaudePendingAction, writeClaudePendingAction } from './claudePendingAction'
import type { ClaudePendingAction } from './claudePendingAction'
import useStableChatCallback from './useStableChatCallback'
import { createGraphicalReader } from './graphicalSync'
import useChatDraft, { savedChatDraft } from './useChatDraft'
import GraphicalDraftInput from './GraphicalDraftInput'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onServiceEvent, sendEvent, uploadImage } from './client'
import ChatFilePicker from './ChatFilePicker'
import type { ChatSession } from './types'
import GraphicalTimeline from './GraphicalTimeline'
import type { GraphicalItem, GraphicalTurn } from './GraphicalTimeline'
import ChatMarkdown from './ChatMarkdown'
import DarkSelect from './DarkSelect'
import useGraphicalReading from './useGraphicalReading'
import GraphicalHistorySearch from './GraphicalHistorySearch'
import { Icon } from './Icons'
import GraphicalModelSelect from './GraphicalModelSelect'
import GraphicalComposerMenu, { ComposerContextChips } from './GraphicalComposerContext'
import type { ComposerContext } from '../../desktop/service/graphical-composer.mjs'
import type { HistoryWindow } from './useGraphicalReading'
import { GraphicalComposer, GraphicalDraftAttachments, GraphicalSendButton, GraphicalHistoryNav, GraphicalChatDetails } from './GraphicalChatChrome'
import { useGraphicalChrome } from './useGraphicalChrome'
import './graphical-chat.css'
import SubagentsPanel from './SubagentsPanel'
import type { Subagent } from './SubagentsPanel'
import { GraphicalQueue } from './GraphicalAdvanced'
import type { AdvancedState } from './GraphicalAdvanced'
import { SharedBrowserButton } from './SharedBrowserPanel'
import ClaudeReviewTask from './ClaudeReviewTask'
import ProviderUsage, { ProviderAccountLimits } from './ProviderUsage'
import type { NativeUsage, NativeCompaction } from './ProviderUsage'

type Question = { question: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }
type Request = { agentLabel?: string; id: string; kind: string; tool: string; input: { questions?: Question[] } }
type Snapshot = Pick<AdvancedState, 'queue' | 'queuePaused' | 'queueNotice'> & {
  subagents?: Subagent[]; backgroundWorkPending?: boolean; sharedBrowser: boolean; queueBusy: boolean; supportsSteer: boolean; steering: boolean; canSteer: boolean; guidance: { requestId: string; status: string } | null
  usage: NativeUsage; usageRefreshing: boolean; compaction: NativeCompaction; compactionAvailable: boolean
  hasOlder: boolean; composerContext: ComposerContext[]
  messageActionBusy: boolean; runtimeId: string; revision: number; connected: boolean; working: boolean; canInterrupt: boolean; uncertain: boolean
  status: string; error: string; draft: string; model: string; effort?: string; bypass: boolean; configuring: boolean
  models: { value: string; label: string; efforts?: string[] }[]; items: GraphicalItem[]; turns: GraphicalTurn[]; requests: Request[]; activeTurnId: string | null
  efforts: string[]; workMode: 'plan' | 'build'; buildPermissionMode: string; permissionMode: string; permissionModes: { value: string; label: string; description: string }[]
  attachments: string[]; attachmentDetails: { path: string; name: string; kind: string; unavailable?: boolean }[]; submitting: boolean; attachmentUpdating: boolean
  capabilities: { messageActions: boolean; models: boolean; effort?: boolean; permissions?: boolean }
}

function ProviderRequest({ request, disabled, answer }: { request: Request; disabled: boolean; answer: (decision: string, answers?: Record<string, string>) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const questions = request.kind === 'question' && Array.isArray(request.input?.questions) ? request.input.questions : []
  const respond = async (decision: string) => {
    setBusy(true); setError('')
    try { await answer(decision, Object.fromEntries(questions.map(q => [q.question, custom[q.question]?.trim() || (values[q.question] || []).join(', ')]))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="graphical-request" aria-label="Agent request">
    <strong>{request.kind === 'question' ? 'Claude asks' : `Allow ${request.tool}?`}</strong>{request.agentLabel && <small>Subagent: {request.agentLabel}</small>}
    {questions.map((q, index) => <fieldset key={index} disabled={disabled || busy}><legend>{q.question}</legend>
      {q.options?.map(option => <label key={option.label}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${request.id}-${index}`} checked={(values[q.question] || []).includes(option.label)} onChange={event => setValues(current => ({ ...current, [q.question]: q.multiSelect ? event.target.checked ? [...(current[q.question] || []), option.label] : (current[q.question] || []).filter(value => value !== option.label) : [option.label] }))} />{option.label}{option.description && <small>{option.description}</small>}</label>)}
      <input aria-label={`${q.question} · custom answer`} placeholder="Or enter your answer" value={custom[q.question] || ''} onChange={event => setCustom(current => ({ ...current, [q.question]: event.target.value }))} />
    </fieldset>)}
    <details><summary>Request details</summary><pre>{JSON.stringify(request.input, null, 2)}</pre></details>
    <div className="graphical-actions"><button className="request-accept" type="button" disabled={disabled || busy || request.kind === 'question' && (!questions.length || questions.some(q => !custom[q.question]?.trim() && !values[q.question]?.length))} onClick={() => void respond('allow')}>{request.kind === 'question' ? 'Send answers' : 'Allow once'}</button><button type="button" disabled={disabled || busy} onClick={() => void respond('deny')}>Decline</button></div>
    {error && <p role="alert">{error}</p>}
  </section>
}

// Provider shell shares Markdown, timeline, activity cards, timing and reading
// behavior with Codex. Only implemented provider operations are exposed.
export default function ProviderGraphicalChat({ session, onDraftChange, serviceConnected = true }: { session: ChatSession; onDraftChange: (busy: boolean) => void; serviceConnected?: boolean }) {
  const [initialAction] = useState(() => readClaudePendingAction(session.id))
  const queueRequest = useRef<ClaudePendingAction | null>(initialAction)
  const [data, setData] = useState<Snapshot | null>(null)
  const [readSnapshot] = useState(() => createGraphicalReader<Snapshot>(session.id))
  const { draft, empty: draftEmpty, readText, setText, retainDraft, hasPending } = useChatDraft(session.id, data !== null, data?.runtimeId)
  const delivery = useSendReceipt(session.id, data?.items || [], data?.runtimeId)
  const text = draftEmpty ? '' : readText()
  const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [busy, setBusy] = useState(false)
  const [query, setQuery] = useState(''), [searchOpen, setSearchOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const attachmentLock = useRef(false)
  const view = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null)
  const editing = useRef(false), active = useRef(false), locked = useRef(false), revision = useRef(initialAction?.revision || 0), issued = useRef(0), applied = useRef(0)
  const subscribedRuntime = useRef('')
  const getView = useCallback(() => view.current, [])
  const find = useCallback(() => setSearchOpen(true), [setSearchOpen])
  useGraphicalChrome({ view, find })
  const runtimeId = data?.runtimeId
  const reading = useGraphicalReading(session.id, data?.runtimeId, data?.items || [], data?.turns || [], getView, { hasOlder: data?.hasOlder, connected: data?.connected })
  const refresh = useCallback(async () => {
    const request = ++issued.current, result = await readSnapshot()
    if (!active.current || request < applied.current) return
    applied.current = request; setConnectionError('')
    setData(current => current?.runtimeId === result.runtimeId && current.revision > result.revision ? current : result)
    if (subscribedRuntime.current !== result.runtimeId && sendEvent({ type: 'subscribe', id: session.id })) subscribedRuntime.current = result.runtimeId
    if (!editing.current && !hasPending() && !savedChatDraft(session.id)) setText(result.draft || '')
  }, [session.id, readSnapshot, setText, hasPending])
  useEffect(() => {
    active.current = true
    let timer = 0, eventTimer = 0, closed = false
    const poll = async () => { try { await refresh() } catch (cause) { if (!closed) setConnectionError(cause instanceof Error ? cause.message : String(cause)) } finally { if (!closed) timer = window.setTimeout(poll, 1500) } }
    void poll()
    const off = onServiceEvent(event => { if (event.type === 'connected') subscribedRuntime.current = ''; if ((event.type === 'connected' || event.type === 'graphical' && event.id === session.id) && !eventTimer) eventTimer = window.setTimeout(() => { eventTimer = 0; void refresh().catch(() => {}) }, 60) })
    return () => { active.current = false; closed = true; clearTimeout(timer); clearTimeout(eventTimer); off() }
  }, [refresh, session.id])
  useEffect(() => {
    onDraftChange(!draftEmpty || busy || uploading || !!data?.attachments.length || !!data?.composerContext.length)
  }, [draftEmpty, session.id, runtimeId, onDraftChange, busy, uploading, data?.attachments.length, data?.composerContext.length])
  const attach = async (paths: string[]) => {
    if (!paths.length) return
    await api(`/sessions/${session.id}/attach`, { paths, runtimeId: data?.runtimeId }); revision.current++; draft.touch(); await refresh()
  }
  const prepareAttachments = async (operation: () => Promise<void>) => {
    if (attachmentLock.current || locked.current || !data?.connected) return
    attachmentLock.current = true; setUploading(true); setError('')
    try { await operation() } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { attachmentLock.current = false; if (active.current) setUploading(false) }
  }
  useEffect(() => {
    const drop = (event: Event) => {
      const detail = (event as CustomEvent<{ phase: string; paths: string[]; x?: number; y?: number }>).detail
      if (detail?.phase !== 'drop' || !Number.isFinite(detail.x) || !Number.isFinite(detail.y)) return
      const target = document.elementFromPoint(detail.x!, detail.y!)
      if (target && view.current?.closest('.graphical-chat')?.contains(target)) void prepareAttachments(() => attach(detail.paths))
    }
    window.addEventListener('mrmak-file-drop', drop)
    return () => window.removeEventListener('mrmak-file-drop', drop)
  })
  const act = async (body: object) => { await api(`/sessions/${session.id}/chat`, { ...body, runtimeId: data?.runtimeId }); if (['composer-add', 'composer-remove', 'detach-attachment'].includes((body as { action?: string }).action || '')) { revision.current++; draft.touch() } await refresh() }
  const run = async (body: object, localFeedback = false) => {
    if (locked.current) { if (localFeedback) throw new Error('Another operation is in progress. Try again when it finishes.'); return }
    locked.current = true; setBusy(true); setError('')
    try { await act(body) } catch (cause) { if (localFeedback) throw cause; setError(cause instanceof Error ? cause.message : String(cause)) } finally { locked.current = false; setBusy(false) }
  }
  const rememberAction = (value: ClaudePendingAction | null, expectedId?: string) => {
    writeClaudePendingAction(session.id, value, expectedId)
    if (!expectedId || queueRequest.current?.id === expectedId) queueRequest.current = value
  }
  const send = async (forceQueue = false) => {
    const text = readText()
    if (locked.current || attachmentLock.current || skillImageConflict || !text.trim() && !data?.attachments.length && !data?.composerContext.length || !data?.connected || data.uncertain) return
    locked.current = true; setBusy(true); setError(''); const before = revision.current
    const releaseDraft = retainDraft()
    let sentVersion = draft.version()
    let receipt: string | null = null
    let accepted = false
    let actionId: string | undefined
    try {
      const signature = JSON.stringify([text, revision.current])
      const retry = queueRequest.current?.signature === signature && (!forceQueue || queueRequest.current.action === 'enqueue') ? queueRequest.current : null
      const guidance = retry ? retry.action === 'steer' : !forceQueue && data.working && data.canSteer
      const queued = retry ? retry.action === 'enqueue' : forceQueue || !guidance && (data.working || data.queue.length > 0 || data.requests.length > 0)
      const action = guidance ? 'steer' : queued ? 'enqueue' : 'send'
      if (action === 'send') { receipt = delivery.begin(text); editing.current = true; setText('') }
      sentVersion = draft.version()
      if ((guidance || queued) && !retry) rememberAction({ id: crypto.randomUUID(), signature, action: guidance ? 'steer' : 'enqueue', expectedTurnId: guidance ? data.activeTurnId : null, revision: revision.current })
      actionId = queueRequest.current?.id
      const result = await api<{ steered?: boolean; status?: string }>(`/sessions/${session.id}/chat`, { action, expectedTurnId: guidance ? queueRequest.current?.expectedTurnId : undefined, requestId: guidance || queued ? queueRequest.current?.id : undefined, text, runtimeId: data.runtimeId })
      if (guidance && (result.steered === false || result.status === 'uncertain')) {
        if (result.status === 'cancelled') rememberAction(null, actionId)
        throw new Error('Guidance was not confirmed. Inspect delivery; your draft is preserved.')
      }
      accepted = true
      if (actionId) rememberAction(null, actionId)
      if (!receipt && before === revision.current && draft.version() === sentVersion) { editing.current = true; setText('') }
      await refresh()
    }
    catch (cause) {
      // This exact native guard rejects before transmission (including a saved
      // cancelled reservation). A later explicit Enter may start a fresh action.
      // Ambiguous/lost responses keep their identity to prevent duplicate sends.
      if (queueRequest.current?.action === 'steer' && cause instanceof Error && cause.message === 'The active Claude turn changed or is waiting. Refresh before sending guidance. Nothing was resent.') {
        try { rememberAction(null, actionId) }
        catch (cacheError) { setError(cacheError instanceof Error ? cacheError.message : String(cacheError)); return }
      }
      if (receipt && !accepted) {
        const restore = active.current && before === revision.current && draft.version() === sentVersion && !readText()
        if (restore) setText(text)
        delivery.failed(receipt, !restore)
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally { releaseDraft(); locked.current = false; setBusy(false) }
  }
  const openLocal = useStableChatCallback((href: string, destination?: 'ide') => { void run({ action: 'open-file', href, destination }) })
  const quoteSource = (id: string, sent = false) => {
    if (reading.items.some(item => item.id === id)) { reading.focus(id); return }
    if (sent) { setError('The source message is not loaded. Load earlier messages to view it.'); return }
    void api<HistoryWindow & { anchorId: string }>(`/sessions/${session.id}/chat`, { action: 'composer-source', runtimeId, id }).then(page => {
      if (active.current) reading.reveal(page)
    }).catch(cause => setError(cause.message))
  }
  const markdown = useCallback((value: string, streaming = false, itemId?: string, skillContext?: ComposerContext[], origin: 'input' | 'output' = 'output') => <ChatMarkdown origin={origin} skillContext={skillContext} itemId={itemId} sessionId={session.id} text={value} streaming={streaming} query={query} openLocal={openLocal} />, [session.id, query, openLocal])
  const skillImageConflict = !!data?.composerContext.some(item => item.type === 'skill') && !!data?.attachmentDetails.some(item => item.kind === 'image')
  const settingsBlocked = !!data?.backgroundWorkPending || !!data?.queue.length || !!data?.queueBusy || busy || uploading || !data?.connected || data.working || data.uncertain || data.configuring || !!text.trim() || !!data.requests.length || !!data.attachments.length || !!data.composerContext.length
  const attachment = (item: GraphicalItem, index: number) => {
    const value = item.attachments![index]
    return value.kind === 'image' ? <GraphicalImage id={session.id} itemId={item.id} attachment={index} label={value.name} /> : <GraphicalFile id={session.id} itemId={item.id} index={index} name={value.name} />
  }
  const permissionOptions = data?.permissionModes || []
  const buildPermissions = permissionOptions.filter(item => item.value !== 'plan')
  const selectedPermissions = data?.workMode === 'plan' ? data.buildPermissionMode : data?.permissionMode || ''
  const permissionLabel = permissionOptions.find(item => item.value === data?.permissionMode)?.label || data?.permissionMode || 'Native permissions'
  const modelChoices = data?.models.map(item => ({ model: item.value, displayName: item.label, supportedReasoningEfforts: (data.capabilities.effort ? item.efforts || (item.value === data.model ? data.efforts : []) : []).map(reasoningEffort => ({ reasoningEffort })) })) || null
  const changeModel = async (model: string, effort?: string) => { await run({ action: 'configure', ...(model !== data?.model ? { model } : {}), ...(effort && effort !== data?.effort ? { effort } : {}) }) }
  const attachmentBlocked = !serviceConnected || !!data?.steering || !!data?.queueBusy || busy || uploading || !data?.connected || !!data.uncertain || !!data.configuring || !!data.messageActionBusy
  return <section className="graphical-chat" aria-label="Claude graphical chat" data-chat-revision={data?.revision}>
    <ChatFilePicker directory={session.cwd} disabled={attachmentBlocked || !!data?.attachmentUpdating} attach={attach} focus={() => composer.current?.focus()} />
    <div className="graphical-messages" ref={view} onScroll={reading.onScroll}>
      <GraphicalHistoryNav visible={!!reading.items.length && (!!data?.hasOlder || reading.historyLoaded)} loading={reading.loading} hasOlder={reading.hasOlder ?? data?.hasOlder} connected={!!data?.connected} historical={reading.historical} older={reading.older} />
      {reading.error && <p role="alert">{reading.error}</p>}
      {!data && session.status === 'running' && serviceConnected && <p>Connecting to Claude…</p>}{data && !data.items.length && <p className="desk-muted">What would you like to work on?</p>}
      <div className="graphical-timeline">{data && <GraphicalTimeline getView={getView} runtimeId={data.runtimeId} historical={reading.historical} messageActionsDisabled={!!data.queue.length || !!data.queueBusy || busy || uploading || data.working || !data.connected || data.uncertain || data.configuring || data.messageActionBusy} sessionId={session.id} items={reading.items} turns={reading.turns} activeTurnId={data.activeTurnId} working={data.working} waiting={!!data.requests.length} connected={data.connected} uncertain={data.uncertain} query={query} markdown={markdown} responseLabel="Claude response" messageActionsAvailable={data.capabilities.messageActions} image={() => null} attachment={attachment} file={() => null} output={async id => (await api<{ text: string }>(`/sessions/${session.id}/chatoutput?item=${encodeURIComponent(id)}`)).text} quote={async (item, text) => { await run({ action: 'composer-add', context: { type: 'quote', itemId: item.id, text } }, true); composer.current?.focus() }} quoteSource={quoteSource} />}{delivery.receipt}</div>
      {data?.requests.map(request => <ProviderRequest key={`${data.runtimeId}-${request.id}`} request={request} disabled={!data.connected || busy || data.status === 'stopping'} answer={async (decision, answers) => { await act({ action: 'answer', id: request.id, decision, answers }) }} />)}
    </div>
    {(!reading.following || reading.historical) && <div className="graphical-latest-slot"><button type="button" className="graphical-latest" aria-label="Back to latest" title="Back to latest" onClick={reading.latest}><Icon name="down" size={17} /></button></div>}
    {(error || session.status === 'running' && data?.error || session.status === 'running' && serviceConnected && connectionError) && <p className="graphical-error" role="alert">{error || (session.status === 'running' ? data?.error : '') || (session.status === 'running' && serviceConnected ? connectionError : '')}</p>}
    {data && !data.connected && session.status === 'running' && serviceConnected && <p className="graphical-delivery"><button disabled={busy} onClick={() => void run({ action: 'reconnect' })}>Reconnect Claude</button></p>}

    {data?.uncertain && <p className="graphical-delivery" role="status">Delivery is uncertain. Your message has not been resent. Review the recorded messages before continuing.<button disabled={busy || !data.connected} onClick={() => void run({ action: 'acknowledge-uncertain' })}>Acknowledge and continue</button></p>}
    {searchOpen && <GraphicalHistorySearch responseLabel="Claude" sessionId={session.id} runtimeId={runtimeId} query={query} change={setQuery} reveal={reading.reveal} close={() => { setSearchOpen(false); setQuery(''); composer.current?.focus() }} />}
    <div className="graphical-support"><GraphicalQueue data={data || undefined} act={body => run(body, true)} dismissUncertain disabled={busy || !data?.connected || !!data?.queueBusy} />
    <GraphicalDraftAttachments sessionId={session.id} items={data?.attachmentDetails || []} disabled={attachmentBlocked || !!data?.submitting || !!data?.attachmentUpdating} remove={file => { void run({ action: 'detach-attachment', path: file }) }} />
    {skillImageConflict && <p className="graphical-delivery" role="status">Native skills and images cannot be sent together in this Claude runtime. Remove the skill or image, or continue in CLI.</p>}
    {uploading && <p className="graphical-upload" role="status">Uploading attachments…</p>}
    <SubagentsPanel sessionId={session.id} runtimeId={data?.runtimeId} agents={data?.subagents || []} connected={!!data?.connected} /></div><GraphicalComposer onSubmit={event => { event.preventDefault(); void send() }}>
      <ComposerContextChips sessionId={session.id} items={data?.composerContext || []} remove={id => { void run({ action: 'composer-remove', id }) }} source={quoteSource} />
      <div className="graphical-composer-input"><GraphicalDraftInput completion={{sessionId:session.id,runtimeId,provider:'claude',disabled:attachmentBlocked,hasImages:!!data?.attachmentDetails.some(item=>item.kind==='image'),selectedSkills:data?.composerContext.filter(item=>item.type==='skill').map(item=>item.name)}} onSkillInsert={value=>{revision.current++;draft.touch();editing.current=true;setText(value)}} draft={draft} inputRef={composer} aria-label="Message Claude" placeholder={data?.canSteer ? 'Guide the active turn…' : data?.working ? 'Queue your next message…' : data?.permissionMode === 'plan' ? 'Ask Claude to explore and plan…' : 'Ask Claude to do anything…'} maxLength={64000} onPaste={event => {
        const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
        if (!images.length) return
        event.preventDefault()
        void prepareAttachments(async () => {
          if (images.some(file => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024)) throw new Error('Paste PNG, JPEG, GIF or WebP images of 4 MB or less.')
          for (const file of images) { const saved = await uploadImage(file, session.id); await attach([saved.path]) }
        })
      }} onChange={() => { revision.current++; draft.touch(); editing.current = true }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
        {(data?.working || !!data?.queue.length) && <button type="button" disabled={attachmentBlocked || skillImageConflict || !!data?.attachmentUpdating || !text.trim() && !data?.attachments.length && !data?.composerContext.length} onClick={() => void send(true)}>Queue message</button>}
        
      </div>
      {data?.canSteer && <p className="graphical-draft-hint">Enter to guide now · Queue message to send after this turn</p>}
      <div className="graphical-controls">
        <GraphicalComposerMenu key={runtimeId || session.id} sessionId={session.id} runtimeId={runtimeId} disabled={attachmentBlocked} chooseSkill={name => insertSkillAtCursor(readText(), name, composer.current, value => { revision.current++; draft.touch(); editing.current = true; setText(value) })} focus={() => composer.current?.focus()} />
        {data?.capabilities.models && <GraphicalModelSelect provider="claude" models={modelChoices} model={data.model} effort={data.effort} placeholder="Native default model" disabled={settingsBlocked || data.messageActionBusy || !modelChoices?.length} onChange={changeModel} workMode={data.capabilities.permissions ? { value: data.workMode || "build", choices: [{ value: "build", label: "Build" }, { value: "plan", label: "Plan" }], change: workMode => run({ action: "set-permissions", workMode }) } : undefined} usage={<ProviderAccountLimits usage={data?.usage} refreshing={!!data?.usageRefreshing} disabled={busy || !data?.connected || !!data?.working || !!data?.uncertain || !!data?.configuring || !!data?.messageActionBusy || uploading} act={run} />} />}
        {data?.capabilities.permissions ? <DarkSelect variant="permissions" compact icon="" label="Claude permissions" title={data.workMode === 'plan' ? 'Return to Build to change operational permissions.' : buildPermissions.find(item => item.value === selectedPermissions)?.description} value={selectedPermissions} options={[...(!buildPermissions.some(item => item.value === selectedPermissions) ? [{ value: selectedPermissions, label: selectedPermissions || permissionLabel, disabled: true }] : []), ...buildPermissions]} disabled={settingsBlocked || data.messageActionBusy || data.workMode === 'plan'} onChange={permissionMode => void run({ action: 'set-permissions', permissionMode })} /> : <small>{permissionLabel}</small>}
        <div className="graphical-utilities">
          
          <details className="graphical-details"><summary aria-label="Chat details" title="Chat details"><Icon name="more" size={17} /></summary><GraphicalChatDetails conversation={<button type="button" className="desk-icon" aria-label="Find in conversation" title="Find in this chat" aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); setQuery('') }}><Icon name="search" size={16} /><span>Find in conversation</span></button>} sessionInfo={<section className="graphical-menu-section" aria-label="Session"><h3>Session</h3><dl className="graphical-info-rows"><div><dt>Account</dt><dd>{session.accountProfileLabel || 'Claude · current account'}</dd></div></dl></section>} connected={!!data?.connected} actions={<section className="graphical-menu-section graphical-menu-actions" aria-label="Actions"><h3>Actions</h3><SharedBrowserButton session={session} available={!!data?.sharedBrowser && !!data?.connected} /><ClaudeReviewTask disabled={settingsBlocked} prepare={async target => { const result = await api<{ draft: string }>(`/sessions/${session.id}/chat`, { action: 'prepare-review', target, runtimeId }); revision.current++; draft.touch(); setText(result.draft); await refresh(); composer.current?.focus() }} /><ConversationResults sessionId={session.id} labelled /></section>}>
            <ProviderUsage usage={data?.usage} refreshing={!!data?.usageRefreshing} operation={data?.compaction} available={!!data?.compactionAvailable} disabled={busy || !data?.connected || !!data?.working || !!data?.uncertain || !!data?.configuring || !!data?.messageActionBusy || uploading} compactDisabled={settingsBlocked || !!data?.usageRefreshing || !!data?.messageActionBusy} act={run} />
            
            
          <section className="graphical-menu-section" aria-label="Operational permissions"><h3>Permissions</h3><dl className="graphical-info-rows"><div><dt>File access</dt><dd>{data?.permissionMode === 'bypassPermissions' ? 'Full access' : 'Native Claude policy'}</dd></div><div><dt>Approvals</dt><dd>{permissionLabel}</dd></div></dl></section></GraphicalChatDetails></details>
        </div>
        <GraphicalSendButton interruptAvailable={!!data?.working} interruptDisabled={busy || !data?.connected || !data?.canInterrupt} stopping={!!data?.working && (!data.canSteer || !text.trim() && !data.attachments.length && !data.composerContext.length)} title={data?.canSteer ? 'Send guidance now' : undefined} disabled={data?.working && (!data.canSteer || !text.trim() && !data.attachments.length && !data.composerContext.length) ? busy || !data.connected || !data.canInterrupt : !data?.working && !!data?.queue.length || attachmentBlocked || skillImageConflict || !!data?.attachmentUpdating || !text.trim() && !data?.attachments.length && !data?.composerContext.length} onStop={() => { void run({ action: 'interrupt' }) }} />
      </div>
    </GraphicalComposer>
  </section>
}
