import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api, selectChat, reportError, desktopState } from './client'
import { Icon } from './Icons'
import { messageActionRequest, completeMessageAction } from './messageActionRequest'

export function MessageTextActions({ text, user, quote }: {
  text: string; user: boolean; quote?: (text: string) => Promise<void>
}) {
  const [copyStatus, setCopyStatus] = useState('')
  const [quoteError, setQuoteError] = useState('')
  const quoting = useRef(false)
  const copying = useRef(false)
  useEffect(() => {
    if (copyStatus !== 'Copied') return
    const timer = window.setTimeout(() => setCopyStatus(''), 2200)
    return () => window.clearTimeout(timer)
  }, [copyStatus])

  const copy = async () => {
    if (copying.current) return
    copying.current = true
    setCopyStatus('')
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('Copied')
    } catch {
      setCopyStatus('Copy unavailable')
    } finally { copying.current = false }
  }

  const cite = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!quote || quoting.current) return
    const selected = window.getSelection()
    const content = event.currentTarget.closest('article')?.querySelector('.graphical-message-text')
    const range = selected?.rangeCount ? selected.getRangeAt(0) : null
    const inMessage = range && content?.contains(range.startContainer) && content.contains(range.endContainer)
    if (range && !range.collapsed && content && range.intersectsNode(content) && !inMessage) {
      setQuoteError('Select text within one message to quote it.')
      return
    }
    const excerpt = inMessage ? range.toString().trim() : ''
    const quotation = excerpt || text.trim()
    if (quotation.length > 8000) {
      setQuoteError('Select a shorter passage to quote (up to 8,000 characters).')
      return
    }
    quoting.current = true
    setQuoteError('')
    try {
      await quote(quotation)
      if (range && selected?.rangeCount && selected.getRangeAt(0) === range) selected.removeAllRanges()
    } catch (cause) {
      setQuoteError(cause instanceof Error ? cause.message : String(cause))
    } finally { quoting.current = false }
  }

  if (!text.trim()) return null
  return <>
    {quote && <button type="button" aria-label="Quote message" title="Quote selected text or the whole message" onMouseDown={event => event.preventDefault()} onClick={event => void cite(event)}><Icon name="quote" size={14} /></button>}
    <button type="button" aria-label={user ? 'Copy your message' : 'Copy response'} title={copyStatus || 'Copy'} onClick={() => void copy()}><Icon name={copyStatus === 'Copied' ? 'check' : 'files'} size={14} /></button>
    <span className="message-copy-status" role="status">{copyStatus === 'Copied' ? copyStatus : ''}</span>
    {copyStatus === 'Copy unavailable' && <span role="alert">Copy unavailable. Select the text to copy it.</span>}
    {quoteError && <span className="graphical-message-action-error" role="alert">{quoteError}</span>}
  </>
}

export default function GraphicalMessageActions({ sessionId, itemId, user, disabled, runtimeId }: { sessionId: string; itemId: string; user: boolean; disabled: boolean; runtimeId?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const active = useRef(false), locked = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const act = async (kind: 'branch' | 'edit' | 'retry') => {
    if (locked.current || busy || disabled) return
    locked.current = true
    setBusy(true); setError('')
    try {
      const requestId = messageActionRequest(sessionId, itemId, kind)
      const result = await api<{ session: { id: string }; notice: string }>(`/sessions/${sessionId}/messageaction`, { kind, itemId, requestId, runtimeId })
      completeMessageAction(sessionId, itemId, kind, requestId)
      // Native completion may outlive the source view. Do not override a newer
      // explicit navigation when an older HTTP response eventually arrives.
      if (active.current && desktopState().selectedId === sessionId) {
        selectChat(result.session.id)
        if (result.notice) reportError(result.notice)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { locked.current = false; if (active.current) setBusy(false) }
  }
  return <>{user ? <button type="button" disabled={disabled || busy} aria-label="Edit and branch" title="Edit in a new branch · original conversation and files are preserved" onClick={() => void act('edit')}><Icon name="fork" size={14} /></button> : <><button type="button" disabled={disabled || busy} aria-label="Branch from this response" title="Branch from here · opens a new chat without sending a message" onClick={() => void act('branch')}><Icon name="fork" size={14} /></button><button type="button" disabled={disabled || busy} aria-label="Retry response in a new chat" title="Retry in a new chat · starts a new model response; does not undo file changes" onClick={() => void act('retry')}><Icon name="refresh" size={14} /></button></>}{error && <span className="graphical-message-action-error" role="alert">{error}</span>}</>
}
