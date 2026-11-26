import { IntermediateOutputContext } from './intermediateOutputContext'
import { useContext, useEffect, useRef, useState } from 'react'
import { api } from './client'
import ChatImageViewer from './ChatImageViewer'
import { useChatPreviewPin, focusChatPreviewSource, retainChatPreview } from './useChatPreviewPin'
import { Icon } from './Icons'
import { previewBlob } from '../lib/download'

export type ToolResource = { kind: string; name: string; mimeType: string; text?: string; uri?: string; available: boolean }
export function ToolResourceCard({ sessionId, itemId, resource, index, resultRevision, runtimeId }: { sessionId: string; itemId: string; resource: ToolResource; index: number; resultRevision?: string; runtimeId?: string }) {
  const intermediate = useContext(IntermediateOutputContext)
  const [preview, setPreview] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const image = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement>(null)
  useChatPreviewPin(expanded, image)
  useChatPreviewPin(playing, card)
  const stop = () => setPlaying(false)
  const playback = { onPlay: () => { retainChatPreview(card.current); setPlaying(true) }, onPause: stop, onEnded: stop, onEmptied: stop }
  const media = ['image', 'audio', 'video'].includes(resource.kind)
  const [playbackSource, setPlaybackSource] = useState<{ preview: string; url: string }>()
  const mediaUrl = preview.startsWith('data:') ? playbackSource?.preview === preview ? playbackSource.url : undefined : preview
  useEffect(() => {
    if (!['audio', 'video'].includes(resource.kind) || !preview.startsWith('data:')) return
    let active = true, url = ''
    void previewBlob(preview).then(blob => {
      if (active) { url = URL.createObjectURL(blob); setPlaybackSource({ preview, url }) }
    }, () => { if (active) setError('This media preview could not be decoded.') })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [preview, resource.kind])
  const load = async (view: boolean) => {
    setBusy(true); setError('')
    try {
      const result = await api<{ name: string; url: string }>(`/sessions/${sessionId}/chatresult?item=${encodeURIComponent(itemId)}&resource=${index}&preview=${view}${resultRevision ? `&resultRevision=${encodeURIComponent(resultRevision)}&runtimeId=${encodeURIComponent(runtimeId || '')}` : ''}`)
      if (view) setPreview(result.url)
      else { const link = document.createElement('a'); link.href = result.url; link.download = result.name; link.click() }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section ref={card} className="graphical-tool-result" aria-label={`Tool result: ${resource.name}`}>
    <header><strong>{resource.name}</strong><small>{resource.kind === 'unsupported' ? 'Preview unavailable' : resource.kind}</small>{intermediate && resource.kind === 'text' && <button type="button" className="graphical-step-copy" aria-label="Copy tool text" title={copied === resource.text ? 'Copied' : 'Copy text'} onClick={() => void navigator.clipboard.writeText(resource.text || '').then(() => { setCopied(resource.text || ''); setError('') }, () => setError('Copy unavailable. Select the text to copy it.'))}><Icon name="files" size={14} /></button>}</header>
    {resource.kind === 'text' && <pre>{resource.text}</pre>}
    {preview && (resource.kind === 'image' ? <><button ref={image} type="button" aria-label="Expand tool image" onClick={() => setExpanded(true)}><img src={preview} alt={resource.name} onError={() => setError('This image could not be displayed. Save it to open it elsewhere.')} /></button>{expanded && <ChatImageViewer stateKey={`${sessionId}:${itemId}:resource:${index}`} url={preview} name={resource.name} onClose={() => setExpanded(false)} returnFocus={() => focusChatPreviewSource(image.current)} />}</> : resource.kind === 'audio' ? <audio {...playback} aria-label={resource.name} controls preload="metadata" src={mediaUrl} onError={() => { stop(); setError(intermediate ? 'This audio format could not be played. Ask for a supported format.' : 'This audio format could not be played. Save the file to open it elsewhere.') }} /> : <video {...playback} aria-label={resource.name} controls preload="metadata" src={mediaUrl} onError={() => { stop(); setError(intermediate ? 'This video format could not be played. Ask for a supported format.' : 'This video format could not be played. Save the file to open it elsewhere.') }} />)}
    <div className="graphical-actions">{resource.kind === 'link' && resource.uri && /^https?:\/\//i.test(resource.uri) ? <a href={resource.uri} target="_blank" rel="noreferrer">Open resource</a> : resource.available && <>{media && !preview && <button disabled={busy} type="button" onClick={() => void load(true)}>{busy ? 'Loading…' : 'Preview'}</button>}{(!intermediate || resource.kind === 'image') && <button disabled={busy} type="button" aria-label={resource.kind === 'image' ? 'Save tool image' : undefined} title={resource.kind === 'image' ? 'Save image' : undefined} className={intermediate ? 'graphical-step-image-save' : undefined} onClick={() => void load(false)}>{intermediate ? <Icon name="download" size={14} /> : 'Save file'}</button>}</>}</div>
    {resource.kind === 'unsupported' && <p>This content cannot be displayed here. Ask the tool to return text or save a file.</p>}{error && <p className="chat-preview-error" role="alert">{error} {media && <button type="button" disabled={busy} onClick={() => void load(true)}>Retry preview</button>}</p>}
  </section>
}
export default function GraphicalToolResults({ sessionId, itemId, resources }: { sessionId: string; itemId: string; resources: ToolResource[] }) {
  return <div className="graphical-tool-results">{resources.map((resource, index) => <ToolResourceCard key={`${index}:${resource.name}:${resource.mimeType}`} sessionId={sessionId} itemId={itemId} resource={resource} index={index} />)}</div>
}
