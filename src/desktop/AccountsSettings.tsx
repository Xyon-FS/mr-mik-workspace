import { useEffect, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'

type AccountRow = { agent: string; label: string; available: boolean; provider?: string; canLogout?: boolean; providers?: { provider: string; label: string; status: 'logged-in'; canLogout: boolean }[]; status?: 'logged-in' | 'logged-out' | 'unknown' }
type AccountPlan = { token: string; agent: string; label: string; action: 'login' | 'logout' }
export default function AccountsSettings() {
  const [rows, setRows] = useState<AccountRow[]>([])
  const [plan, setPlan] = useState<AccountPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true, pending = false
    const refresh = async () => { if (pending) return; pending = true; try { const data = await api<AccountRow[]>('/accounts'); if (active) setRows(data) } catch { if (active) setError('Native account controls unavailable.') } finally { pending = false } }
    void refresh(); window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [])
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
  return <section className="accounts-settings"><h3>Accounts</h3><p>Native CLI accounts · credentials stay outside Mr. Mik.</p>
    <div className="account-list">{rows.map(row => row.agent === 'opencode' ? <section className="account-provider-group" key={row.agent} aria-label="OpenCode providers">
      <div className="account-provider-heading"><strong>OpenCode</strong><button className="desk-icon account-connect" disabled={busy || !row.available} onClick={() => void review(row.agent, 'login')} aria-label="Connect OpenCode provider" title="Connect provider"><Icon name="plus" size={15} /></button></div>
      {!row.available ? <small className="account-status unknown">CLI unavailable</small> : !row.providers?.length && <div className="account-provider-empty"><small className={`account-status ${row.status || 'unknown'}`}>{row.status === 'logged-out' ? 'No connected providers' : 'Provider status unavailable'}</small>{row.status !== 'logged-out' && <div className="account-actions"><button disabled={busy} onClick={() => void review(row.agent, 'logout')} aria-label="Sign out OpenCode">Sign out…</button></div>}</div>}
      {(row.providers || []).map((provider, index) => <div className="account-row" key={`${provider.provider}-${index}`}>
        <strong title={provider.label}>{provider.label}</strong><small className="account-status logged-in"><span aria-hidden="true">●</span> Logged in</small>
        <div className="account-actions">{provider.canLogout ? <button disabled={busy || !row.available} onClick={() => void review(row.agent, 'logout', provider.provider)} aria-label={`Sign out OpenCode · ${provider.label}`}>Sign out</button> : <small className="account-environment" title="Configured outside Mr. Mik; remove the environment credential in its original configuration">External setup</small>}</div>
      </div>)}
    </section> : <div className="account-row" key={row.agent}>
      <strong>{row.label}</strong>
      <small className={`account-status ${!row.available ? 'unknown' : row.status || 'unknown'}`}><span aria-hidden="true">●</span> {!row.available ? 'CLI unavailable' : row.status === 'logged-in' ? 'Logged in' : row.status === 'logged-out' ? 'Not logged in' : 'Status unavailable'}</small>
      <div className="account-actions">{(row.label === 'OpenCode' || row.status !== 'logged-in') && <button disabled={busy || !row.available} onClick={() => void review(row.agent, 'login', row.provider)} aria-label={`Sign in ${row.label}`}>{row.label === 'OpenCode' ? 'Connect provider…' : 'Sign in'}</button>}{(row.label !== 'OpenCode' || row.status === 'unknown') && row.status !== 'logged-out' && row.canLogout !== false && <button disabled={busy || !row.available} onClick={() => void review(row.agent, 'logout', row.provider)} aria-label={`Sign out ${row.label}`}>Sign out</button>}</div>
    </div>)}</div>
    {message && <p role="status">{message}</p>}{error && <p className="desk-error-inline" role="alert">{error}</p>}
    {plan && <div className="desk-scrim" onClick={() => { if (!busy) setPlan(null) }}><div className="desk-dialog history-delete-dialog" role="dialog" aria-modal="true" aria-label="Native account confirmation" onClick={event => event.stopPropagation()}>
      <div className="desk-dialog-heading"><h2>{plan.action === 'logout' ? 'Sign out' : 'Sign in'} · {plan.label}</h2><button className="desk-icon" disabled={busy} aria-label="Cancel account action" onClick={() => setPlan(null)}><Icon name="close" /></button></div>
      <p>This changes the shared native CLI account on this PC, including use outside Mr. Mik. Chats and project files are not deleted.</p>
      <p>Status is read locally; it does not verify subscription, token expiry or regional model access. Native output and credentials are never saved in Mr. Mik.</p>
      <p>Close other applications using this account first. Environment/API-key settings can override saved logins and cannot be removed here. OpenCode V1 uses its native provider picker when no reliable provider ID is available.</p>
      <p>The terminal and browser handle authentication directly. Do not paste credentials into a chat. Finish the command, then reopen chats; Mik may also need an app restart to use the new Codex login.</p>
      <div className="portable-actions"><button disabled={busy} onClick={() => setPlan(null)}>Cancel</button><button disabled={busy} onClick={() => void confirm()}>Open native {plan.action === 'logout' ? 'sign-out' : 'sign-in'}</button></div>
    </div></div>}
  </section>
}
