import { useEffect, useRef, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'
import ChatImageViewer from './ChatImageViewer'
import WorkspaceDialog from './WorkspaceDialog'
import { PreviewOptions } from './PreviewChrome'
import { previewMemory } from './previewMemory'
import { useChatPreviewPin, focusChatPreviewSource } from './useChatPreviewPin'
import { isDevelopmentFile } from '../../desktop/service/development-files.mjs'
import './chat-attachments.css'

type Attachment = { name: string; kind: string; path: string; unavailable?: boolean }
type Preview = { name: string; kind: string; identity?: string; url?: string; text?: string; message?: string; size?: number; modifiedAt?: string; truncated?: boolean }
type AttachmentAction = 'workspace' | 'ide' | 'reveal'

function attachmentUrl(sessionId: string, itemId: string, index: number, path: string) {
  return `/sessions/${sessionId}/chatfile?item=${encodeURIComponent(itemId)}&attachment=${index}&expectedPath=${encodeURIComponent(path)}`
}

function AttachmentThumbnail({ route, fallback, refreshed }: { route: string; fallback: React.ReactNode; refreshed?: string | null }) {
  const slot = useRef<HTMLSpanElement>(null)
  const [loaded, setLoaded] = useState<{ route: string; url: string }>()
  const [failed, setFailed] = useState<string>()
  useEffect(() => {
    const element = slot.current
    if (!element) return
    let active = true
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void api<Preview>(`${route}&preview=true`).then(result => {
        if (active && result.kind === 'image' && result.url) setLoaded({ route, url: result.url })
      }, () => {})
    })
    observer.observe(element)
    return () => { active = false; observer.disconnect() }
  }, [route])
  const url = refreshed === undefined ? (loaded?.route === route ? loaded.url : undefined) : refreshed
  return <span ref={slot} className="chat-attachment-icon chat-attachment-thumbnail">{fallback}{url && failed !== url && <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(url)} />}</span>
}

