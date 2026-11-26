import { useState } from 'react'
import { useSettingsConfirmation } from './useSettingsConfirmation'
import { api } from './client'
import type { AccountProfile } from './AccountProfileSelect'
import AccountLimitsInfo from './AccountLimitsInfo'
import InlineAccountName from './InlineAccountName'
import useAccountInventory from './useAccountInventory'
import { Icon } from './Icons'
import WorkspaceDialog from './WorkspaceDialog'

export default function ClaudeProfilesSettings() {
  const { confirm, dialog } = useSettingsConfirmation()
  const { rows, refresh, error, setError } = useAccountInventory('claude')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [adding, setAdding] = useState(false), [name, setName] = useState(''), [directory, setDirectory] = useState('')
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try { await action(); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const authenticate = async (id: string, action: 'login' | 'logout') => {
    const plan = await api<{ token: string }>('/accounts/plan', { agent: 'claude', profileId: id, action })
    setMessage(action === 'login' ? 'Complete Claude sign-in in your browser. No credentials are copied.' : 'Signing out this Claude profile…')
    await api('/accounts/confirm', { token: plan.token }); setMessage(action === 'login' ? 'Claude account connected.' : 'Signed out. Native conversations are retained.')
  }
  return <section className="claude-profiles-settings" aria-label="Claude account profiles"><h3>Claude accounts</h3>
    <div className="settings-account-count">{rows.length} accounts</div><div className="account-profile-list">{rows.map(row => <div className="account-row" key={row.id}>
      <strong>{row.system ? row.label : <InlineAccountName label={row.label} disabled={busy || row.accountTerminalOpen} save={async label => { await api('/accounts/claude-profiles', { action: 'rename', id: row.id, label }); await refresh() }} />}</strong>
      {row.identityEmail && <small className="account-identity">{row.identityEmail}</small>}
      <small className={`account-status ${!row.available || row.accountTerminalOpen ? 'unknown' : row.status || 'unknown'}`}>{row.statusPending ? 'Checking status…' : !row.available ? 'Unavailable' : row.accountTerminalOpen ? 'Connecting…' : row.status === 'logged-in' ? 'Logged in' : row.status === 'logged-out' ? 'Not logged in' : 'Status unavailable'}</small>
      <div className="account-actions"><AccountLimitsInfo agent="claude" profileId={row.id} />{row.status !== 'logged-in' && <button disabled={busy || !row.available || row.accountTerminalOpen} onClick={() => void run(() => authenticate(row.id, 'login'))} title="Sign in"><Icon name="login" size={14} /><span className="account-action-label">Sign in</span></button>}{row.status !== 'logged-out' && <button disabled={busy || !row.available || row.accountTerminalOpen} onClick={async () => { if (await confirm(`Sign out ${row.label}? Close apps using this Claude profile first. Conversations are kept.`)) void run(() => authenticate(row.id, 'logout')) }} title="Sign out"><Icon name="logout" size={14} /><span className="account-action-label">Sign out</span></button>}{row.system && <button disabled title="The current native account cannot be disconnected" aria-label="Disconnect current Claude account"><Icon name="close" size={14} /></button>}{!row.system && <button disabled={busy || row.accountTerminalOpen} title="Remove association; keep all native files" onClick={async () => { if (await confirm(`Disconnect ${row.label} from Mr. Mik? Its native directory and saved chats are kept.`)) void run(() => api('/accounts/claude-profiles', { action: 'remove', id: row.id })) }}><Icon name="close" size={14} /><span className="account-action-label">Disconnect</span></button>}</div>
    </div>)}</div>
    {!adding ? <div className="account-actions account-add"><button disabled={busy} onClick={() => { setError(''); setAdding(true) }}>Add Claude account</button></div> : <WorkspaceDialog label="Add Claude account" busy={busy} close={() => setAdding(false)}><h3>Add Claude account</h3><form className="claude-profile-form" onSubmit={event => { event.preventDefault(); void run(async () => { const row = await api<AccountProfile>('/accounts/claude-profiles', { action: 'create', label: name || undefined, directory: directory.trim() || undefined }); setAdding(false); setName(''); setDirectory(''); if (!directory.trim()) await authenticate(row.id, 'login'); else setMessage('Existing Claude profile linked. No native files were copied.'); }) }}>
      <label>Claude account name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
      <label>Existing Claude configuration directory (optional)<input value={directory} onChange={event => setDirectory(event.target.value)} placeholder="Leave empty for a new account" /></label>
      <small>A new account gets an empty native directory. An existing directory is used directly. Chats remain associated with their original profile.</small>
      {error && <p role="alert" className="desk-error-inline">{error}</p>}<div className="account-actions"><button disabled={busy} type="submit">{directory.trim() ? 'Link existing profile' : 'Create and sign in'}</button><button disabled={busy} type="button" onClick={() => setAdding(false)}>Cancel</button></div>
    </form></WorkspaceDialog>}
    <p>Use an existing native directory directly, or create an independent account. No credentials are copied.</p>
    {dialog}
    {message && <p role="status">{message}</p>}{error && !adding && <p role="alert" className="desk-error-inline">{error}</p>}
  </section>
}
