import { useState } from 'react'
import { useSettingsConfirmation } from './useSettingsConfirmation'
import { api } from './client'
import { Icon } from './Icons'
import type { AccountProfile } from './AccountProfileSelect'
import AccountLimitsInfo from './AccountLimitsInfo'
import InlineAccountName from './InlineAccountName'
import useAccountInventory from './useAccountInventory'

type Plan = { token: string; action: string }
export default function AccountProfilesSettings() {
  const { confirm, dialog } = useSettingsConfirmation()
  const { rows, refresh, error, setError } = useAccountInventory('codex')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null)
  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try { await action(); await refresh() } catch (cause) { await refresh().catch(() => {}); setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false); setPending(null) }
  }
  async function complete(actionPlan: Plan, id: string) {
    setPending({ id, action: actionPlan.action })
    setMessage(actionPlan.action === 'login' ? 'Complete sign-in in the private browser window. This list updates automatically.' : 'Signing out…')
    await api('/accounts/confirm', { token: actionPlan.token })
    setMessage(actionPlan.action === 'login' ? 'Account connected.' : 'Signed out. Your chats are kept.')
  }
  async function accountAction(row: AccountProfile, action: string) {
    const actionPlan = await api<Plan>('/accounts/plan', { agent: 'codex', profileId: row.id, action, disconnect: action === 'logout' && !row.system })
    await complete(actionPlan, row.id)
  }
  return <section aria-label="Codex account profiles"><h3>Codex accounts</h3>
    
    <div className="settings-account-count">{rows.length} accounts</div><div className="account-profile-list">{rows.map(row => {
      const changing = pending?.id === row.id || row.accountTerminalOpen || row.statusPending
      const status = !row.available || changing ? 'unknown' : row.status || 'unknown'
      return <div className="account-row" key={row.id}>
        <strong><InlineAccountName label={row.label} disabled={busy || changing} save={async label => { await api('/accounts/profiles', { action: 'rename', id: row.id, label }); await refresh() }} /></strong>
        {row.identityEmail && <small className="account-identity" title={row.identityEmail}>{row.identityEmail}</small>}
        <small className={`account-status ${status}`}><span aria-hidden="true">●</span> {row.statusPending ? 'Checking status…' : !row.available ? 'Unavailable' : changing ? pending?.action === 'logout' ? 'Signing out…' : 'Connecting…' : row.status === 'logged-in' ? 'Logged in' : row.status === 'logged-out' ? 'Not logged in' : 'Status unavailable'}</small>
        {row.identityState && !['verified', 'signed-out'].includes(row.identityState) && <small className="desk-error-inline" role="status">{row.identityState === 'duplicate' ? `Same account as ${row.duplicateLabel}. Sign out the duplicate.` : row.identityState === 'changed' ? 'Account identity changed. Sign out and reconnect.' : row.identityState === 'unverified' ? 'Confirm this existing account before using it.' : 'Account identity unavailable. Reconnect.'}</small>}
          {row.identityState === 'unverified' && <button className="account-verify" disabled={busy || changing || !row.available} onClick={async () => { if (await confirm(`Confirm ${row.identityEmail || row.label} as this profile’s ChatGPT account? Close its chats first.`)) void run(() => api('/accounts/profiles', { action: 'verify', id: row.id, identityRevision: row.identityRevision })) }}>Verify account</button>}
        <div className="account-actions"><AccountLimitsInfo agent="codex" profileId={row.id} />

          {row.status !== 'logged-in' && <button disabled={busy || !row.available || changing} onClick={() => void run(() => accountAction(row, 'login'))} title="Sign in"><Icon name="login" size={14} /><span className="account-action-label">Sign in</span></button>}
          {row.status !== 'logged-out' && <button disabled={busy || !row.available || changing} title="Sign out and disconnect this account; chats are kept" onClick={() => void run(() => accountAction(row, 'logout'))}><Icon name="logout" size={14} /><span className="account-action-label">Sign out</span></button>}
          {row.status !== 'logged-out' && <button disabled aria-label={`Remove ${row.label}`} title="Sign out before removing this account"><Icon name="close" size={12} /></button>}{!row.system && row.status === 'logged-out' && <button className="account-forget" disabled={busy || changing} title="Remove this disconnected account; chats are kept" aria-label={`Remove ${row.label}`} onClick={() => void run(() => api('/accounts/profiles', { action: 'remove', id: row.id }))}><Icon name="close" size={12} /></button>}
        </div>
      </div>
    })}</div>
    <div className="account-actions account-add"><button disabled={busy} onClick={() => void run(async () => {
      const account = await api<AccountProfile>('/accounts/profiles', { action: 'create' })
      setPending({ id: account.id, action: 'login' }); await refresh()
      const login = await api<Plan>('/accounts/plan', { agent: 'codex', profileId: account.id, action: 'login' })
      await complete(login, account.id)
    })}><Icon name="plus" size={13} />Connect Codex account</button></div>
    {dialog}
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="desk-error-inline">{error}</p>}

  </section>
}
