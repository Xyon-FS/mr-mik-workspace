import { useState } from 'react'
import { api } from './client'

type State = {
  busy: boolean; agentAvailable?: boolean; compactAvailable?: boolean; permissions?: string
  operation?: { requestId: string; status: string } | null
  usage?: { agent: string | null; model: { providerID: string; modelID: string; variant: string } | null; tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } | null; context: { used: number; window: number } | null }
}
const count = (value: number | null | undefined) => value == null ? 'Unavailable' : value.toLocaleString()
export default function NativeControlsPanel({ id, launchId, close }: { id: string; launchId: string; close: () => void }) {
  const [data, setData] = useState<State | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [requestId, setRequestId] = useState('')
  const act = async (action: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const key = action === 'compact' ? requestId || crypto.randomUUID() : ''
      if (key) setRequestId(key)
      const result = await api<State>(`/sessions/${id}/nativecontrols`, { action, launchId, ...(key ? { requestId: key } : {}) })
      if (action === 'agent') { close(); return }
      const next = action === 'inspect' ? result : await api<State>(`/sessions/${id}/nativecontrols`, { action: 'inspect', launchId }); setData(next)
      if (next.operation && ['completed', 'failed'].includes(next.operation.status) || action === 'dismiss') setRequestId('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="graphical-menu-section" aria-label="OpenCode modes and usage">
    <h3>Modes, usage and context</h3>
    <button type="button" disabled={busy || !launchId} onClick={() => { void act('inspect') }}>Inspect native usage and modes</button>
    {data && <>
      <dl className="graphical-info-rows"><div><dt>Agent</dt><dd>{data.usage?.agent || 'Unavailable'}</dd></div><div><dt>Model</dt><dd>{data.usage?.model ? `${data.usage.model.providerID} / ${data.usage.model.modelID} · ${data.usage.model.variant}` : 'Native default / unavailable'}</dd></div><div><dt>Session input / output</dt><dd>{count(data.usage?.tokens?.input)} / {count(data.usage?.tokens?.output)}</dd></div><div><dt>Cache read / write</dt><dd>{count(data.usage?.tokens?.cacheRead)} / {count(data.usage?.tokens?.cacheWrite)}</dd></div><div><dt>Context estimate</dt><dd>{data.usage?.context ? `${count(data.usage.context.used)} / ${count(data.usage.context.window)} tokens` : 'Unavailable'}</dd></div></dl>
      <p>Native estimates. Subscription balance unavailable.</p><p>{data.permissions || 'Wait for native work to finish before inspection.'}</p>
      <button type="button" disabled={busy || data.busy || !data.agentAvailable} onClick={() => { void act('agent') }}>Choose native agent / Plan</button>
      <p>Agent changes require an empty native prompt. Drafts are preserved.</p>
      {data.operation && <p role="status">Compaction: {data.operation.status}{data.operation.status === 'uncertain' ? '. Inspect the terminal before another attempt. Nothing is retried automatically.' : ''}</p>}
      {data.operation?.status === 'uncertain' && <button type="button" disabled={busy || data.busy} onClick={() => { void act('dismiss') }}>Clear status after inspection</button>}
      <p>Compaction summarizes this conversation using the native model and can consume usage.</p>
      {confirm ? <div className="graphical-actions"><button type="button" disabled={busy || data.busy} onClick={() => { setConfirm(false); void act('compact') }}>Confirm native compaction</button><button type="button" onClick={() => setConfirm(false)}>Cancel</button></div> : <button type="button" disabled={busy || data.busy || !data.compactAvailable || !!data.operation && ['running', 'uncertain'].includes(data.operation.status)} onClick={() => setConfirm(true)}>Compact native conversation</button>}
    </>}
    {busy && <p role="status">Inspecting native controls…</p>}{error && <p role="alert">{error}</p>}
  </section>
}
