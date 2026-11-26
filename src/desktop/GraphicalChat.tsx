import { insertSkillAtCursor } from './insertSkillMention'
import { requestTitle } from './requestPresentation'
import ConversationResults from './ConversationResults'
import useSendReceipt from './useSendReceipt'
import useStableChatCallback from './useStableChatCallback'
import { createGraphicalReader } from './graphicalSync'
import useChatDraft from './useChatDraft'
import GraphicalDraftInput, { DraftPasteActionLabel } from './GraphicalDraftInput'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onServiceEvent, sendEvent, uploadImage, selectChat } from './client'
import ChatFilePicker from './ChatFilePicker'
import type { ChatSession } from './types'
import { Icon } from './Icons'
import { SharedBrowserButton } from './SharedBrowserPanel'
import DarkSelect from './DarkSelect'
import CodexPermissionsSelect from './CodexPermissionsSelect'
import GraphicalTimeline from './GraphicalTimeline'
import GraphicalHistorySearch from './GraphicalHistorySearch'
import ChatMarkdown from './ChatMarkdown'
import { GraphicalImage, GraphicalFile } from './GraphicalAssets'
import useGraphicalReading from './useGraphicalReading'
import { GraphicalUsage, GraphicalAccountLimits, GraphicalQueue } from './GraphicalAdvanced'
import type { AdvancedState } from './GraphicalAdvanced'
import type { GraphicalItem, GraphicalTurn } from './GraphicalTimeline'
import { ChatOperationControls } from './GraphicalOperations'
import GraphicalModelSelect from './GraphicalModelSelect'
import GraphicalToolForm from './GraphicalToolForm'
import GraphicalComposerMenu, { ComposerContextChips } from './GraphicalComposerContext'
import type { ComposerContext } from '../../desktop/service/graphical-composer.mjs'
import type { GraphicalModel as Model } from './GraphicalModelSelect'
import { GraphicalComposer, GraphicalChatDetails, GraphicalDraftAttachments, GraphicalSendButton, GraphicalHistoryNav } from './GraphicalChatChrome'
import { useGraphicalChrome } from './useGraphicalChrome'
import './graphical-chat.css'
import SubagentsPanel from './SubagentsPanel'
import type { Subagent } from './SubagentsPanel'

type Item = GraphicalItem
type Question = { id: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description?: string }[] }
type Request = { id: string; method: string; supported: boolean; responded?: boolean; params: { command?: string; reason?: string; questions?: Question[]; mode?: string; url?: string; message?: string; requestedSchema?: unknown; availableDecisions?: string[] } }
type Snapshot = { subagents?: Subagent[]; messageActionBusy?: boolean; messageOrigin?: { sessionId: string | null; kind: string; unavailable?: boolean } | null; sharedBrowser?: boolean; composerContext?: ComposerContext[]; advanced?: AdvancedState; turns?: GraphicalTurn[]; activeTurnId?: string | null; submitting?: boolean; runtimeId: string; revision: number; items: Item[]; requests: Request[]; effective: { sandbox: string; reviewer: string; approvalPolicy: string; model: string } | null; working: boolean; connected: boolean; error: string; errorId: number; canInterrupt: boolean; requiresSandbox?: boolean; permissionsUpdating?: boolean; permissionsUncertain?: boolean; executionIssue?: { status: string; message?: string; note?: string; recordedAt?: string; lockedRuntime?: boolean } | null; sandbox: { status: string; settingUp: boolean; restartRequired?: boolean; error?: string }; truncated: boolean; draft: string; attachments: string[]; attachmentDetails?: {path: string; name: string; kind: string}[]; uncertain?: boolean; model?: string; effort?: string }


