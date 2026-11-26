import { useRef, useState } from 'react'

export default function InlineAccountName({ label, disabled, save }: { label: string; disabled?: boolean; save: (label: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(label), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const finishing = useRef(false)
  const finish = async (commit: boolean) => {
    if (finishing.current) return
    finishing.current = true
    const next = draft.trim()
    if (!commit || !next || next === label) { setEditing(false); return }
    setSaving(true); setError('')
    try { await save(next); setEditing(false) } catch (cause) { finishing.current = false; setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  return <span className="inline-account-name">{editing ? <input data-local-escape aria-label="Account name" autoFocus maxLength={80} disabled={saving} value={draft} onFocus={event => event.target.select()} onChange={event => setDraft(event.target.value)} onBlur={() => void finish(true)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finish(event.key === 'Enter') } }} /> : <button type="button" className="account-name" title={`${label} · Rename account`} disabled={disabled} onClick={() => { finishing.current = false; setDraft(label); setError(''); setEditing(true) }}>{label}</button>}{error && <small role="alert" className="desk-error-inline">{error}</small>}</span>
}
