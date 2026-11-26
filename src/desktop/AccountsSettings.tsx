import { useEffect, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'
import WorkspaceDialog from './WorkspaceDialog'
import AccountProfilesSettings from './AccountProfilesSettings'
import ClaudeProfilesSettings from './ClaudeProfilesSettings'
import AccountLimitsInfo from './AccountLimitsInfo'

type AccountRow = { agent: string; label: string; available: boolean; provider?: string; canLogout?: boolean; providers?: { provider: string; label: string; status: 'logged-in'; canLogout: boolean }[]; status?: 'logged-in' | 'logged-out' | 'unknown' }
type AccountPlan = { token: string; agent: string; label: string; action: 'login' | 'logout' }
export default function AccountsSettings() {
  const [provider, setProvider] = useState('codex')
  const [visited, setVisited] = useState(['codex'])
  const [rows, setRows] = useState<AccountRow[]>([])
  const [plan, setPlan] = useState<AccountPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (provider !== 'opencode') return
    let active = true, pending = false
    const refresh = async () => { if (pending) return; pending = true; try { const data = await api<AccountRow[]>('/accounts?agent=opencode'); if (active) setRows(data) } catch { if (active) setError('Native account controls unavailable.') } finally { pending = false } }
    void refresh(); window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [provider])
  async function review(agent: string, action: 'login' | 'logout', provider = '') {
    setBusy(true); setError(''); setMessage('')
    try { setPlan(await api<AccountPlan>('/accounts/plan', { agent, action, provider })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!plan) return
    setBusy(true); setError('')
    try { await api('/accounts/confirm', { token: plan.token }); setPlan(null); setMessage('Native account terminal opened. Complete authentication there, then reopen chats.') }
    catch (cause) { setPlan(null); setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="accounts-settings"><h3>Accounts</h3>
    <div className="settings-provider-tabs" role="group" aria-label="Account provider">{['codex', 'claude', 'opencode'].map(agent => <button type="button" key={agent} aria-pressed={provider === agent} onClick={() => { setProvider(agent); setVisited(values => values.includes(agent) ? values : [...values, agent]) }}>{agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'OpenCode'}</button>)}</div><div hidden={provider !== 'codex'}><AccountProfilesSettings /></div><div hidden={provider !== 'claude'}>{visited.includes('claude') && <ClaudeProfilesSettings />}</div><div className="account-list" hidden={provider !== 'opencode'}>{rows.filter(row => !['codex', 'claude'].includes(row.agent)).map(row => row.agent === 'opencode' ? <section className="account-provider-group" key={row.agent} aria-label="OpenCode providers">
      <div className="account-provider-heading"><strong>OpenCode</strong><button className="desk-icon account-connect" disabled={busy || !row.available} onClick={() => void review(row.agent, 'login')} aria-label="Connect OpenCode provider" title="Connect provider"><Icon name="plus" size={15} /></button></div>
      {!row.available ? <small className="account-status unknown">CLI unavailable</small> : !row.providers?.length && <div className="account-provider-empty"><small className={`account-status ${row.status || 'unknown'}`}>{row.status === 'logged-out' ? 'No connected providers' : 'Provider status unavailable'}</small>{row.status !== 'logged-out' && <div className="account-actions"><button disabled={busy} onClick={() => void review(row.agent, 'logout')} aria-label="Sign out OpenCode">Sign out…</button></div>}</div>}
      {(row.providers || []).map((provider, index) => <div className="account-row" key={`${provider.provider}-${index}`}>
        <strong title={provider.label}>{provider.label}</strong><small className="account-status logged-in"><span aria-hidden="true">●</span> Logged in</small>
        <div className="account-actions">{provider.canLogout ? <button disabled={busy || !row.available} onClick={() => void review(row.agent, 'logout', provider.provider)} aria-label={`Sign out OpenCode · ${provider.label}`} title="Sign out"><Icon name="logout" size={14} /><span className="account-action-label">Sign out</span></button> : <small className="account-environment" title="Configured outside Mr. Mik; remove the environment credential in its original configuration">External setup</small>}</div>
      </div>)}
    </section> : <div className="account-row" key={row.agent}>
      <strong>{row.label}{row.agent === 'claude' && <AccountLimitsInfo agent="claude" />}</strong>
      <small className={`account-status ${!row.available ? 'unknown' : row.status || 'unknown'}`}><span aria-hidden="true">●</span> {!row.available ? 'CLI unavailable' : row.status === 'logged-in' ? 'Logged in' : row.status === 'logged-out' ? 'Not logged in' : 'Status unavailable'}</small>
      <div className="account-actions">{(row.label === 'OpenCode' || row.status !== 'logged-in') && <button disabled={busy || !row.available} onClick={() => void review(row.agent, 'login', row.provider)} aria-label={`Sign in ${row.label}`}>{row.label === 'OpenCode' ? 'Connect provider…' : 'Sign in'}</button>}{(row.label !== 'OpenCode' || row.status === 'unknown') && row.status !== 'logged-out' && row.canLogout !== false && <button disabled={busy || !row.available} onClick={() => void review(row.agent, 'logout', row.provider)} aria-label={`Sign out ${row.label}`} title="Sign out"><Icon name="logout" size={14} /><span className="account-action-label">Sign out</span></button>}</div>
    </div>)}</div>
    {message && <p role="status">{message}</p>}{error && <p className="desk-error-inline" role="alert">{error}</p>}
    {plan && <WorkspaceDialog label="Native account confirmation" busy={busy} close={() => setPlan(null)}>
      <div className="desk-dialog-heading"><h2>{plan.action === 'logout' ? 'Sign out' : 'Sign in'} · {plan.label}</h2><button className="desk-icon" disabled={busy} aria-label="Cancel account action" onClick={() => setPlan(null)}><Icon name="close" /></button></div>
      <p>Changes the shared CLI login on this PC. Chats and files are kept.</p>

      <p>Close apps using this account first. Environment credentials must be changed separately.</p>
      <p>Complete authentication in the terminal/browser, then reopen the affected chats.</p>
      <div className="portable-actions"><button disabled={busy} onClick={() => setPlan(null)}>Cancel</button><button disabled={busy} onClick={() => void confirm()}>Open native {plan.action === 'logout' ? 'sign-out' : 'sign-in'}</button></div>
    </WorkspaceDialog>}
  </section>
}