function PendingRequest({ request, answer }: { request: Request; answer: (decision: string, answers?: Record<string, string> | object) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [copiedCommand, setCopiedCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const respond = async (decision: string, content?: object) => {
    setBusy(true); setError('')
    try { await answer(decision, content ?? answers) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const approval = /\/(commandExecution|fileChange)\/requestApproval$/.test(request.method)
  const missingAnswer = (request.params.questions || []).some(question => !answers[question.id]?.trim())
  return <section className="graphical-request" aria-label="Agent request" onKeyDown={event => { if (request.method === 'item/tool/requestUserInput' && event.key === 'Enter' && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement && !busy && !request.responded && !missingAnswer) { event.preventDefault(); void respond('answer') } }}>
    <strong>{requestTitle(request.method, request.supported)}</strong>
    {(request.params.reason || request.params.message) && <p>{request.params.reason || request.params.message}</p>}
    {request.params.command && <div className="graphical-request-command"><header><span>Command</span><button type="button" aria-label="Copy requested command" title={copiedCommand === request.params.command ? 'Copied' : 'Copy command'} onClick={() => void navigator.clipboard.writeText(request.params.command!).then(() => { setCopiedCommand(request.params.command!); setError('') }, () => setError('Copy unavailable. Select the command to copy it.'))}><Icon name="files" size={14} /></button></header><pre tabIndex={0}><code>{request.params.command}</code></pre></div>}
    <details><summary>Request details</summary><code className="graphical-request-method">{request.method}</code><pre>{JSON.stringify(request.params, null, 2)}</pre></details>
    {(request.params.questions || []).map(question => <label key={question.id}>{question.question}{question.options?.length && !question.isSecret ? <><DarkSelect label={question.question} value={answers[question.id] || ''} disabled={busy || request.responded} options={[{ value: '', label: 'Choose an answer' }, ...question.options.map(option => ({ value: option.label, label: option.label + (option.description ? ` · ${option.description}` : '') }))]} onChange={value => setAnswers(current => ({ ...current, [question.id]: value }))} />{question.isOther && <input disabled={busy || request.responded} aria-label={`${question.question} · custom answer`} placeholder="Or enter your answer" value={question.options.some(option => option.label === answers[question.id]) ? '' : answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />}</> : <input disabled={busy || request.responded} type={question.isSecret ? 'password' : 'text'} autoComplete="off" aria-label={question.question} value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />}</label>)}
    {request.supported && !request.responded && request.method === 'mcpServer/elicitation/request' && request.params.mode !== 'url' && <GraphicalToolForm schema={request.params.requestedSchema} disabled={busy} answer={content => respond('accept', content)} />}
    {request.params.url && /^https?:\/\//i.test(request.params.url) && <a href={request.params.url} target="_blank" rel="noreferrer">Open tool sign-in page</a>}
    <div className="graphical-actions">
      {request.responded ? <span>Response sent · waiting for Codex</span> : approval ? (request.params.availableDecisions || ['accept', 'acceptForSession', 'decline', 'cancel']).filter(value => typeof value === 'string' && ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)).map(value => <button key={value} data-decision={value} className={value === 'accept' ? 'request-accept' : undefined} disabled={busy} onClick={() => void respond(value)}>{({ accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' } as Record<string, string>)[value]}</button>) : request.method === 'item/tool/requestUserInput' ? <button className="request-accept" disabled={busy || missingAnswer} onClick={() => void respond('answer')}>Send answers</button> : <>{request.supported && <>{!(request.method === 'mcpServer/elicitation/request' && request.params.mode !== 'url') && <button className="request-accept" disabled={busy} onClick={() => void respond('accept')}>Allow once</button>}<button disabled={busy} onClick={() => void respond('decline')}>Decline</button></>}{request.method !== 'item/permissions/requestApproval' && <button disabled={busy} onClick={() => void respond('cancel')}>Cancel request</button>}</>}
    </div>{error && <p role="alert">{error}</p>}
  </section>
}

export default function GraphicalChat({ session, onDraftChange, serviceConnected = true }: { session: ChatSession; onDraftChange: (busy: boolean) => void; serviceConnected?: boolean }) {
  const [data, setData] = useState<Snapshot | null>(null)
  const [readSnapshot] = useState(() => createGraphicalReader<Snapshot>(session.id))
  const { draft, empty: draftEmpty, readText, setText, retainDraft, hasPending } = useChatDraft(session.id, data !== null, data?.runtimeId)
  const delivery = useSendReceipt(session.id, data?.items || [], data?.runtimeId)
  const text = draftEmpty ? '' : readText()
  const [error, setError] = useState('')
  const [transportError, setTransportError] = useState(''), [modelError, setModelError] = useState(''), [modelAttempt, setModelAttempt] = useState(0)
  const [uploading, setUploading] = useState(false), [deliveryNotice, setDeliveryNotice] = useState(''), [checkingDelivery, setCheckingDelivery] = useState(false)
  const [pasteNotice, setPasteNotice] = useState<{ path: string; clip: string; before: string; start: number; end: number; revision: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [models, setModels] = useState<Model[] | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [dismissedError, setDismissedError] = useState('')
  const [setupPrompt, setSetupPrompt] = useState(false)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [permissionChanging, setPermissionChanging] = useState(false)
  const subscribedRuntime = useRef('')
  const viewActive = useRef(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const editing = useRef(false), locked = useRef(false), draftRevision = useRef(0), lastSnapshot = useRef({ runtimeId: '', revision: -1 }), refreshIssued = useRef(0), refreshApplied = useRef(0)
  const view = useRef<HTMLDivElement>(null)
  const getView = useCallback(() => view.current, [])
  const reading = useGraphicalReading(session.id, data?.runtimeId, data?.items || [], data?.turns || [], getView, { hasOlder: data?.truncated, connected: data?.connected })
  const refresh = useCallback(async () => {
    const issued = ++refreshIssued.current
    const result = await readSnapshot()
    if (!viewActive.current) return
    if (issued < refreshApplied.current) return
    refreshApplied.current = issued
    setTransportError('')
    if (result.runtimeId === lastSnapshot.current.runtimeId && result.revision < lastSnapshot.current.revision) return
    // Register this view only after loading its structured messages. The shared
    // read acknowledgement still checks focus, selection and completion version.
    if (subscribedRuntime.current !== result.runtimeId && sendEvent({ type: 'subscribe', id: session.id })) subscribedRuntime.current = result.runtimeId
    if (result.runtimeId !== lastSnapshot.current.runtimeId || result.revision !== lastSnapshot.current.revision) { lastSnapshot.current = { runtimeId: result.runtimeId, revision: result.revision }; setData(result) }
    if (!editing.current && !hasPending() && result.draft) setText(result.draft)
  }, [session.id, readSnapshot, setText, hasPending])
  useEffect(() => {
    viewActive.current = true
    let closed = false, timer = 0, eventTimer = 0
    const poll = async () => { try { if (!closed) await refresh() } catch (cause) { if (!closed) setTransportError(cause instanceof Error ? cause.message : String(cause)) } finally { if (!closed) timer = window.setTimeout(poll, 1200) } }
    void poll()
    const off = onServiceEvent(event => { if (event.type === 'connected') { subscribedRuntime.current = ''; void refresh().catch(() => {}) } if (event.type === 'graphical' && event.id === session.id && !closed && !eventTimer) eventTimer = window.setTimeout(() => { eventTimer = 0; void refresh().catch(() => {}) }, 60) })
    return () => { viewActive.current = false; closed = true; clearTimeout(timer); clearTimeout(eventTimer); off() }
  }, [refresh, session.id])
  useEffect(() => {
    if (!data?.connected) return
    let closed = false
    void api<{ models: Model[] }>(`/sessions/${session.id}/chat`, { action: 'models' }).then(result => { if (!closed) { setModels(result.models); setModelError(result.models.length ? '' : 'No models are available for this account.') } }).catch(cause => { if (!closed) setModelError(cause.message) })
    return () => { closed = true }
  }, [session.id, data?.runtimeId, data?.connected, modelAttempt])
  useEffect(() => {
    onDraftChange(uploading || !draftEmpty || !!data?.composerContext?.length || !!data?.attachments.length || !!data?.advanced?.queue.length || !!data?.advanced?.configuring)
  }, [draftEmpty, session.id, data?.runtimeId, data?.attachments.length, data?.advanced?.queue.length, data?.advanced?.configuring, data?.composerContext?.length, onDraftChange, uploading])
  const act = async (body: object) => { await api(`/sessions/${session.id}/chat`, body); await refresh() }
  const advancedAct = async (body: object) => { try { await act(body) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause } }
  const send = async () => {
    const text = readText()
    if (!text.trim() && !data?.attachments.length && !data?.composerContext?.length || data?.requests.length) return
    if (permissionChanging || data?.permissionsUpdating || data?.permissionsUncertain || locked.current || busy || uploading || !data?.connected || data?.uncertain || data.advanced?.configuring || data.advanced?.steering) return
    locked.current = true; setBusy(true); setError('')
    const releaseDraft = retainDraft()
    const receipt = !data.working ? delivery.begin(text) : null
    let accepted = false
    const sentRevision = draftRevision.current
    if (receipt) { editing.current = true; setText('') }
    const sentVersion = draft.version()
    try {
      const action = data.working ? 'steer' : 'send'
      await api(`/sessions/${session.id}/chat`, { action, text, ...(action === 'steer' ? { expectedTurnId: data.activeTurnId } : {}) });
      accepted = true
      editing.current = true; if (!receipt && draftRevision.current === sentRevision && draft.version() === sentVersion) setText('')
      await refresh()
    }
    catch (cause) {
      if (receipt && !accepted) {
        const restore = viewActive.current && draftRevision.current === sentRevision && draft.version() === sentVersion && !readText()
        if (restore) setText(text)
        delivery.failed(receipt, !restore)
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally { releaseDraft(); locked.current = false; setBusy(false) }
  }
  const attach = async (paths: string[]) => { if (paths.length) { await api(`/sessions/${session.id}/attach`, { paths }); await refresh() } }
  const updateText = (value: string) => { draftRevision.current++; editing.current = true; setText(value) }
  const pasteText = async (clip: string) => {
    const text = readText()
    if (clip.length > 256000) { setError('Paste text must be smaller than 256,000 characters. Attach a file instead.'); return }
    const before = text, start = composer.current?.selectionStart ?? text.length, end = composer.current?.selectionEnd ?? text.length, revision = draftRevision.current
    setUploading(true); setError('')
    try {
      const result = await api<{ path: string }>(`/sessions/${session.id}/chat`, { action: 'paste-text', text: clip })
      if (revision === draftRevision.current) { updateText(before.slice(0, start) + before.slice(end)); setPasteNotice({ path: result.path, clip, before, start, end, revision: draftRevision.current }) }
      else setPasteNotice({ path: result.path, clip, before, start, end, revision: -1 })
      await refresh()
    } catch (cause) { setError((cause instanceof Error ? cause.message : String(cause)) + ' Pasted text was not inserted; try again.') }
    finally { setUploading(false) }
  }
  const undoPaste = async () => {
    const text = readText()
    if (!pasteNotice || !data) return
    const revision = draftRevision.current
    const notice = pasteNotice, unchanged = notice.revision === draftRevision.current
    const start = unchanged ? notice.start : composer.current?.selectionStart ?? text.length, end = unchanged ? notice.end : composer.current?.selectionEnd ?? text.length
    const before = unchanged ? notice.before : text
    const inline = before.length - (end - start) + notice.clip.length <= 64000
    const restored = inline ? before.slice(0, start) + notice.clip + before.slice(end) : unchanged ? notice.before : text
    setUploading(true)
    try { await act({ action: 'composer-detach', path: notice.path }); if (draftRevision.current === revision) updateText(restored); else setError('Paste attachment removed. Your newer draft was kept; pasted text was not inserted.'); setPasteNotice(null); composer.current?.focus() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setUploading(false) }
  }
  const quoteMessage = async (item: Item, text: string) => {
    await act({ action: 'composer-add', context: { type: 'quote', itemId: item.id, text } })
    composer.current?.focus()
  }
  const quoteSource = (id: string) => {
    if (reading.items.some(item => item.id === id)) { reading.focus(id); return }
    const row = Array.from(view.current?.querySelectorAll<HTMLElement>('[data-chat-item]') || []).find(element => element.dataset.chatItem === id)
    if (!row) { setError('The source message is not loaded. Load earlier messages to view it.'); return }
    row.scrollIntoView({ block: 'center' }); row.tabIndex = -1; row.focus({ preventScroll: true })
  }
  useEffect(() => {
    const drop = (event: Event) => {
      const detail = (event as CustomEvent<{ phase: string; paths: string[]; x?: number; y?: number }>).detail
      if (!detail || detail.phase !== 'drop' || !Number.isFinite(detail.x) || !Number.isFinite(detail.y)) return
      const target = document.elementFromPoint(detail.x!, detail.y!)
      if (target && view.current?.closest('.graphical-chat')?.contains(target)) void attach(detail.paths).catch(cause => setError(cause.message))
    }
    window.addEventListener('mrmak-file-drop', drop)
    return () => window.removeEventListener('mrmak-file-drop', drop)
  })
  const find = useCallback(() => setSearchOpen(true), [setSearchOpen])
  useGraphicalChrome({ view, find })
  const openLocal = useStableChatCallback((href: string, destination?: 'ide') => { void api(`/sessions/${session.id}/chat`, { action: 'open-file', href, destination }).catch(cause => setError(cause.message)) })
  const renderMarkdown = useCallback((value: string, streaming = false, itemId?: string, skillContext?: ComposerContext[], origin: 'input' | 'output' = 'output') => <ChatMarkdown origin={origin} skillContext={skillContext} itemId={itemId} sessionId={session.id} text={value} streaming={streaming} query={query} openLocal={openLocal} />, [session.id, query, openLocal])
  const permissionBusy = permissionChanging || !!data?.permissionsUpdating
  const settingsBlocked = !!data?.messageActionBusy || permissionBusy || !!data?.permissionsUncertain || !!data?.advanced?.operationBusy
  const waiting = !!data?.requests.length
  const changeModel = async (value: string, effort?: string) => {
    setConfiguring(true); setError('')
    try { await act({ action: 'configure', model: value, effort }) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setConfiguring(false) }
  }
  const needsSandbox = data?.requiresSandbox !== false && !['bypass', 'full-access'].includes(session.codexPermissions || '') && (data?.sandbox.restartRequired || ['notConfigured', 'updateRequired'].includes(data?.sandbox.status || ''))
  const operationBlocked = !!data?.composerContext?.length || !data?.connected || busy || configuring || permissionBusy || !!data?.permissionsUncertain || !!data?.working || waiting || !!data?.advanced?.configuring || !!data?.uncertain || !!data?.advanced?.queue.length || !!text.trim() || !!data?.attachments.length || !!data?.sandbox.settingUp || !!needsSandbox
  const operationNotice = data?.advanced?.operation && <p className="graphical-operation-status" role="status">{data.advanced.operation.message}{data.advanced.operationBusy && <button type="button" disabled={!data.connected || busy} onClick={() => { void advancedAct({ action: 'operation-check' }).catch(() => {}) }}>Check operation</button>}{!data.advanced.operationBusy && <button type="button" onClick={() => { void advancedAct({ action: 'operation-dismiss' }).catch(() => {}) }}>Dismiss</button>}</p>
  const stopMode = !!data?.working && !text.trim() && !data?.attachments.length && !data?.composerContext?.length
  const sendBlocked = settingsBlocked || busy || uploading || configuring || !data?.connected || waiting || !!data?.uncertain || !!needsSandbox || !!data?.sandbox.settingUp || !!data?.advanced?.steering || !!data?.advanced?.configuring || !!data?.working && (!data.activeTurnId || !data.advanced?.supportsSteer) || !data?.working && !!data?.advanced?.queue.length || !text.trim() && !data?.attachments.length && !data?.composerContext?.length
  const attachmentBlocked = !serviceConnected || uploading || busy || !data?.connected || !!data.uncertain
  return <section className="graphical-chat" aria-label="Codex graphical chat" data-chat-revision={data?.revision}>
    <ChatFilePicker directory={session.cwd} disabled={attachmentBlocked} attach={attach} focus={() => composer.current?.focus()} />

    {(needsSandbox || data?.sandbox.settingUp || data?.sandbox.error) && <section className="graphical-sandbox" aria-label="Windows sandbox setup"><span>{data?.sandbox.settingUp ? 'Setting up the Windows sandbox… Check the Windows consent prompt.' : data?.sandbox.error || (data?.sandbox.restartRequired ? 'Sandbox setup completed. Reconnect this chat to apply it.' : 'Prepare the Windows sandbox before sending. Windows may ask for administrator consent.')}</span>{!data?.sandbox.settingUp && <button disabled={busy || data?.working || waiting} onClick={() => { if (data?.sandbox.restartRequired) void act({ action: 'reconnect' }).catch(cause => setError(cause.message)); else setSetupPrompt(true) }}>{data?.sandbox.restartRequired ? 'Reconnect chat' : 'Set up sandbox'}</button>}{setupPrompt && <div><p>This prepares Codex’s Windows sandbox for this account. Windows may display administrator consent. Approve for me does not approve that prompt.</p><button onClick={() => { setSetupPrompt(false); void act({ action: 'sandbox-setup' }).catch(cause => setError(cause.message)) }}>Continue to Windows setup</button><button onClick={() => setSetupPrompt(false)}>Cancel</button></div>}</section>}
    <div className="graphical-messages" ref={view} onScroll={reading.onScroll}>
      {!data && session.status === 'running' && serviceConnected && <p>Connecting to Codex…</p>}{data && !data.items.length && <p className="desk-muted">What would you like to work on?</p>}
      <GraphicalHistoryNav visible={!!data && !!reading.items.length && (data.truncated || reading.historyLoaded)} loading={reading.loading} hasOlder={reading.hasOlder} connected={!!data?.connected} historical={reading.historical} older={reading.older} />
      {reading.error && <p role="alert">{reading.error}</p>}
      <div className="graphical-timeline">{data?.messageOrigin && <p className="graphical-branch-origin"><span className="branch-caption"><Icon name="fork" size={15} /><span>{data.messageOrigin.kind === 'retry' ? 'Retried in a new chat' : 'Forked conversation'}<small>Files unchanged</small></span></span><button type="button" disabled={!data.messageOrigin.sessionId || data.messageOrigin.unavailable} title={data.messageOrigin.unavailable ? 'The original conversation was not included in this transfer.' : undefined} onClick={() => { const parent = data.messageOrigin?.sessionId; if (!parent) return; void api(`/sessions/${parent}/resume`, {}).then(() => selectChat(parent)).catch(cause => setError(cause.message)) }}><Icon name="back" size={14} />{data.messageOrigin.unavailable ? 'Original not included' : 'Original conversation'}</button></p>}{data && <GraphicalTimeline getView={getView} messageActionsDisabled={settingsBlocked || busy || configuring || !data.connected || data.working || waiting || !!data.uncertain || !!data.advanced?.operationBusy || !!data.advanced?.queue.length} sessionId={session.id} historical={reading.historical} items={reading.items} turns={reading.turns} activeTurnId={data.activeTurnId} working={data.working} waiting={waiting} connected={data.connected} uncertain={data.uncertain} query={query} markdown={renderMarkdown} image={item => <GraphicalImage id={session.id} itemId={item.id} version={item.path} />} attachment={(item, index) => item.attachments?.[index].kind === 'image' ? <GraphicalImage id={session.id} itemId={item.id} attachment={index} label={item.attachments[index].name} /> : <GraphicalFile id={session.id} itemId={item.id} index={index} name={item.attachments?.[index].name || 'file'} />} file={(item, index) => <GraphicalFile id={session.id} itemId={item.id} index={index} kind="change" name={item.changes?.[index].path || 'file'} />} output={async itemId => (await api<{ text: string }>(`/sessions/${session.id}/chatoutput?item=${encodeURIComponent(itemId)}`)).text} quote={quoteMessage} quoteSource={quoteSource} />}{delivery.receipt}</div>
      {data?.requests.map(request => <PendingRequest key={request.id} request={request} answer={async (decision, answers) => { await act({ action: 'answer', id: request.id, decision, answers }) }} />)}
    </div>
    {(!reading.following || reading.historical) && <div className="graphical-latest-slot"><button type="button" className="graphical-latest" aria-label="Back to latest" title="Back to latest" onClick={reading.latest}><Icon name="down" size={17} /></button></div>}
    {data?.advanced?.operation?.status !== 'completed' && operationNotice}
    <div className="graphical-support"><GraphicalQueue data={data?.advanced} act={act} />
    {transportError && session.status === 'running' && serviceConnected && <p className="graphical-transport-error" role="status">{transportError} · Reconnecting…</p>}
    {modelError && session.status === 'running' && <p className="graphical-model-error" role="status">{modelError} <button type="button" onClick={() => { setModelError(''); setModelAttempt(value => value + 1) }}>Retry models</button></p>}
    {data?.uncertain && <p className="graphical-delivery" role="status">Delivery is uncertain. Your message has not been resent. <button type="button" disabled={checkingDelivery || !data.connected} onClick={() => { setCheckingDelivery(true); void api<{ message: string }>(`/sessions/${session.id}/chat`, { action: 'reconcile' }).then(result => { setDeliveryNotice(result.message); return refresh() }).catch(cause => setError(cause.message)).finally(() => setCheckingDelivery(false)) }}>Check delivery</button></p>}
    {deliveryNotice && <p className="graphical-delivery" role="status">{deliveryNotice}<button type="button" onClick={() => setDeliveryNotice('')}>Dismiss</button></p>}
    {data?.executionIssue?.status === 'recorded-failure' && <p className="graphical-execution-issue" role="alert">{data.executionIssue.message}<small>{data.executionIssue.note}</small></p>}
    {(error || session.status === 'running' && data?.error && dismissedError !== `${data.runtimeId}:${data.errorId}`) && <p className="graphical-error" role="alert">{error || data?.error}<button onClick={() => { setError(''); setDismissedError(`${data?.runtimeId}:${data?.errorId}`) }}>Dismiss</button></p>}
    <GraphicalDraftAttachments sessionId={session.id} items={data?.attachmentDetails || (data?.attachments || []).map(path => ({ path, name: path.split(/[\\/]/).pop() || path, kind: /\.(png|jpe?g|gif|webp|bmp)$/i.test(path) ? 'image' : 'file' }))} remove={file => { void act({ action: 'composer-detach', path: file }).catch(cause => setError(cause.message)) }} />
    {pasteNotice && data?.attachments.includes(pasteNotice.path) && <p className="graphical-paste-note" role="status">Pasted text attached · {pasteNotice.clip.length.toLocaleString()} characters<button type="button" disabled={uploading || busy || !!data.uncertain} onClick={() => void undoPaste()}>{<DraftPasteActionLabel draft={draft} extra={pasteNotice.clip.length} />}</button><button type="button" aria-label="Dismiss paste notice" onClick={() => setPasteNotice(null)}>×</button></p>}{uploading && <p className="graphical-upload" role="status">Uploading attachments…</p>}
    {searchOpen && <GraphicalHistorySearch key={data?.runtimeId || session.id} sessionId={session.id} runtimeId={data?.runtimeId} query={query} change={setQuery} reveal={reading.reveal} close={() => { setSearchOpen(false); setQuery(''); composer.current?.focus() }} />}
    <SubagentsPanel sessionId={session.id} runtimeId={data?.runtimeId} agents={data?.subagents || []} connected={!!data?.connected} /></div><GraphicalComposer onSubmit={event => { event.preventDefault(); if (!needsSandbox && !data?.sandbox.settingUp && !waiting) void send() }}><ComposerContextChips sessionId={session.id} items={data?.composerContext || []} source={quoteSource} remove={id => { void act({ action: "composer-remove", id }).catch(cause => setError(cause.message)) }} /><div className="graphical-composer-input"><GraphicalDraftInput completion={{sessionId:session.id,runtimeId:data?.runtimeId,provider:'codex',disabled:uploading || busy || !data?.connected || !!data?.uncertain}} onSkillInsert={updateText} draft={draft} inputRef={composer} aria-label="Message Codex" placeholder={data?.advanced?.operationBusy ? 'Draft your next message…' : waiting ? 'Respond to the request above…' : data?.working ? 'Guide the active turn…' : 'Ask Codex to do anything…'} maxLength={64000} onChange={() => { draftRevision.current++; editing.current = true }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!waiting && !needsSandbox && !data?.sandbox.settingUp) void send() } }} onPaste={event => { const pasted = event.clipboardData.getData("text/plain"); if (!event.clipboardData.files.length && (pasted.length > 6000 || pasted.split("\n").length > 120)) { event.preventDefault(); void pasteText(pasted); return } const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); setUploading(true); void Promise.all(images.slice(0, 12).map(file => uploadImage(file, session.id))).then(files => attach(files.map(file => file.path))).catch(cause => setError(cause.message)).finally(() => setUploading(false)) } }} /></div>
    {data?.working && text.trim() && <p className="graphical-draft-hint">Enter to guide now · Shift+Enter for a new line</p>}
    <div className="graphical-controls"><GraphicalComposerMenu key={data?.runtimeId || session.id} sessionId={session.id} disabled={attachmentBlocked} chooseSkill={name => insertSkillAtCursor(readText(), name, composer.current, updateText)} focus={() => composer.current?.focus()} /><GraphicalModelSelect provider="codex" models={models} model={data?.model} effort={data?.effort} disabled={settingsBlocked || configuring || busy || !!data?.advanced?.queue.length || !!data?.advanced?.configuring || !!data?.working || waiting || !!data?.sandbox.settingUp || !models?.length} onChange={changeModel} workMode={{ value: data?.advanced?.mode || data?.advanced?.modeEffective || "default", choices: (data?.advanced?.modes || []).map(item => ({ value: item.mode, label: item.label })), disabled: !!data?.advanced?.configuring || !!data?.advanced?.queue.length, change: mode => advancedAct({ action: "mode", mode }) }} usage={<GraphicalAccountLimits data={data?.advanced} refresh={() => act({ action: 'usage' })} />} /><CodexPermissionsSelect compact icon="" disabled={permissionBusy || !!data?.advanced?.operationBusy || !!data?.working || waiting || busy || uploading || configuring || !!data?.advanced?.queue.length || !!text.trim() || !!data?.attachments.length || !!data?.composerContext?.length || !!data?.sandbox.settingUp} value={session.codexPermissions || 'ask'} onChange={value => { setPermissionChanging(true); setError(''); void api(`/sessions/${session.id}/permissions`, { codexPermissions: value }).then(() => refresh()).catch(cause => setError(cause.message)).finally(() => setPermissionChanging(false)) }} />{permissionBusy ? <small role="status">Applying permissions…</small> : data?.permissionsUncertain ? <small role="alert">Permissions unconfirmed · select again to check</small> : session.codexPermissionsPending && <small>Permissions pending</small>}<div className="graphical-utilities"><details className="graphical-details"><summary aria-label="Chat details" title="Chat details"><Icon name="more" size={17} /></summary><GraphicalChatDetails conversation={<button type="button" className="desk-icon" aria-label="Find in conversation" title="Find in this chat" aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); setQuery('') }}><Icon name="search" size={16} /><span>Find in conversation</span></button>} sessionInfo={<section className="graphical-menu-section" aria-label="Session"><h3>Session</h3><dl className="graphical-info-rows"><div><dt>Account</dt><dd>{session.accountProfileLabel || 'Choose an account'}</dd></div></dl></section>} connected={!!data?.connected} actions={<section className="graphical-menu-section graphical-menu-actions" aria-label="Actions"><h3>Actions</h3><SharedBrowserButton session={session} available={data?.sharedBrowser === true} /><ChatOperationControls kind="review" disabled={operationBlocked} act={advancedAct} /><ConversationResults sessionId={session.id} labelled /></section>}><GraphicalUsage data={data?.advanced} compact={<><ChatOperationControls kind="compact" disabled={operationBlocked} act={advancedAct} />{data?.advanced?.operation?.status === 'completed' && data.advanced.operation.kind === 'compact' && operationNotice}</>} />{data?.advanced?.operation?.status === 'completed' && data.advanced.operation.kind === 'review' && operationNotice}{data?.executionIssue?.message && <p className="graphical-info-warning" role="status">{data.executionIssue.message}</p>}<section className="graphical-menu-section" aria-label="Operational permissions"><h3>Permissions</h3><dl className="graphical-info-rows">{data?.effective && <><div><dt>File access</dt><dd className={data.effective.sandbox === 'dangerFullAccess' ? 'info-warning' : 'info-accent'}>{data.effective.sandbox === 'workspaceWrite' ? 'Project files' : data.effective.sandbox === 'readOnly' ? 'Read only' : data.effective.sandbox === 'dangerFullAccess' ? 'Full access' : data.effective.sandbox}</dd></div><div><dt>Approvals</dt><dd className="info-accent">{data.effective.reviewer === 'auto_review' ? 'Automatic review' : data.effective.approvalPolicy === 'never' ? 'Bypassed' : 'User review'}</dd></div></>}</dl></section></GraphicalChatDetails></details></div><GraphicalSendButton interruptAvailable={!!data?.working} interruptDisabled={stopping || !data?.connected || !data?.canInterrupt} stopping={stopMode} disabled={stopMode ? stopping || !data?.connected || !data?.canInterrupt : sendBlocked} title={stopMode ? 'Stop response' : data?.working ? 'Send guidance now' : 'Send message'} onStop={() => { if (stopping) return; setStopping(true); void act({ action: 'interrupt' }).catch(cause => setError(cause.message)).finally(() => setStopping(false)) }} /></div></GraphicalComposer>

  </section>
}
