import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onServiceEvent } from './client'
import type { AccountProfile } from './AccountProfileSelect'

// Names come from the local registry; native status remains authoritative and
// is fetched separately. A late focus/login request must not replace newer rows.
export default function useAccountInventory(agent: 'codex' | 'claude') {
  const [rows, setRows] = useState<AccountProfile[]>([])
  const [error, setError] = useState('')
  const generation = useRef(0), mounted = useRef(false)
  const endpoint = agent === 'codex' ? '/accounts/profiles' : '/accounts/claude-profiles'
  const refresh = useCallback(async () => {
    const request = ++generation.current
    let detailed = false, failed = false
    const current = () => mounted.current && generation.current === request
    const filter = (values: AccountProfile[]) => values.filter(row => agent === 'claude' || !row.system)
    void api<AccountProfile[]>(endpoint + '?status=false').then(values => {
      if (current() && (!detailed || failed)) setRows(previous => {
        const known = new Map(previous.map(row => [row.id, row]))
        return filter(values).map(row => ({ ...known.get(row.id), ...row, ...(!known.has(row.id) || failed ? { statusPending: !detailed, available: false } : {}) }))
      })
    }).catch(() => {})
    try {
      const values = await api<AccountProfile[]>(endpoint)
      detailed = true
      if (current()) { setRows(filter(values)); setError('') }
    } catch (cause) {
      detailed = true; failed = true
      if (current()) { setError(`${agent === 'codex' ? 'Codex accounts' : 'Claude profiles'} unavailable.`); setRows(values => values.map(row => ({ ...row, statusPending: false, available: false }))) }
      throw cause
    }
  }, [agent, endpoint])
  useEffect(() => {
    mounted.current = true
    const update = () => { void refresh().catch(() => {}) }
    const unsubscribe = onServiceEvent(event => { if (event.type === 'accounts-changed') update() })
    update(); window.addEventListener('focus', update)
    return () => { mounted.current = false; unsubscribe(); window.removeEventListener('focus', update) }
  }, [refresh])
  return { rows, error, setError, refresh }
}
