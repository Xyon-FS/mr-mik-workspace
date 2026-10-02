import { useState } from 'react'
import { api } from './client'

type ModelOption = { key: string; label: string; slug: string; current: boolean; description?: string }

export default function CodexModelMenu({ sessionId, running, agent = 'codex' }: { sessionId: string; running: boolean; agent?: 'codex' | 'claude' | 'opencode' }) {
  const label = agent === 'opencode' ? 'OpenCode' : agent === 'claude' ? 'Claude' : 'Codex'
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'model' | 'reasoning'>('model')
  const route = (kind = mode) => `/sessions/${sessionId}/${kind === 'model' ? 'model' : 'reasoning'}-picker`
  async function open(kind: 'model' | 'reasoning') {
    if (options && kind === mode) return close()
    if (options) await close()
    setMode(kind); setQuery('')
    setBusy(true); setError('')
    try { setOptions((await api<{ options: ModelOption[] }>(route(kind), { action: 'open' })).options) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function choose(model: string) {
    setBusy(true); setError('')
    try {
      const result = await api<{ variantMenu?: boolean }>(route(), { action: 'choose', ...(mode === 'model' ? { model } : { effort: model }) })
      setOptions(null)
      if (agent === 'opencode' && result.variantMenu) {
        setMode('reasoning'); setQuery('')
        setOptions((await api<{ options: ModelOption[] }>(route('reasoning'), { action: 'open' })).options)
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setOptions(null) }
    finally { setBusy(false) }
  }
  async function close() {
    setOptions(null); setError('')
    try { await api(route(), { action: 'cancel' }) } catch { /* The native terminal remains usable. */ }
  }
  return <div className="chat-model-control">
    <button className="chat-model-button" disabled={!running || busy} title={`Choose a ${label} model in this chat`} aria-expanded={!!options && mode === 'model'} onClick={() => void open('model')}>{busy && mode === 'model' ? 'Loading…' : 'Model ▾'}</button>
    <button className="chat-model-button" disabled={!running || busy} title={`Choose ${label} ${agent === 'opencode' ? 'variant' : 'reasoning'} in this chat`} aria-label={agent === 'opencode' ? 'Chat variant' : 'Chat reasoning'} aria-expanded={!!options && mode === 'reasoning'} onClick={() => void open('reasoning')}>{busy && mode === 'reasoning' ? 'Loading…' : agent === 'opencode' ? 'Variant ▾' : 'Reasoning ▾'}</button>
    {(options || error) && <div className="chat-model-menu" role="group" aria-label={`${label} ${mode === 'model' ? 'models' : agent === 'opencode' ? 'variants' : 'reasoning'}`}>
      {options && <><small>{agent === 'opencode' ? 'Connected native models' : `Available in this ${label} chat`}</small>{agent === 'opencode' && mode === 'model' && <input aria-label="Find a native model" placeholder="Find a model…" value={query} onChange={event => setQuery(event.target.value)} />}{options.filter(item => `${item.label} ${item.description || ''}`.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.slug} disabled={busy} onClick={() => void choose(item.slug)}><span>{item.label}{item.description && <small>{item.description}</small>}</span>{item.current && <em>Current</em>}</button>)}<p>{agent === 'opencode' ? 'Applies in this chat without restart. Provider and regional access limits still apply.' : mode === 'reasoning' ? 'Applies to this session only; native model/account limits apply.' : agent === 'claude' ? 'Uses the native Claude picker without restarting this chat. Model access depends on your account.' : 'The current reasoning level is kept when available; otherwise Codex’s default is used.'}</p><button className="model-menu-cancel" onClick={() => void close()}>Cancel</button><button className="model-menu-cancel" onClick={() => { setOptions(null); setError('') }}>Use {label} picker in terminal</button></>}
      {error && <><p role="alert">{error}</p>{agent === 'opencode' && <button className="model-menu-cancel" disabled={busy} onClick={() => void open(mode)}>Retry picker</button>}<button className="model-menu-cancel" onClick={() => { setOptions(null); setError('') }}>Continue in terminal</button></>}
    </div>}
  </div>
}
