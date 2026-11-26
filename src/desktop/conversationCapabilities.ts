import type { ChatSession } from './types'

export function canForkConversation(session: ChatSession) {
  return ['codex', 'claude', 'opencode'].includes(session.agent) && !!session.nativeId && session.activity === 'idle' && session.status !== 'starting' && !(session.agent === 'claude' && session.chatInterface === 'chat') && !(session.agent === 'codex' && session.chatInterface === 'chat' && session.hasConversation === false)
}
