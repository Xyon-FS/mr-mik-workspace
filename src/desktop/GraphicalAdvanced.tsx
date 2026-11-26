import { useState } from 'react'
import type { ReactNode } from 'react'
import DarkSelect from './DarkSelect'
import type { ChatOperation } from './GraphicalOperations'
import { Icon } from './Icons'
import GraphicalContext from './GraphicalContext'

type Tokens = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; reasoningOutputTokens: number | null }
type LimitWindow = { usedPercent: number | null; minutes: number | null; resetsAt: number | null }
export type AdvancedState = {
  operation?: ChatOperation | null; operationBusy?: boolean;
  modes: { mode: string; label: string }[]; mode: string | null; modeEffective: string | null; modeError: string; configuring: boolean; steering: boolean; supportsSteer: boolean;
  usage: { last: Tokens | null; total: Tokens | null; capacity: number | null; model: string | null } | null;
  limits: { id: string; label: string; primary: LimitWindow | null; secondary: LimitWindow | null }[] | null;
  queue: { id: string; text: string; paths: string[]; context?: { id: string; type: string; name?: string; text?: string }[]; state: string; settings: { model: string | null; mode: string | null } }[]; queuePaused: boolean; queueNotice?: string;
}
export function GraphicalMode({ data, disabled, act }: { data?: AdvancedState; disabled: boolean; act: (body: object) => Promise<void> }) {
  return <DarkSelect label="Collaboration mode" compact icon="" placeholder="Build" title={data?.mode ? 'Plan explores and prepares a plan; Build implements using the selected permissions.' : 'Waiting for native work modes'} value={data?.mode || ''} disabled={disabled || !!data?.configuring || !data?.modes.length || !!data?.queue.length} options={(data?.modes || []).map(mode => ({ value: mode.mode, label: mode.label }))} onChange={mode => { void act({ action: 'mode', mode }).catch(() => {}) }} />
}
export function GraphicalUsage({ data, compact }: { data?: AdvancedState; compact?: ReactNode }) {
  const usage = data?.usage
  return <GraphicalContext used={usage?.last?.inputTokens} capacity={usage?.capacity}>{compact}</GraphicalContext>
}
export function GraphicalAccountLimits({ data, refresh }: { data?: AdvancedState; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <section className="graphical-account-usage graphical-menu-section" aria-label="Account limits">
    <header className="graphical-info-heading"><strong>Account limits</strong><button type="button" className="graphical-usage-refresh" aria-label="Refresh account usage" title="Refresh account usage" disabled={busy} onClick={() => { setBusy(true); setError(''); void refresh().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)) }}><Icon name="refresh" size={14} /></button></header>
    {busy && <span role="status" className="graphical-info-note">Refreshing…</span>}
    {data?.limits?.length ? data.limits.map(bucket => <div key={bucket.id} className="graphical-limit-window">{data.limits!.length > 1 && <b>{bucket.label}</b>}{[bucket.primary, bucket.secondary].filter(Boolean).map((window, index) => <div key={index} title={window!.resetsAt != null ? `Resets ${new Date(window!.resetsAt * 1000).toLocaleString()}` : undefined}><span>{window!.minutes != null ? `${window!.minutes >= 60 ? `${window!.minutes / 60}h` : `${window!.minutes}m`} window` : 'Usage window'}</span><strong>{window!.usedPercent == null ? 'Unavailable' : `${window!.usedPercent}% used`}</strong></div>)}</div>) : <p className="graphical-info-note">Not loaded or unavailable.</p>}
    {error && <p role="alert" className="graphical-info-warning">{error}</p>}
  </section>
}
function QueueEntry({ item, act, dismissUncertain = false, disabled = false }: { item: AdvancedState['queue'][number]; act: (body: object) => Promise<void>; dismissUncertain?: boolean; disabled?: boolean }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(item.text), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const perform = (body: object) => { setBusy(true); setError(''); void act(body).then(() => setEditing(false)).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)) }
  const visibleContext = item.context?.filter(context => context.type !== 'skill') || []
  const long = item.text.length > 140 || item.text.includes('\n')
  return <li><div>{editing ? <textarea aria-label="Edit queued message" disabled={disabled || busy} value={text} maxLength={64000} onChange={event => setText(event.target.value)} /> : <div className="graphical-queue-preview">{long ? <details className="graphical-queue-message"><summary>{item.text.replace(/\s+/g, ' ').slice(0, 140)}{item.text.length > 140 ? '…' : ''}</summary><p>{item.text}</p></details> : <span>{item.text || 'Attached files'}</span>}{item.paths.length > 0 && <small>{item.paths.length} attachments</small>}{!!visibleContext.length && <details className="graphical-queue-context"><summary>Context · {visibleContext.length}</summary>{visibleContext.map(context => <p key={context.id}>{context.type === 'skill' ? `/${context.name}` : `Quote: ${context.text}`}</p>)}</details>}</div>}<small>{item.state === 'queued' ? item.settings.mode === 'plan' ? 'Plan' : 'Queued' : item.state === 'sending' ? 'Sending…' : 'Delivery uncertain'}</small>{error && <p role="alert" className="graphical-queue-error">{error}</p>}</div>{item.state === 'queued' && <div>{editing ? <><button disabled={disabled || busy || !text.trim() && !item.paths.length && !item.context?.length} onClick={() => perform({ action: 'queue-edit', id: item.id, text })}>Save</button><button disabled={disabled || busy} onClick={() => { setText(item.text); setError(''); setEditing(false) }}>Cancel edit</button></> : <><button disabled={disabled || busy} onClick={() => { setText(item.text); setError(''); setEditing(true) }}>Edit</button><button disabled={disabled || busy} onClick={() => perform({ action: 'queue-cancel', id: item.id })}>Remove</button></>}</div>}{dismissUncertain && item.state === 'uncertain' && <button disabled={disabled || busy} onClick={() => perform({ action: 'queue-cancel', id: item.id })}>Dismiss without resending</button>}</li>
}
export function GraphicalQueue({ data, act, dismissUncertain = false, disabled = false }: { data?: Pick<AdvancedState, 'queue' | 'queuePaused' | 'queueNotice'>; act: (body: object) => Promise<void>; dismissUncertain?: boolean; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (!data?.queue.length) return null
  return <section className="graphical-queue" aria-label="Queued messages"><header><strong>Queue · {data.queue.length}{data.queuePaused ? ' · paused' : ''}</strong><button type="button" disabled={disabled || busy} onClick={() => { setBusy(true); setError(''); void act({ action: 'queue-pause', paused: !data.queuePaused }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)) }}>{data.queuePaused ? 'Resume queue' : 'Pause queue'}</button></header>{error && <p role="alert" className="graphical-queue-error">{error}</p>}<ol>{data.queue.map(item => <QueueEntry key={item.id} item={item} act={act} dismissUncertain={dismissUncertain} disabled={disabled} />)}</ol><small role={data.queueNotice ? 'status' : undefined}>{data.queueNotice || 'Uses the selected account and settings. Pauses after an interruption, error or restart.'}</small></section>
}
