import { IntermediateOutputContext } from './intermediateOutputContext'
import { useContext, useEffect, useRef, useState } from 'react'
import { api, useDesktop } from './client'
import { Icon } from './Icons'
import WorkspaceIconDialog from './WorkspaceIconDialog'
import { downloadImage, imageDownloadName } from '../lib/download'
import './chat-image-output.css'
import ChatImageViewer from './ChatImageViewer'
import { useChatPreviewPin, focusChatPreviewSource } from './useChatPreviewPin'
import ChatOutputActions from './ChatOutputActions'

export function GraphicalImage({ id, itemId, attachment, label = 'Agent image result', version, href, inline, input = false, resultRevision, runtimeId }: { id: string; itemId: string; attachment?: number; label?: string; version?: string | null; href?: string; inline?: boolean; input?: boolean; resultRevision?: string; runtimeId?: string }) {
  const intermediate = useContext(IntermediateOutputContext)
  const [result, setResult] = useState<{ url: string; name: string; identity?: string } | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [expanded, setExpanded] = useState(false)
  const state = useDesktop(), [iconOpen, setIconOpen] = useState(false), [dimensions, setDimensions] = useState(''), [actionError, setActionError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const presentation = useRef<HTMLElement>(null)
  useChatPreviewPin(expanded || iconOpen, trigger)
  useEffect(() => {
    let closed = false
    const element = presentation.current
    if (!element) return
    const route = href ? `/sessions/${id}/chatimage?href=${encodeURIComponent(href)}` : `/sessions/${id}/chatasset?item=${encodeURIComponent(itemId)}${attachment == null ? '' : `&attachment=${attachment}`}`
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void api<{ url: string; name: string; identity?: string }>(route + '&stream=true' + (resultRevision ? `&resultRevision=${encodeURIComponent(resultRevision)}&runtimeId=${encodeURIComponent(runtimeId || '')}` : '')).then(value => { if (!closed) { setResult(value); setError('') } }, cause => { if (!closed) setError(cause.message) })
    }, { rootMargin: '160px' })
    observer.observe(element)
    return () => { closed = true; observer.disconnect() }
  }, [id, itemId, attachment, version, attempt, href, resultRevision, runtimeId])
  const Container = inline ? 'span' : 'div'
  return <Container ref={element => { presentation.current = element }} className={`graphical-image${intermediate ? ' intermediate-image' : ''}`}>{result && !error ? <><button ref={trigger} type="button" aria-label="Expand image" onClick={() => setExpanded(true)}><img src={result.url} alt={label} onLoad={event => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setError('This image could not be displayed.')} /></button>{!input && itemId !== 'draft' && itemId !== 'markdown' && <span className="chat-image-footer"><span className="chat-image-dimensions" title={result.name}>{dimensions}</span><ChatOutputActions image preview viewIdentity={result.identity} sessionId={id} reference={{ itemId, href, index: attachment }} /><button type="button" aria-label="Save chat image" title="Save image" onClick={() => void downloadImage(result.url, imageDownloadName(result.url, result.name)).catch(cause => setActionError(cause.message))}><Icon name="download" size={14} /></button>{!intermediate && state.projects.length > 0 && <button type="button" aria-label="Use image as workspace icon" title="Use as workspace icon" onClick={() => setIconOpen(true)}><Icon name="image" size={14} /></button>}{actionError && <span role="alert">{actionError}</span>}</span>}{iconOpen && <WorkspaceIconDialog projectId={state.sessions.find(session => session.id === id)?.projectId || state.settings.selectedProjectId || state.projects[0]?.id || ''} initialImage={result.url} close={() => { setIconOpen(false); focusChatPreviewSource(trigger.current) }} />}{expanded && <ChatImageViewer stateKey={result.identity || `${id}:${itemId}:${attachment ?? href ?? 'result'}`} returnFocus={() => focusChatPreviewSource(trigger.current)} url={result.url} name={result.name} onClose={() => setExpanded(false)} />}</> : <span>{error || 'Loading image…'}{error && <button type="button" onClick={() => { setError(''); setAttempt(value => value + 1) }}>Retry preview</button>}</span>}</Container>
}
export function GraphicalFile({ id, itemId, index, name, kind }: { id: string; itemId: string; index: number; name: string; kind?: string }) {
  const intermediate = useContext(IntermediateOutputContext)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  if (intermediate) return <span className="graphical-step-file-path" title={name}>{name.split(/[\\/]/).pop()}</span>
  const reference = { itemId, index, kind }
  const download = () => {
    setBusy(true); setError('')
    void api<{ url: string; name: string; identity?: string }>(`/sessions/${id}/chatfile?item=${encodeURIComponent(itemId)}&attachment=${index}${kind ? `&kind=${kind}` : ''}`).then(result => { const link = document.createElement('a'); link.href = result.url; link.download = result.name; link.click() }, cause => setError(cause.message)).finally(() => setBusy(false))
  }
  return <span className="graphical-file"><button type="button" title="Open in Workspace" disabled={busy} onClick={() => {
    setBusy(true); setError('')
    void api(`/sessions/${id}/output`, { ...reference, action: 'open' }).catch(cause => setError(cause.message)).finally(() => setBusy(false))
  }}><Icon name="files" size={14} />{name.split(/[\\/]/).pop()}</button><ChatOutputActions sessionId={id} reference={reference} download={busy ? undefined : download} />{error && <span role="alert">{error}</span>}</span>
}
