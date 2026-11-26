import { useEffect, useRef, useState } from 'react'
import { api } from './client'
import ChatMarkdown from './ChatMarkdown'

export type Subagent = { id: string; name: string; role?: string; task?: string; status: string; message?: string; parentId?: string | null }
type Transcript = Subagent & { items: { id: string; type: string; text?: string; details?: string; status?: string }[] }
const stateLabel = (value: string) => ({ running: 'Working', inProgress: 'Working', active: 'Working', pendingInit: 'Starting', completed: 'Completed', failed: 'Failed', errored: 'Failed', stopped: 'Stopped', interrupted: 'Stopped', shutdown: 'Closed', unavailable: 'Live status unavailable', notFound: 'Unavailable', idle: 'Idle', unknown: 'Status unavailable' } as Record<string, string>)[value] || value

export default function SubagentsPanel({ sessionId, runtimeId, agents, connected }: { sessionId: string; runtimeId?: string; agents: Subagent[]; connected: boolean }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(''), [data, setData] = useState<Transcript | null>(null)
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const view = useRef<HTMLDivElement>(null), following = useRef(true)
  const id = agents.some(agent => agent.id === selected) ? selected : agents[0]?.id
  const current = agents.find(agent => agent.id === id)
  useEffect(() => {
    if (!open || !id || !connected) return
    let active = true, timer = 0
    const refresh = async () => {
      if (document.hidden) { timer = window.setTimeout(refresh, 2000); return }
      try {
        const next = await api<Transcript>(`/sessions/${sessionId}/chat`, { action: 'agent-read', threadId: id, runtimeId })
        if (active) { setData(next); setError(''); if (following.current) requestAnimationFrame(() => { if (active && view.current) view.current.scrollTop = view.current.scrollHeight }) }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)) }
      finally { if (active) timer = window.setTimeout(refresh, 2000) }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [sessionId, runtimeId, id, open, connected, attempt])
  if (!agents.length) return null
  const transcript = data?.id === id ? data : null
  const displayed = agents.map(agent => agent.id === transcript?.id ? { ...agent, name: transcript.name, status: transcript.status } : agent)
  const working = displayed.filter(agent => ['running', 'inProgress', 'active', 'pendingInit'].includes(agent.status)).length
  const completed = displayed.filter(agent => agent.status === 'completed').length
  return <section className="subagents-panel" aria-label="Subagents">
    <button type="button" className="subagents-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}><strong>Subagents · {agents.length}</strong><span>{working} working · {completed} completed</span><span aria-hidden="true">{open ? '▾' : '▸'}</span></button>
    {open && <div className="subagents-content">
      <div className="subagents-tabs" role="tablist" aria-label="Subagent conversations">{displayed.map(agent => <button type="button" role="tab" aria-selected={id === agent.id} tabIndex={id === agent.id ? 0 : -1} onKeyDown={event => { const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']; if (!keys.includes(event.key)) return; event.preventDefault(); const current = displayed.findIndex(value => value.id === agent.id); const next = event.key === 'Home' ? 0 : event.key === 'End' ? displayed.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + displayed.length) % displayed.length; following.current = true; setSelected(displayed[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus() }} key={agent.id} title={agent.task || agent.message} onClick={() => { following.current = true; setSelected(agent.id); setError('') }}>{agent.name || `Agent ${agent.id.slice(0, 8)}`}<small>{stateLabel(agent.status)}</small></button>)}</div>
      <header><div><strong>{transcript?.name || current?.name}</strong><small>{current?.role}{current?.task && ` · ${current.task}`}</small></div><span>Read only</span><button type="button" onClick={() => setAttempt(value => value + 1)} disabled={!connected}>Refresh subagent</button></header>
      {!connected && <p role="status">Connection lost. Showing last recorded activity.</p>}
      {error && <p role="status">Live updates unavailable: {error}</p>}
      <div ref={view} className="subagents-transcript" aria-label="Subagent transcript" onScroll={event => { const element = event.currentTarget; following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28 }}>
        {!transcript ? <p>{connected ? 'Loading recorded activity…' : 'Reconnect the parent chat to inspect recorded activity.'}</p> : <>{transcript.items.filter(item => item.type !== 'reasoning').map(item => <article key={item.id}><small>{item.type === 'userMessage' ? 'Instruction' : item.type === 'agentMessage' ? 'Agent' : 'Activity'}{item.status && ` · ${stateLabel(item.status)}`}</small><ChatMarkdown sessionId={sessionId} text={item.text || item.details || ''} query="" openLocal={() => setError('Open project files from the parent conversation.')} /></article>)}{!transcript.items.length && <p>{current?.message || 'No recorded messages yet.'}</p>}</>}
      </div>
      <small className="subagents-note">Up to 50 recent items. Updates automatically while open. The agent continues under its parent chat.</small>
    </div>}
  </section>
}
