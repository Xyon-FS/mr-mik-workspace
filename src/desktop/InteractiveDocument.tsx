import { useEffect, useRef, useState } from 'react'
import ChatMarkdown from './ChatMarkdown'
import { codeFence } from './previewDownloads'
import type { Preview } from './types'
import { Icon } from './Icons'
import { PreviewOptions } from './PreviewChrome'
import { api } from './client'
import { useHtmlPreviewStatus } from './useHtmlPreviewStatus'

export default function InteractiveDocument({ file }: { file: Preview }) {
  const [source, setSource] = useState(false), [reload, setReload] = useState(0), [width, setWidth] = useState('fluid'), [height, setHeight] = useState('auto')
  const frame = useRef<HTMLIFrameElement>(null), [url, setUrl] = useState(file.interactiveUrl || '')
  const [resetting, setResetting] = useState(false), [error, setError] = useState('')
  const { ready, timedOut, errors, clearErrors } = useHtmlPreviewStatus(frame, url, reload)
  const reset = async () => {
    setResetting(true); setError('')
    try {
      if (file.source) {
        const input = file.source.visualizePath ? { kind: 'visualize', visualizePath: file.source.visualizePath, identity: file.identity } : {
          kind: 'code', language: file.language, text: file.originalHtml ?? file.text, bundle: file.originalHtml != null,
        }
        const preview = await api<{ interactiveUrl: string }>(`/sessions/${file.source.sessionId}/previewblock`, {
          ...input, inline: true, itemId: file.source.itemId,
        })
        setUrl(preview.interactiveUrl)
      }
      setReload(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setResetting(false) }
  }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'mr-mik-preview') return
      if (event.data.kind === 'wheel' && Number.isFinite(event.data.deltaY)) frame.current?.closest('.file-preview-body')?.scrollBy({ top: Math.max(-1000, Math.min(1000, event.data.deltaY)), behavior: 'instant' })
    }
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive)
  }, [])
  const state = resetting ? 'Reloading…' : error || timedOut ? 'Preview unavailable' : ready ? 'Preview ready' : 'Loading…'
  return <section className="interactive-document" aria-label="Interactive HTML document">
    <nav className="preview-document-toolbar" aria-label="Document views">
      <div className="preview-segmented"><button type="button" aria-pressed={!source} onClick={() => setSource(false)}>Preview</button><button type="button" aria-pressed={source} onClick={() => setSource(true)}>Code</button></div>
      <label className="preview-toolbar-label"><Icon name="workspace" size={14} /><select aria-label="Preview viewport" value={width} onChange={event => setWidth(event.target.value)}><option value="fluid">Fit workspace</option><option value="390">Phone · 390px</option><option value="768">Tablet · 768px</option><option value="1200">Desktop · 1200px</option></select></label>
      <span className={`preview-ready${ready && !resetting && !error ? ' ready' : ''}${error || timedOut ? ' failed' : ''}`} role="status" title={state}><span aria-hidden="true" className="preview-state-dot" /><span className="preview-state-label">{state}</span></span>
      <PreviewOptions label="HTML preview options"><label>Height<select aria-label="Preview height" value={height} onChange={event => setHeight(event.target.value)}><option value="auto">Fit workspace</option><option value="480">480px</option><option value="720">720px</option><option value="900">900px</option></select></label><button type="button" disabled={resetting} onClick={() => void reset()}><Icon name="refresh" size={14} />Reset preview</button><p>Self-contained HTML. External files, network and application access are disabled.</p></PreviewOptions>
    </nav>
    {(error || timedOut) && <p className="chat-preview-error" role="alert">{error || 'The HTML preview may have expired.'} <button type="button" disabled={resetting} onClick={() => void reset()}>Retry preview</button></p>}
    {!!errors.length && <details className="interactive-errors"><summary>Preview diagnostics · {errors.length}</summary><button type="button" onClick={clearErrors}>Clear diagnostics</button>{errors.map((error, index) => <pre key={index}>{error}</pre>)}</details>}
    <div hidden={source || !!timedOut} className={`interactive-document-stage${height === 'auto' ? '' : ' fixed-height'}`} style={height === 'auto' ? undefined : { height: `${height}px` }}><iframe ref={frame} key={reload} title="Interactive HTML preview" sandbox="allow-scripts" referrerPolicy="no-referrer" src={url} style={{ width: width === 'fluid' ? '100%' : `${width}px` }} /></div>
    {source && (file.source?.visualizePath
      ? <div className="interactive-document-stage"><iframe title="HTML source" sandbox="" referrerPolicy="no-referrer" src={`${url}?source=1`} style={{ width: '100%' }} /></div>
      : <ChatMarkdown workspacePreview text={codeFence(file.text || '', 'html')} query="" sessionId="" openLocal={() => {}} />)}
  </section>
}
