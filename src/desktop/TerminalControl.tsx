import { useRef, useState } from 'react'
import { api, reportError, useDesktop } from './client'
import { Icon } from './Icons'
import type { ChatSession } from './types'
import './terminal-controls.css'

export default function TerminalControl({ session }: { session: ChatSession }) {
  const { connected } = useDesktop()
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const working = session.activity === 'working'
  if (!['codex', 'claude'].includes(session.agent)) return null
  const control = async () => {
    if (locked.current) return
    locked.current = true; setBusy(true)
    try {
      await api(`/sessions/${session.id}/control`, { action: working ? 'interrupt' : 'submit' })
      window.dispatchEvent(new CustomEvent('mrmak-focus-terminal', { detail: session.id }))
    } catch (cause) { reportError(cause instanceof Error ? cause.message : String(cause)) }
    finally { locked.current = false; setBusy(false) }
  }
  return <button className="desk-icon terminal-turn-control" title={working ? 'Interrupt response · does not undo changes' : 'Send typed CLI prompt'} aria-label={working ? 'Interrupt response' : 'Send typed CLI prompt'} disabled={busy || !connected || session.status !== 'running' || !working && session.attention} onMouseDown={event => event.preventDefault()} onClick={() => void control()}><Icon name={working ? 'stop' : 'send'} size={17} /></button>
}
