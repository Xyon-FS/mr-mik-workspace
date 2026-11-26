import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'

type ModelOption = { key: string; label: string; slug: string; current: boolean; active?: boolean; description?: string }

export default function CodexModelMenu({ sessionId, running, agent = 'codex', visible = true, modelLabel, effort, onModelLabel }: { sessionId: string; running: boolean; agent?: 'codex' | 'claude' | 'opencode'; visible?: boolean; modelLabel?: string; effort?: string; onModelLabel?: (label: string) => void }) {
  const nativePicker = useRef<{ kind: 'model' | 'reasoning'; settled: Promise<unknown> } | null>(null)
  const cancelNative = useCallback(async () => {
    const owner = nativePicker.current; nativePicker.current = null
    if (!owner) return
    await owner.settled.catch(() => {})
    await api(`/sessions/${sessionId}/${owner.kind}-picker`, { action: 'cancel' })
  }, [sessionId])
  useEffect(() => () => { void cancelNative().catch(() => {}) }, [cancelNative])
  async function requestPicker<T>(kind: 'model' | 'reasoning', body: object) {
    const settled = api<T>(`/sessions/${sessionId}/${kind}-picker`, body)
    const owner = { kind, settled }; nativePicker.current = owner
    const result = await settled
    return nativePicker.current === owner ? result : null
  }
  const label = agent === 'opencode' ? 'OpenCode' : agent === 'claude' ? 'Claude' : 'Codex'
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'model' | 'reasoning'>('model')
  async function open(kind: 'model' | 'reasoning') {
    if (options && kind === mode) return close()
    if (options) await close()
    setMode(kind); setQuery('')
    setBusy(true); setError('')
    try { const result = await requestPicker<{ options: ModelOption[] }>(kind, { action: 'open' }); if (result) { setOptions(result.options); const current = result.options.find(option => option.current); if (kind === 'model' && current) onModelLabel?.(current.label) } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function choose(model: string) {
    const selectedLabel = options?.find(option => option.slug === model)?.label
    setBusy(true); setError('')
    try {
      const result = await requestPicker<{ variantMenu?: boolean }>(mode, { action: 'choose', ...(mode === 'model' ? { model } : { effort: model }) })
      if (!result) return
      if (mode === 'model' && selectedLabel) onModelLabel?.(selectedLabel)
      nativePicker.current = null; setOptions(null)
      if (agent === 'opencode' && result.variantMenu) {
        setMode('reasoning'); setQuery('')
        const variants = await requestPicker<{ options: ModelOption[] }>('reasoning', { action: 'open' }); if (variants) setOptions(variants.options)
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setOptions(null) }
    finally { setBusy(false) }
  }
  async function close() {
    setBusy(true); setOptions(null); setError('')
    try { await cancelNative() } catch { /* The native terminal remains usable. */ }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (visible || busy || !options) return
    let dismissed = false
    void Promise.resolve().then(async () => {
      if (dismissed) return
      setBusy(true)
      try { await cancelNative() }
      catch { /* The native terminal remains usable. */ }
      finally { setOptions(null); setError(''); setBusy(false) }
    })
    return () => { dismissed = true }
  }, [visible, busy, options, cancelNative])
  return <div className="chat-model-control native-session-controls">
    <div className="native-picker-field"><span>Model</span><button type="button" className="chat-model-button" aria-label="Choose model" disabled={!running || busy} title={`Choose a ${label} model in this chat`} aria-expanded={!!options && mode === 'model'} onClick={() => void open('model')}><span>{busy && mode === 'model' ? 'Loading…' : modelLabel || 'Choose model'}</span><Icon name="arrow" size={11} /></button></div>
    <div className="native-picker-field"><span>{agent === 'opencode' ? 'Variant' : 'Reasoning'}</span><button type="button" className="chat-model-button" disabled={!running || busy} title={`Choose ${label} ${agent === 'opencode' ? 'variant' : 'reasoning'} in this chat`} aria-label={agent === 'opencode' ? 'Chat variant' : 'Chat reasoning'} aria-expanded={!!options && mode === 'reasoning'} onClick={() => void open('reasoning')}><span>{busy && mode === 'reasoning' ? 'Loading…' : effort === 'xhigh' ? 'Extra high' : effort ? effort[0].toUpperCase()+effort.slice(1) : 'Select'}</span><Icon name="arrow" size={11} /></button></div>
    {(options || error) && <div className={`chat-model-menu${mode === 'reasoning' ? ' native-reasoning-menu' : ''}`} role="group" aria-label={`${label} ${mode === 'model' ? 'models' : agent === 'opencode' ? 'variants' : 'reasoning'}`}>
      {options && <>{agent === 'opencode' && mode === 'model' && <input aria-label="Find a native model" placeholder="Find a model…" value={query} onChange={event => setQuery(event.target.value)} />}<div className="native-picker-options" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close(); return }
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')]
        if (!buttons.length) return
        event.preventDefault()
        const index = buttons.indexOf(event.target as HTMLButtonElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length
        buttons[next].focus()
      }}>{options.filter(item => `${item.label} ${item.description || ''}`.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" key={item.slug} disabled={busy} aria-pressed={mode === 'reasoning' ? item.active || item.current : item.current} title={item.description} onClick={() => void choose(item.slug)}><span>{item.label}</span>{(mode === 'reasoning' ? item.active || item.current : item.current) && <Icon name="check" size={13} />}</button>)}</div><footer><button type="button" className="model-menu-cancel" onClick={() => void close()}>Cancel</button><details><summary>Native controls</summary><button type="button" className="model-menu-cancel" onClick={() => { nativePicker.current = null; setOptions(null); setError('') }}>Use {label} picker in terminal</button></details></footer></>}
      {error && <><p role="alert">{error}</p>{agent === 'opencode' && <button type="button" className="model-menu-cancel" disabled={busy} onClick={() => void open(mode)}>Retry picker</button>}<button type="button" className="model-menu-cancel" onClick={() => { nativePicker.current = null; setOptions(null); setError('') }}>Continue in terminal</button></>}
    </div>}
  </div>
}
