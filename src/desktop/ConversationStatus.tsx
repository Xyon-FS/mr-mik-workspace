import type { ChatSession } from './types'
import { Icon } from './Icons'
import { chatActivityLabel } from './chatActivity'

export default function ConversationStatus({ session }: { session: ChatSession }) {
  const working = session.status === 'running' && session.activity === 'working'
  const waiting = session.status === 'running' && session.activity === 'waiting'
  const completed = session.status !== 'starting' && !working && !waiting && session.unread
  const label = chatActivityLabel(session)
  return <span className={`conversation-status-icon ${working ? 'working' : waiting ? 'waiting' : completed ? 'completed' : ''}`} role="img" aria-label={label} title={label}>{working ? <i className="conversation-round-loader" /> : waiting ? <Icon name="question" size={14} /> : completed ? <Icon name="check" size={14} /> : session.status === 'starting' ? <i className="conversation-round-loader" /> : null}</span>
}
