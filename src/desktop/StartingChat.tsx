import { useLayoutEffect, useRef } from 'react'
import type { ChatSession } from './types'
import useChatDraft from './useChatDraft'
import GraphicalDraftInput from './GraphicalDraftInput'
import { GraphicalComposer } from './GraphicalChatChrome'
import './graphical-chat.css'

export default function StartingChat({ session }: { session: ChatSession }) {
  const { draft } = useChatDraft(session.id, false)
  const input = useRef<HTMLTextAreaElement>(null)
  const provider = session.agent === 'codex' ? 'Codex' : 'Claude'
  useLayoutEffect(() => () => {
    // Preserve typing focus when the ready composer replaces this draft surface.
    const previous = input.current
    if (!previous || document.activeElement !== previous) return
    const start = previous.selectionStart, end = previous.selectionEnd
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return
      const next = document.querySelector<HTMLTextAreaElement>('.graphical-chat textarea')
      next?.focus(); next?.setSelectionRange(start, end)
    })
  }, [])
  return <section className="graphical-chat" aria-label={`${provider} starting chat`}>
    <div className="graphical-messages" />
    <GraphicalComposer onSubmit={event => event.preventDefault()}>
      <div className="graphical-composer-input"><GraphicalDraftInput draft={draft} inputRef={input} autoFocus aria-label={`Message ${provider}`} placeholder={`Write a draft while ${provider} starts…`} maxLength={64000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) event.preventDefault() }} /></div>
      <div className="graphical-controls"><small role="status">Preparing {provider}…</small><div className="graphical-utilities"><button type="button" className="graphical-primary-action" aria-label="Send message" disabled>↑</button></div></div>
    </GraphicalComposer>
  </section>
}
