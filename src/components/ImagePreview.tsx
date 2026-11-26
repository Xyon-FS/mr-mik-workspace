import { useRef, useState } from 'react'
import '../../workspace/_shared/report.css'
import ChatImageViewer from '../desktop/ChatImageViewer'
import { useChatPreviewPin } from '../desktop/useChatPreviewPin'
import { desktopState, isDesktop } from '../desktop/client'

export default function ImagePreview({ url, title, onClose, stateKey, returnFocus = () => {} }: { url: string; title: string; onClose: () => void; stateKey?: string; returnFocus?: () => void }) {
  return <ChatImageViewer url={url} name={title} label="Image preview" stateKey={stateKey} onClose={onClose} returnFocus={returnFocus} />
}

export function ZoomImage({ src, alt = '', stateKey }: { src?: string; alt?: string; stateKey?: string }) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLAnchorElement>(null)
  const [failed, setFailed] = useState<string>(), [attempt, setAttempt] = useState(0)
  useChatPreviewPin(open, trigger)
  if (!src) return <span>{alt}</span>
  const absolute = /^(?:https?:)?\/\//i.test(src) && URL.canParse(src, location.href) ? new URL(src, location.href) : null
  const contentBase = desktopState().contentBase
  const contentOrigin = contentBase && URL.canParse(contentBase, location.href) ? new URL(contentBase, location.href).origin : ''
  const external = isDesktop && absolute && ![location.origin, contentOrigin].includes(absolute.origin)
  if (external) return <span className="chat-image-unavailable">{alt || 'External image'} · <a href={src} target="_blank" rel="noreferrer">Open original</a></span>
  if (failed === src) return <span className="chat-image-unavailable"><span role="status">{alt ? `${alt} · Image unavailable` : 'Image unavailable'}</span> <button type="button" onClick={() => { setFailed(undefined); setAttempt(value => value + 1) }}>Retry image</button> <a href={src} target="_blank" rel="noreferrer">Open original</a></span>
  return <><a ref={trigger} aria-label="Expand image" href={src} target="_blank" rel="noreferrer" title="Expand image" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); setOpen(true) } }}><img key={attempt} src={src} alt={alt} loading="lazy" onError={() => setFailed(src)} /></a>{open && <ImagePreview url={src} title={alt || 'Image'} stateKey={stateKey} onClose={() => setOpen(false)} returnFocus={() => trigger.current?.focus({ preventScroll: true })} />}</>
}
