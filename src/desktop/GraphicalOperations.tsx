import { useEffect, useRef, useState } from 'react'
import { useChatPreviewPin, focusChatPreviewSource } from './useChatPreviewPin'
import { createPortal } from 'react-dom'
import { api } from './client'
import ChatMarkdown from './ChatMarkdown'
import DarkSelect from './DarkSelect'
import { Icon } from './Icons'
import type { GraphicalItem } from './GraphicalTimeline'

export type ChatOperation = { kind: 'compact' | 'review'; status: string; message: string; turnId: string | null }

export function ChatOperationControls({ kind, disabled, act }: { kind: 'compact' | 'review'; disabled: boolean; act: (value: object) => Promise<void> }) {
  const [form, setForm] = useState<'compact' | 'review' | null>(null)
  const [target, setTarget] = useState('uncommittedChanges'), [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const start = async () => {
    setBusy(true); setError('')
    try { await act({ action: form, ...(form === 'review' ? { target: { type: target, ...(target === 'baseBranch' ? { branch: reference } : target === 'commit' ? { sha: reference } : {}) } } : {}) }); setForm(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="graphical-operation-controls" aria-label="Conversation actions">
    {!form ? <div className="graphical-actions"><button type="button" className={kind === 'review' ? 'graphical-review-action' : 'graphical-compact-action'} disabled={disabled} onClick={() => { setError(''); setForm(kind) }}>{kind === 'review' && <Icon name="fork" size={15} />}<span>{kind === 'compact' ? 'Compact context' : 'Review changes'}</span>{kind === 'review' && <Icon name="arrow" size={13} />}</button></div> : <div>
      <strong>{form === 'compact' ? 'Compact context' : 'Review changes'}</strong>
      <p className="graphical-info-note">{form === 'compact' ? 'Codex summarizes earlier context. Recorded messages and project files are kept. This can use your account allowance.' : 'Starts a native review in this chat using your account. Codex uses its review model if configured; otherwise the selected model. Review does not apply fixes automatically.'}</p>
      {form === 'review' && <><DarkSelect label="Review scope" value={target} options={[{ value: 'uncommittedChanges', label: 'Working changes' }, { value: 'baseBranch', label: 'Against a branch' }, { value: 'commit', label: 'A commit' }]} onChange={value => { setTarget(value); setReference('') }} />{target !== 'uncommittedChanges' && <input aria-label={target === 'commit' ? 'Commit hash' : 'Base branch'} placeholder={target === 'commit' ? 'Commit hash' : 'e.g. main'} value={reference} maxLength={200} onChange={event => setReference(event.target.value)} />}</>}
      {error && <p role="alert">{error}</p>}
      <div className="graphical-actions"><button type="button" disabled={disabled || busy || form === 'review' && target !== 'uncommittedChanges' && !reference.trim()} onClick={() => void start()}>{busy ? 'Starting…' : form === 'compact' ? 'Start compaction' : 'Start review'}</button><button type="button" disabled={busy} onClick={() => setForm(null)}>Cancel</button></div>
    </div>}
  </section>
}

type AgentSnapshot = { name: string; role: string; status: string; items: GraphicalItem[] }
const status = (value: string) => ({ pendingInit: 'Starting', running: 'Working', completed: 'Completed', interrupted: 'Stopped', errored: 'Failed', shutdown: 'Closed', notFound: 'Unavailable', active: 'Working', idle: 'Idle', unknown: 'Status unavailable' } as Record<string, string>)[value] || value

function AgentReader({ sessionId, id, close }: { sessionId: string; id: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), previous = useRef(document.activeElement)
  const [data, setData] = useState<AgentSnapshot | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const element = dialog.current!, focusTarget = previous.current; element.showModal()
    return () => { element.close(); if (focusTarget instanceof HTMLElement) focusChatPreviewSource(focusTarget) }
  }, [])
  useEffect(() => {
    let alive = true
    void api<AgentSnapshot>(`/sessions/${sessionId}/chat`, { action: 'agent-read', threadId: id }).then(value => { if (alive) { setData(value); setError('') } }).catch(cause => { if (alive) setError(cause.message) })
    return () => { alive = false }
  }, [sessionId, id, attempt])
  return createPortal(<dialog ref={dialog} className="graphical-agent-reader" aria-label="Agent conversation" onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close() } }}>
    <header><div><strong>{data?.name || 'Agent'}</strong>{data && <span>{data.role && `${data.role} · `}{status(data.status)}</span>}</div><button type="button" autoFocus onClick={close}>Close agent</button></header>
    <p className="graphical-info-note">Read-only · up to 50 recent items. The agent keeps working in its parent conversation.</p>
    <button type="button" onClick={() => setAttempt(value => value + 1)}>Refresh agent</button>
    {error && <p role="alert">{error}</p>}{!data && !error && <p role="status">Loading agent…</p>}
    <div className="graphical-agent-transcript">{data?.items.map(item => <article key={item.id} className={item.type === 'userMessage' ? 'graphical-message userMessage' : ''}><small>{item.type === 'userMessage' ? 'Instruction' : item.type === 'agentMessage' ? 'Agent' : item.type === 'reasoning' ? 'Thought summary' : 'Activity'}</small><ChatMarkdown sessionId={sessionId} text={item.text || item.details || item.status} query="" openLocal={() => { setError('Open project files from the parent conversation.') }} /></article>)}{data && !data.items.length && <p>No recorded activity is available yet.</p>}</div>
  </dialog>, document.body)
}

export function AgentActivity({ sessionId, item }: { sessionId: string; item: GraphicalItem }) {
  const [selected, setSelected] = useState<string | null>(null)
  const source = useRef<HTMLElement>(null)
  useChatPreviewPin(selected != null, source)
  return <section ref={source} className="graphical-agents" aria-label="Agent activity"><strong>{({ spawnAgent: 'Started agent', wait: 'Waiting for agents', closeAgent: 'Closed agent', sendInput: 'Sent guidance', followupTask: 'Assigned follow-up', interruptAgent: 'Stopped agent' } as Record<string, string>)[item.tool || ''] || 'Agent activity'}</strong>{item.text && <p>{item.text}</p>}{item.agents?.map(agent => <div key={agent.id}><span title={agent.id}>Agent · {agent.id.slice(0, 8)}</span><span className={`agent-state ${agent.status}`}>{status(agent.status)}</span><button type="button" onClick={() => setSelected(agent.id)}>View agent</button>{agent.message && <p>{agent.message}</p>}</div>)}{selected && <AgentReader sessionId={sessionId} id={selected} close={() => setSelected(null)} />}</section>
}
