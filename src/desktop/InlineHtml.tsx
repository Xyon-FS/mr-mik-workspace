import { useEffect, useRef, useState } from 'react'
import { api } from './client'
import { retainChatPreview } from './useChatPreviewPin'
import { useHtmlPreviewStatus } from './useHtmlPreviewStatus'
export default function InlineHtml({ source, text, language, visualizePath }: { source: { sessionId: string; itemId: string }; text?: string; language?: string; visualizePath?: string }) {
  const root = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null)
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const [workspaceOnly, setWorkspaceOnly] = useState(false)
  const { timedOut, errors } = useHtmlPreviewStatus(frame, url, attempt)
  const retry = () => { setUrl(''); setError(''); setAttempt(value => value + 1) }
  useEffect(() => {
    let active = true, requested = false
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || requested) return
      requested = true
      const input = visualizePath ? { kind: 'visualize', visualizePath } : { kind: 'code', text, language }
      void api<{ interactiveUrl?: string; workspaceOnly?: boolean }>(`/sessions/${source.sessionId}/previewblock`, { ...input, inline: true, itemId: source.itemId }).then(value => {
        if (!active) return
        setWorkspaceOnly(!!value.workspaceOnly)
        setUrl(value.interactiveUrl || '')
        setError('')
      }, cause => { if (active) setError(cause.message) })
    }, { rootMargin: '100px' })
    if (root.current) observer.observe(root.current)
    return () => { active = false; observer.disconnect() }
  }, [source.sessionId, source.itemId, text, language, visualizePath, attempt])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'mr-mik-preview') return
      const view = root.current?.closest('.graphical-messages')
      if (event.data.kind === 'interact') {
        retainChatPreview(root.current)
        view?.dispatchEvent(new CustomEvent('graphical-content-interaction', { detail: { held: event.data.message === 'held' } }))
      }
      if (event.data.kind === 'release') view?.dispatchEvent(new Event('graphical-content-release'))
      if (event.data.kind === 'wheel' && Number.isFinite(event.data.deltaY)) view?.dispatchEvent(new CustomEvent('graphical-content-wheel', { detail: Math.max(-1000, Math.min(1000, event.data.deltaY)) }))
    }
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive)
  }, [])
  return <div ref={root} className="inline-html-preview" aria-label="Inline HTML preview">
    {workspaceOnly ? <p className="chat-preview-workspace-only">This visualization exceeds the 1 MB inline limit. Open it in Workspace to view it.</p> : <>
      {(error || timedOut) && <div className="chat-preview-error" role="alert">Preview unavailable. <button type="button" onClick={retry}>Retry preview</button><small>{error || 'The HTML preview did not respond.'}</small></div>}
      {!!errors.length && !timedOut && <details className="inline-html-diagnostics"><summary>Preview diagnostics · {errors.length}</summary>{errors.map((message, index) => <pre key={index}>{message}</pre>)}</details>}
      {url ? <iframe hidden={!!timedOut} onFocus={() => { retainChatPreview(root.current); root.current?.closest('.graphical-messages')?.dispatchEvent(new Event('graphical-content-interaction')) }} ref={frame} title="Inline interactive HTML" src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" /> : !error && <p role="status">Loading preview…</p>}
    </>}
  </div>
}
