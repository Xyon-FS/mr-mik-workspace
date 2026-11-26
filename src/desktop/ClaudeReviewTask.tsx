import { useState } from 'react'
import DarkSelect from './DarkSelect'
import { Icon } from './Icons'

export default function ClaudeReviewTask({ disabled, prepare }: { disabled: boolean; prepare: (target: object) => Promise<void> }) {
  const [open, setOpen] = useState(false), [scope, setScope] = useState('uncommittedChanges'), [reference, setReference] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <div className="graphical-operation-controls">{!open ? <div className="graphical-actions"><button type="button" className="graphical-review-action" disabled={disabled} onClick={() => setOpen(true)}><Icon name="fork" size={15} /><span>Review changes</span><Icon name="arrow" size={13} /></button></div> : <>
    <strong>Review changes</strong><p className="graphical-info-note">Prepares an ordinary review prompt with your selected model and permissions. Nothing is sent until you press Send, which uses your account allowance.</p>
    <DarkSelect label="Review scope" value={scope} options={[{ value: 'uncommittedChanges', label: 'Working changes' }, { value: 'baseBranch', label: 'Against a branch' }, { value: 'commit', label: 'A commit' }]} onChange={value => { setScope(value); setReference('') }} />
    {scope !== 'uncommittedChanges' && <input aria-label={scope === 'commit' ? 'Commit hash' : 'Base branch'} placeholder={scope === 'commit' ? 'Commit hash' : 'e.g. main'} value={reference} maxLength={200} onChange={event => setReference(event.target.value)} />}
    {error && <p role="alert">{error}</p>}
    <div className="graphical-actions"><button type="button" disabled={disabled || busy || scope !== 'uncommittedChanges' && !reference.trim()} onClick={() => { setBusy(true); setError(''); void prepare({ type: scope, ...(scope === 'baseBranch' ? { branch: reference } : scope === 'commit' ? { sha: reference } : {}) }).then(() => setOpen(false)).catch(cause => setError(cause.message)).finally(() => setBusy(false)) }}>Prepare review draft</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
  </>}</div>
}
