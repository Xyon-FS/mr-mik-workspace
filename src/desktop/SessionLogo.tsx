import { AgentLogo, Icon } from './Icons'
import { chatActivityLabel } from './chatActivity'
import type { ChatSession } from './types'

export default function SessionLogo({ session, size = 17, combined = false, feedback = true }: { session: ChatSession; size?: number; combined?: boolean; feedback?: boolean }) {
  const working = session.status === 'running' && session.activity === 'working'
  return <span className={`session-logo ${working ? 'is-working' : ''} ${combined ? 'combined-session-logo' : ''}`} style={{ width: size + (combined ? 12 : 0), height: size + (combined ? 9 : 0) }} title={`${session.agent} · ${session.chatInterface === 'chat' ? 'Chat' : 'CLI'} · ${chatActivityLabel(session)}`} aria-hidden="true">
    <AgentLogo agent={session.agent} size={size} />
    {combined && <span className="session-interface-symbol" data-interface={session.chatInterface === 'chat' ? 'chat' : 'cli'}><Icon name={session.chatInterface === 'chat' ? 'chats' : 'terminal'} size={12} /></span>}
    {feedback && session.unread && <i className="session-unread" />}
    {feedback && !session.unread && session.activity === 'waiting' && <i className="session-waiting">!</i>}
  </span>
}