function ChatAttachment({ sessionId, itemId, index, items, disabled, remove }: { sessionId: string; itemId: string; index: number; items: Attachment[]; disabled?: boolean; remove?: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null), epoch = useRef(0)
  const [selection, setSelection] = useState<{ index: number; item: Attachment }>()
  const [thumb, setThumb] = useState<string | null>()
  const [loading, setLoading] = useState(false), [result, setResult] = useState<Preview | null>(null), [error, setError] = useState('')
  const attachment = items[index], target = selection?.item || attachment
  const targetIndex = selection ? items.findIndex(item => item.path === selection.item.path) : index
  const opened = !!selection
  const extension = /\.([a-z0-9]{1,12})$/i.exec(attachment.name)?.[1].toUpperCase()
  const category = attachment.kind === 'folder' || attachment.kind === 'image' ? attachment.kind : isDevelopmentFile(attachment.name) ? 'code' : extension === 'PDF' ? 'document' : 'file'
  const icon = category === 'file' || category === 'document' ? 'files' : category
  const description = [extension, category === 'code' ? 'Source file' : category === 'folder' ? 'Folder reference' : category === 'image' ? 'Image' : category === 'document' ? 'Document' : 'File reference'].filter(Boolean).join(' \u00b7 ')
  const details = result ? [
    result.kind === 'folder' ? 'Folder reference' : /\.([a-z0-9]{1,12})$/i.exec(target.name)?.[1].toUpperCase(),
    result.kind !== 'folder' && result.size != null ? new Intl.NumberFormat(undefined, { style: 'unit', unit: result.size < 1024 ? 'byte' : 'kilobyte', maximumFractionDigits: 1 }).format(result.size < 1024 ? result.size : result.size / 1024) : null,
    result.modifiedAt ? new Date(result.modifiedAt).toLocaleString() : null,
  ].filter(Boolean).join(' \u00b7 ') : ''
  const route = attachmentUrl(sessionId, itemId, index, attachment.path)
  useChatPreviewPin(opened, trigger)
  useEffect(() => () => { epoch.current++ }, [])

  const close = () => {
    epoch.current++
    setSelection(undefined); setResult(null); setError(''); setLoading(false)
    requestAnimationFrame(() => focusChatPreviewSource(trigger.current))
  }
  const inspect = async (nextIndex = index, next = items[nextIndex]) => {
    if (!next) return
    const request = ++epoch.current
    setSelection({ index: nextIndex, item: next }); setLoading(true); setResult(null); setError('')
    try {
      const value = await api<Preview>(`${attachmentUrl(sessionId, itemId, nextIndex, next.path)}&preview=true`)
      if (request === epoch.current) {
        setResult(value)
        if (next.path === attachment.path && attachment.kind === 'image') setThumb(value.url ?? null)
      }
    } catch (cause) {
      if (request === epoch.current) {
        setError(cause instanceof Error ? cause.message : 'Reference unavailable.')
        if (next.path === attachment.path && attachment.kind === 'image') setThumb(null)
      }
    } finally {
      if (request === epoch.current) setLoading(false)
    }
  }
  const retry = () => { if (selection) void inspect(targetIndex >= 0 ? targetIndex : selection.index, selection.item) }
  const open = async (action: AttachmentAction) => {
    if (!selection) return
    const request = epoch.current
    const viewState = action === 'workspace' && result?.identity ? previewMemory(`image:${result.identity}`) : undefined
    await api(attachmentUrl(sessionId, itemId, targetIndex >= 0 ? targetIndex : selection.index, target.path), { action, viewState })
    if (action === 'workspace' && request === epoch.current) close()
  }
  const fileAction = (action: AttachmentAction) => void open(action).catch(cause => setError(cause.message))
  const images = items.flatMap((item, position) => item.kind === 'image' ? [position] : [])
  const imagePosition = images.indexOf(targetIndex)
  return <span className="chat-attachment" data-attachment-type={category} data-unavailable={attachment.unavailable || undefined}>
    <button ref={trigger} type="button" className="chat-attachment-inspect" title={`${attachment.name} \u00b7 ${description}`} aria-label={`Inspect ${attachment.name}`} aria-haspopup="dialog" onClick={() => void inspect()}>
      {category === 'image' && !attachment.unavailable
        ? <AttachmentThumbnail route={route} refreshed={thumb} fallback={<Icon name={icon} size={17} />} />
        : <span className="chat-attachment-icon"><Icon name={icon} size={17} /></span>}
      <span><strong>{attachment.name}</strong>{attachment.unavailable && <small>Unavailable</small>}</span>
    </button>
    {remove && <button type="button" className="chat-attachment-remove" aria-label={`Remove ${attachment.name}`} title="Remove reference" disabled={disabled} onClick={remove}><Icon name="close" size={13} /></button>}
    {opened && (result?.kind === 'image' && result.url
      ? <ChatImageViewer url={result.url} name={result.name} stateKey={result.identity} details={details} onOpenWorkspace={() => open('workspace')} onRetry={retry}
          previous={imagePosition > 0 ? () => void inspect(images[imagePosition - 1]) : undefined}
          next={imagePosition >= 0 && imagePosition + 1 < images.length ? () => void inspect(images[imagePosition + 1]) : undefined}
          position={images.length > 1 && imagePosition >= 0 ? `${imagePosition + 1} / ${images.length}` : undefined}
          returnFocus={() => focusChatPreviewSource(trigger.current)} onClose={close} />
      : <WorkspaceDialog className="chat-attachment-preview" label="Attachment preview" close={close}>
          <header><strong>{result?.name || target.name}</strong><div className="chat-attachment-preview-actions">
            {result && result.kind !== 'folder' && (result.kind !== 'file' || target.kind === 'image' || /\.pdf$/i.test(target.name)) && <button type="button" className="preview-icon-button" aria-label="Open in Workspace" title="Open in Workspace" onClick={() => fileAction('workspace')}><Icon name="workspace" size={15} /></button>}
            {result && <PreviewOptions label="Attachment options">
              {isDevelopmentFile(target.name) && <button type="button" onClick={() => fileAction('ide')}><Icon name="code" size={14} />Open in IDE</button>}
              <button type="button" onClick={() => fileAction('reveal')}><Icon name="external" size={14} />Show in Explorer</button>
              {details && <p>{details}</p>}
            </PreviewOptions>}
            <button type="button" className="desk-icon" aria-label="Close attachment preview" onClick={close}><Icon name="close" size={16} /></button>
          </div></header>
          {loading && <p role="status">Opening preview...</p>}
          {error && <p role="alert">{error}</p>}
          {result?.message && <p role="status">{result.message}</p>}
          {result?.text != null && <pre tabIndex={0}>{result.text}</pre>}
          {result?.kind === 'document' && result.url && <iframe title="Attached document" src={result.url} />}
          {result?.truncated && <small>Preview shortened.</small>}
          {error && !result && <footer><button type="button" onClick={retry}>Retry preview</button>{itemId === 'draft' && <button type="button" onClick={() => { close(); window.dispatchEvent(new CustomEvent('mrmak-attach-file')) }}>Attach another file</button>}</footer>}
        </WorkspaceDialog>)}
  </span>
}

export function ChatAttachmentGroup({ sessionId, itemId, items, disabled, remove }: { sessionId: string; itemId: string; items: Attachment[]; disabled?: boolean; remove?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="chat-attachment-group">
    {items.slice(0, expanded ? items.length : 3).map((item, index) => <ChatAttachment key={`${index}:${item.path}`} sessionId={sessionId} itemId={itemId} items={items} index={index} disabled={disabled} remove={remove ? () => remove(item.path) : undefined} />)}
    {items.length > 3 && <button type="button" className="chat-attachment-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer references' : `+${items.length - 3} ${items.length === 4 ? 'reference' : 'references'}`}</button>}
  </div>
}
