import type { ChatSession } from './types'

export function chatActivityLabel(session: ChatSession) {
  const working = session.status === 'running' && session.activity === 'working'
  if (session.status === 'running' && session.activity === 'waiting') return session.unread ? 'Needs attention · unread result' : 'Needs attention · check terminal'
  if (session.unread) return working ? 'Working · unread result' : 'Finished · unread result'
  if (working) return 'Working'
  if (session.status !== 'running') return session.status === 'starting' ? 'Starting' : 'Stopped'
  return ['codex', 'claude'].includes(session.agent) ? 'Ready' : 'Terminal open'
}
