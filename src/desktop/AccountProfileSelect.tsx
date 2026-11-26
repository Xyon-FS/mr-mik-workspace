import { useEffect, useState } from 'react'
import { api, onServiceEvent } from './client'
import DarkSelect from './DarkSelect'
import { Icon } from './Icons'

export type AccountProfile = { id: string; label: string; system: boolean; available?: boolean; status?: string; statusPending?: boolean; accountTerminalOpen?: boolean; identityState?: string; identityEmail?: string | null; duplicateLabel?: string | null; identityRevision?: string }
export default function AccountProfileSelect({ value, onChange, disabled = false, compact = false, menu = false, agent = 'codex', appearance }: { agent?: 'codex' | 'claude'; value: string; onChange: (value: string) => void; disabled?: boolean; compact?: boolean; menu?: boolean; appearance?: 'workspace' }) {
  const [profiles, setProfiles] = useState<AccountProfile[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const refresh = () => { void api<AccountProfile[]>(agent === 'claude' ? '/accounts/claude-profiles?status=false' : '/accounts/profiles?status=false').then(rows => { if (active) { setProfiles(rows.filter(row => agent === 'claude' || !row.system && row.id !== 'system')); setError('') } }).catch(() => { if (active) setError('Account profiles unavailable.') }) }
    const unsubscribe = onServiceEvent(event => { if (event.type === 'accounts-changed') refresh() }); refresh(); window.addEventListener('focus', refresh)
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', refresh) }
  }, [agent])
  const selected = profiles.some(row => row.id === value) ? value : ''
  const options = [...(!selected ? [{ value: '', label: profiles.length ? 'Choose account…' : 'Connect an account first', disabled: true }] : []), ...profiles.map(row => ({ value: row.id, label: row.label }))]
  if (menu) return <div className="session-account-choices" role="radiogroup" aria-label={`${agent === 'claude' ? 'Claude' : 'Codex'} account`}>{profiles.map(profile => <button type="button" key={profile.id} role="radio" aria-checked={profile.id === value} disabled={disabled} onClick={() => { if (!disabled && profile.id !== value) onChange(profile.id) }}><Icon name="account" size={15} /><span>{profile.label}</span>{profile.id === value && <Icon name="check" size={14} />}</button>)}{!profiles.length && <small>{error || 'Connect an account in Settings → Accounts.'}</small>}</div>
  return <div className={compact ? 'chat-account-control' : 'desk-field'} title={disabled ? 'Finish the current action and clear the draft before changing account.' : agent === 'claude' ? 'Native Claude account and configuration for this conversation.' : 'Account used for the next message; tools are shared.'}>{!compact && `${agent === 'claude' ? 'Claude' : 'Codex'} account`}<DarkSelect appearance={appearance} title={profiles.find(row => row.id === value)?.label} icon="account" compact={compact} label={`${agent === 'claude' ? 'Claude' : 'Codex'} account`} value={selected} options={options} disabled={disabled || !profiles.length} onChange={selected => { if (!disabled) onChange(selected) }} />{!profiles.length && !error && <small>Connect a {agent === 'claude' ? 'Claude' : 'Codex'} account in Settings → Accounts.</small>}{profiles.length > 0 && !selected && <small>Choose an added account before continuing this chat.</small>}{disabled && !compact && <small>Finish the current action and clear the draft before changing account.</small>}{error && <small role="alert">{error}</small>}</div>
}
