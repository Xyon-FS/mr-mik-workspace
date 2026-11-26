import { useState } from 'react'
import { Icon } from './Icons'
import GraphicalContext from './GraphicalContext'

export type NativeUsage = {
  tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } | null
  context: { used: number; window: number; model: string; source: string } | null
  plan: { available: boolean; windows: { label: string; percent: number | null; resetsAt: string | null }[] }
  updatedAt: number | null; error: string
}
export type NativeCompaction = { requestId: string; status: string } | null

export default function ProviderUsage({ usage, refreshing, disabled, compactDisabled, available, operation, act }: {
  usage?: NativeUsage; refreshing: boolean; disabled: boolean; compactDisabled: boolean; available: boolean
  operation?: NativeCompaction; act: (body: object) => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [requestId, setRequestId] = useState('')
  return <GraphicalContext used={usage?.context?.used} capacity={usage?.context?.window}>
    {!available && <p>Unavailable in this native runtime. Use the CLI.</p>}
    {operation && <p role="status">Compaction: {operation.status}{operation.status === 'uncertain' ? '. Inspect the native conversation before another attempt; nothing is retried automatically.' : ''}</p>}
    {operation?.status === 'uncertain' && <button type="button" disabled={disabled} onClick={() => { void act({ action: 'compact-dismiss' }); setRequestId('') }}>Clear status after inspection</button>}
    {confirm ? <div className="graphical-actions"><p className="graphical-info-note">Summarize this conversation using the selected model. This can consume usage.</p><button type="button" disabled={compactDisabled || !available} onClick={() => { const id = requestId || crypto.randomUUID(); setRequestId(id); setConfirm(false); void act({ action: 'compact', requestId: id }) }}>Confirm compaction</button><button type="button" onClick={() => setConfirm(false)}>Cancel</button></div> : <button type="button" disabled={disabled || refreshing || compactDisabled || !available || operation?.status === 'running' || operation?.status === 'uncertain'} onClick={() => { if (operation?.status === 'completed' || operation?.status === 'failed') setRequestId(''); setConfirm(true) }}>Compact conversation</button>}
  </GraphicalContext>
}

export function ProviderAccountLimits({ usage, refreshing, disabled, act }: { usage?: NativeUsage; refreshing: boolean; disabled: boolean; act: (body: object) => Promise<void> }) {
  return <section className="graphical-account-usage graphical-menu-section" aria-label="Account limits">
    <header className="graphical-info-heading"><strong>Account limits</strong><button type="button" className="graphical-usage-refresh" aria-label="Refresh account usage" title="Refresh account usage" disabled={disabled || refreshing} onClick={() => { void act({ action: 'usage' }) }}><Icon name="refresh" size={14} /></button></header>
    {refreshing && <span role="status" className="graphical-info-note">Refreshing…</span>}
    {!usage?.plan.available ? <p className="graphical-info-note">Unavailable from this native connection.</p> : usage.plan.windows.length ? <div className="graphical-limit-window">{usage.plan.windows.map(row => <div key={row.label} title={row.resetsAt ? `Resets ${new Date(row.resetsAt).toLocaleString()}` : undefined}><span>{row.label}</span><strong>{row.percent == null ? 'Unavailable' : `${row.percent}% used`}</strong></div>)}</div> : <p className="graphical-info-note">No limit windows reported.</p>}
    {usage?.updatedAt && <p className="graphical-info-note">Last checked: {new Date(usage.updatedAt).toLocaleTimeString()}</p>}
    {usage?.error && <p className="graphical-info-warning" role="status">{usage.error}</p>}
  </section>
}
