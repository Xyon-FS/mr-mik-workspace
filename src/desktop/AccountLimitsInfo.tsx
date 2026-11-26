import { useEffect, useId, useRef, useState } from 'react'
import { api, onServiceEvent } from './client'
import { Icon } from './Icons'

type Limits = { windows: { label: string; percent: number | null; resetsAt: string | null }[]; note: string; updatedAt?: number; stale?: boolean }
export default function AccountLimitsInfo({ agent, profileId }: { agent: 'codex' | 'claude'; profileId?: string }) {
  const scope = `${agent}:${profileId || 'system'}`
  const id = useId(), pending = useRef(new Set<string>()), epoch = useRef(0), current = useRef<string | null>(scope), [openScope, setOpenScope] = useState<string | null>(null), [result, setResult] = useState<{ scope: string; data: Limits } | null>(null)
  useEffect(() => { current.current = scope; return () => { current.current = null } }, [scope])
  useEffect(() => onServiceEvent(event => { if (event.type === 'accounts-changed') { epoch.current++; setResult(null); setOpenScope(null) } }), [])
  const open = openScope === scope, data = result?.scope === scope ? result.data : null
  const show = () => {
    setOpenScope(scope)
    const generation = epoch.current, requestKey = `${scope}:${generation}`
    if (pending.current.has(requestKey)) return
    pending.current.add(requestKey)
    const save = (data: Limits) => { if (current.current === scope && epoch.current === generation) setResult({ scope, data }) }
    void api<Limits>(`/accounts/limits?agent=${agent}${profileId ? `&profileId=${encodeURIComponent(profileId)}` : ''}`).then(save).catch(() => save({ windows: [], note: 'Account limits unavailable.' })).finally(() => { pending.current.delete(requestKey) })
  }
  return <span className="account-limits-info" onMouseEnter={show} onMouseLeave={() => setOpenScope(null)}>
    <button type="button" className="desk-icon" aria-label={`${agent === 'codex' ? 'Codex' : 'Claude'} account limits`} aria-describedby={open ? id : undefined} onFocus={show} onBlur={() => setOpenScope(null)} onClick={show} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpenScope(null) } }}><Icon name="info" size={13} /></button>
    {open && <span id={id} role="tooltip" popover="manual" ref={node => { if (!node) return; const anchor = node.parentElement?.getBoundingClientRect(); if (anchor) { node.style.position = 'fixed'; node.style.inset = 'auto'; node.style.margin = '0'; node.style.left = Math.max(8, Math.min(anchor.left - 200, window.innerWidth - 248)) + 'px'; node.style.top = Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - 130)) + 'px' } node.showPopover?.() }} className="account-limits-tooltip">{!data ? <span>Checking usage…</span> : data.windows.length ? data.windows.map((row, index) => <span key={index}>{row.label}: {row.percent == null ? 'Usage unavailable' : `${row.percent}% used`}<small>{row.resetsAt ? `Resets ${new Date(row.resetsAt).toLocaleString()}` : 'Reset unavailable'}</small></span>) : <span>Usage unavailable</span>}</span>}
  </span>
}
