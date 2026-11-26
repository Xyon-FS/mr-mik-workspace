import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { api } from './client'
import { Icon } from './Icons'

type Conversation = { messages: { id: string; role: string; text: string; clipped: boolean }[]; status: string; truncated: boolean; connectionIssue?: { message: string; details: string } }

// Keep the component type stable across polls and composer updates. Defining
// this renderer inline remounts tables, losing scrollLeft and keyboard focus.
const markdownComponents: Components = {
  table: ({ children }) => <div className="compact-table-scroll" role="region" aria-label="Message table" tabIndex={0}><table>{children}</table></div>,
}

export default function CompactConversation({ id, working, connected, running, fontSize, draft, setDraft }: { id: string; working: boolean; connected: boolean; running: boolean; fontSize: number; draft: string; setDraft: (text: string) => void }) {
  const [data, setData] = useState<Conversation | null>(null)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [sending, setSending] = useState(false)
  const lock = useRef(false)
  const view = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    let closed = false, timer = 0
    const poll = async () => {
      try {
        const result = await api<Conversation>(`/sessions/${id}/conversation`)
        if (!closed) { setData(result); setPollError('') }
      } catch (cause) { if (!closed) setPollError(cause instanceof Error ? cause.message : String(cause)) }
      finally { if (!closed) timer = window.setTimeout(poll, 2000) }
    }
    void poll()
    return () => { closed = true; clearTimeout(timer) }
  }, [id])
  useEffect(() => { if (follow.current && view.current) view.current.scrollTop = view.current.scrollHeight }, [data, working])
  const submit = async () => {
    if (lock.current || !draft.trim() || !connected || !running) return
    lock.current = true; setSending(true); setError('')
    try { await api(`/sessions/${id}/compactinput`, { text: draft }); setDraft('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { lock.current = false; setSending(false) }
  }
  const stop = async () => {
    if (lock.current) return
    lock.current = true; setSending(true)
    try { await api(`/sessions/${id}/control`, { action: 'interrupt' }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { lock.current = false; setSending(false) }
  }
  return <section className="compact-conversation" aria-label="Compact conversation" style={{ fontSize }}>
    <div className="compact-messages" ref={view} onScroll={() => { const el = view.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}>
      {!data ? <p>Loading conversation…</p> : <>
        {data.truncated && <p className="desk-muted">Showing a bounded recent excerpt. Full history remains in the native conversation.</p>}
        {!data.messages.length && <p className="desk-muted">{data.status === 'waiting' ? 'Waiting for the native conversation ID…' : 'No saved text messages yet.'}</p>}
        {data.messages.map(message => <article key={message.id} className={`compact-message ${message.role}`}><span className="compact-marker" aria-hidden="true">{message.role === 'user' ? '›' : '•'}</span><div><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.text}</ReactMarkdown>{message.clipped && <p className="desk-muted">Long message shortened · show operations for details.</p>}</div></article>)}
      </>}
      {working && <p className="compact-working" role="status">Working…</p>}
    </div>
    {error && <p className="compact-error" role="alert">{error}</p>}
    {pollError && <p className="compact-error" role="alert">{pollError}</p>}
    {data?.connectionIssue && <p className="compact-error" role="alert">{data.connectionIssue.message}<br />{data.connectionIssue.details}<br />Open the native terminal to inspect the error and retry; the request has not been resent.</p>}
    <form className="compact-composer" onSubmit={event => { event.preventDefault(); void submit() }}>
      <span aria-hidden="true">›</span><textarea aria-label="Message Codex" placeholder="Ask Codex to do anything" value={draft} disabled={sending} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
      <button className="desk-icon" type={working ? 'button' : 'submit'} aria-label={working ? 'Interrupt response' : 'Send message'} title={working ? 'Interrupt response · Enter queues your message' : 'Send message · Shift+Enter for a new line'} disabled={sending || !connected || !running || !working && !draft.trim()} onClick={working ? () => void stop() : undefined}><Icon name={working ? 'stop' : 'send'} size={17} /></button>
    </form>
  </section>
}
