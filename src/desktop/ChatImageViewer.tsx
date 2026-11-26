import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { previewMemory, rememberPreview, usePreviewViewport } from './previewMemory'
import './image-viewer.css'
import { downloadImage, imageDownloadName, previewBlob } from '../lib/download'
import { Icon } from './Icons'
import { PreviewButton, PreviewOptions } from './PreviewChrome'

export default function ChatImageViewer({ url, name, onClose, returnFocus, stateKey, label = 'Image viewer', details, previous, next, position, onOpenWorkspace, onRetry }: {
  url: string; name: string; onClose: () => void; returnFocus: () => void; stateKey?: string; label?: string
  details?: string; previous?: () => void; next?: () => void; position?: string; onOpenWorkspace?: () => Promise<void>; onRetry?: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null), image = useRef<HTMLImageElement>(null)
  const identity = `image:${stateKey || url}`, viewport = usePreviewViewport(identity)
  const [zoom, setZoom] = useState<number | 'fit'>(() => previewMemory(identity).zoom ?? 'fit'), [natural, setNatural] = useState(0)
  const changeZoom = (value: number | 'fit') => { setZoom(value); rememberPreview(identity, { zoom: value }) }
  const [error, setError] = useState('')
  const [failed, setFailed] = useState(false)
  const [opening, setOpening] = useState(false)
  const downloadName = imageDownloadName(url, name)
  const zoomIn = () => {
    const element = image.current
    if (!element || !natural) return
    const scale = zoom === 'fit' ? Math.min(1, element.getBoundingClientRect().width / natural) : zoom
    changeZoom(Math.min(4, scale * 1.25))
  }
  const zoomOut = () => {
    if (zoom === 'fit') return
    const element = image.current
    const available = viewport.current
    const next = zoom / 1.25
    const fit = element && available ? Math.min(1, (available.clientWidth - 24) / element.naturalWidth, (available.clientHeight - 24) / element.naturalHeight) : 0.25
    changeZoom(next <= Math.max(0.01, fit) ? 'fit' : next)
  }
  const close = () => { viewport.current?.dispatchEvent(new Event('scroll')); dialog.current?.close(); returnFocus(); onClose() }
  const copy = async () => {
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('Copy unavailable. Download the image instead.')
      let blob = await previewBlob(url)
      if (blob.type !== 'image/png') {
        const bitmap = await createImageBitmap(blob)
        try {
          if (bitmap.width * bitmap.height > 36000000) throw new Error('This image is too large to copy. Use Download.')
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
          blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Copy unavailable. Use Download.')), 'image/png'))
        } finally { bitmap.close() }
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setError('Image copied')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Copy unavailable. Use Download.') }
  }
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => { if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {}); element.close() }
  }, [])
  return createPortal(<dialog ref={dialog} className="chat-image-viewer" aria-label={label} onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => {
    if (event.key === 'Escape') event.stopPropagation()
    if (zoom !== 'fit' || (event.target as Element).closest('.preview-options')) return
    const navigate = event.key === 'ArrowLeft' ? previous : event.key === 'ArrowRight' ? next : undefined
    if (navigate) { event.preventDefault(); navigate() }
  }} onClick={event => { if (event.target === event.currentTarget) close() }}>
    <header><span className="image-viewer-name" title={name}>{name}</span><div className="image-viewer-tools">
      {position && <div className="image-viewer-gallery" role="group" aria-label="Image navigation"><PreviewButton label="Previous image" icon="back" disabled={!previous} onClick={previous} /><span>{position}</span><PreviewButton label="Next image" icon="arrow" disabled={!next} onClick={next} /></div>}
      <div className="image-viewer-zoom" role="group" aria-label="Image zoom controls"><button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom === 'fit'} onClick={zoomOut}><Icon name="zoomOut" size={16} /></button><span role="status" aria-label="Image zoom">{zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span><button type="button" aria-label="Zoom in" title="Zoom in" disabled={!natural || zoom !== 'fit' && zoom >= 4} onClick={zoomIn}><Icon name="zoomIn" size={16} /></button></div>
      <div className="image-viewer-fit" role="group" aria-label="Image sizing"><button type="button" aria-label="Fit image" aria-pressed={zoom === 'fit'} onClick={() => changeZoom('fit')}>Fit</button><button type="button" aria-label="Actual image size" aria-pressed={zoom === 1} onClick={() => changeZoom(1)}>100%</button></div>
      <button type="button" aria-label="Copy image" title="Copy image" disabled={failed} onClick={() => void copy()}><Icon name="files" size={16} /></button><a aria-label="Save image" title="Save image" download={downloadName} href={url} onClick={event => { event.preventDefault(); void downloadImage(url, downloadName).catch(cause => setError(cause.message)) }}><Icon name="download" size={16} /></a><button type="button" aria-label="Expand" title="Fullscreen" onClick={() => { const element = dialog.current; if (element?.requestFullscreen) void element.requestFullscreen().catch(() => setError('Fullscreen is unavailable in this window. The image remains open.')) }}><Icon name="layout" size={16} /></button>
      {onOpenWorkspace ? <PreviewButton label="Open in Workspace" icon="workspace" disabled={opening} onClick={() => {
        setOpening(true); setError('')
        void onOpenWorkspace().catch(cause => { setOpening(false); setError(cause.message) })
      }} /> : /^https?:/i.test(url) && <a href={url} aria-label="Open original" title="Open original" target="_blank" rel="noreferrer"><Icon name="external" size={16} /></a>}
      {details && <PreviewOptions label="Image details"><p>{details}</p></PreviewOptions>}
    </div><button type="button" className="image-viewer-close" aria-label="Close image" title="Close image" autoFocus onClick={close}><Icon name="close" size={17} /></button></header>
    {error && <p role="status">{error}{failed && onRetry && <button type="button" onClick={onRetry}>Retry preview</button>}</p>}<div ref={viewport} role="region" aria-label="Image canvas" tabIndex={0} className={`chat-image-canvas ${zoom !== 'fit' ? 'zoomed' : ''}`}><img ref={image} src={url} alt={name} onLoad={() => setNatural(image.current?.naturalWidth || 0)} onError={() => { setFailed(true); setError('This image could not be loaded.') }} style={zoom !== 'fit' && natural ? { width: natural * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined} /></div>
  </dialog>, document.body)
}
