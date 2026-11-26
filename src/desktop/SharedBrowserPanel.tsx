import { useEffect, useRef, useState } from 'react'
import { api, browserDownload, browserUpload, closeBrowserPanel, useDesktop } from './client'
import { PreviewButton, PreviewOptions } from './PreviewChrome'
import { Icon } from './Icons'
import type { ChatSession } from './types'
import './shared-browser.css'

type BrowserState = { sessionId: string; status: string; owner: 'agent' | 'user'; busy: boolean; presentation: 'workspace' | 'external'; temporary: boolean; channel: string; pending: boolean; notice: string; activeId: string | null; viewport: { width: number; height: number }; pages: { id: string; url: string; title: string }[]; uploadPending: boolean; dialog: { type: string; message: string } | null; downloads: { id: string; name: string }[]; error: string }

export function SharedBrowserButton({ session, available }: { session: ChatSession; available: boolean }) {
  const [error, setError] = useState('')
  if (!available) return null
  return <><button type="button" className="graphical-review-action" aria-label="Open browser controls" title="Open browser in Workspace" onClick={() => { setError(''); void api(`/browser/${session.id}`, { action: 'show' }).catch(cause => setError(cause.message)) }}><Icon name="browser" size={15} /><span>Browser</span><Icon name="arrow" size={13} /></button>{error && <small role="alert">{error}</small>}</>
}

export default function SharedBrowserPanel({ sessionId, active: visible = true }: { sessionId: string; active?: boolean }) {
  const { sessions } = useDesktop(), session = sessions.find(item => item.id === sessionId)
  const [data, setData] = useState<BrowserState | null>(null), [error, setError] = useState(''), [url, setUrl] = useState(''), [connected, setConnected] = useState(false), [attempt, setAttempt] = useState(0)
  const [dialogText, setDialogText] = useState(''), [editingAddress, setEditingAddress] = useState(false)
  const [zoom, setZoom] = useState('fit'), [selectionNote, setSelectionNote] = useState('')
  const [dismissedNotice, setDismissedNotice] = useState('')
  const [enableChannel, setEnableChannel] = useState('chrome'), [enabling, setEnabling] = useState(false)
  useEffect(() => { if (!selectionNote) return; const timer = window.setTimeout(() => setSelectionNote(''), 5000); return () => clearTimeout(timer) }, [selectionNote])
  useEffect(() => { if (!data?.notice || data.pending) return; const timer = window.setTimeout(() => setDismissedNotice(data.notice), 4000); return () => clearTimeout(timer) }, [data?.notice, data?.pending])
  const view = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), address = useRef<HTMLInputElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null), input = useRef<HTMLTextAreaElement>(null), socket = useRef<WebSocket | null>(null), wheel = useRef({ x: 0, y: 0, timer: 0 })
  useEffect(() => {
    if (!visible) return
    let disposed = false, reconnect = 0, ws: WebSocket | null = null
    const connect = async () => {
      try {
        const result = await api<BrowserState & { ticket: string }>(`/browser/${sessionId}`, { action: 'connect' })
        if (disposed) return
        setData(result); setError('')
        if (result.channel === 'off') { setConnected(false); return }
        ws = new WebSocket(`${location.origin.replace('http:', 'ws:')}/browser-stream`); socket.current = ws
        let paints = Promise.resolve()
        ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', sessionId, ticket: result.ticket }))
        ws.onmessage = event => {
          if (disposed) return
          const message = JSON.parse(event.data)
          if (message.type === 'state') { setData(message); setConnected(true); return }
          if (message.type === 'error') { setError(message.message); return }
          if (message.type === 'frame') {
            if (message.viewport) setData(previous => previous ? { ...previous, viewport: message.viewport } : previous)
            const current = ws
            paints = paints.then(async () => {
              try { const image = new Image(); image.src = `data:image/jpeg;base64,${message.data}`; await image.decode(); if (!disposed && current === socket.current) { canvas.current?.getContext('2d')?.drawImage(image, 0, 0, canvas.current?.width || 1100, canvas.current?.height || 720); if (canvas.current) canvas.current.dataset.frames = String(Number(canvas.current.dataset.frames || 0) + 1) } }
              finally { if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ack', generation: message.generation })) }
            }).catch(() => { if (!disposed) setError('The browser frame could not be displayed.') })
          }
        }
        ws.onclose = event => { if (disposed) return; setConnected(false); if (event.reason === 'Viewer replaced') { setError('The browser is open in another viewer. Reconnect to use this panel.'); return } reconnect = window.setTimeout(() => void connect(), 1500) }
        ws.onerror = () => ws?.close()
      } catch (cause) { if (!disposed) { setConnected(false); setError(cause instanceof Error ? cause.message : 'Browser unavailable') } }
    }
    void connect()
    const scroll = wheel.current
    return () => { void api(`/browser/${sessionId}`, { action: 'release-control' }).catch(() => {}); disposed = true; setConnected(false); clearTimeout(reconnect); clearTimeout(scroll.timer); scroll.timer = 0; scroll.x = 0; scroll.y = 0; ws?.close(); if (socket.current === ws) socket.current = null }
  }, [sessionId, attempt, visible])
  const active = data?.pages.find(page => page.id === data.activeId), user = data?.owner === 'user' && connected && data.status === 'ready'
  useEffect(() => {
    const target = canvas.current, parent = view.current, surface = stage.current
    if (!target || !parent || !surface) return
    const resize = () => { const scale = zoom === 'fit' ? Math.min(1, parent.clientWidth / (data?.viewport.width || 1100), parent.clientHeight / (data?.viewport.height || 720)) : Number(zoom); target.style.width = surface.style.width = `${(data?.viewport.width || 1100) * scale}px`; target.style.height = surface.style.height = `${(data?.viewport.height || 720) * scale}px` }
    const observer = new ResizeObserver(resize); observer.observe(parent); resize()
    return () => observer.disconnect()
  }, [sessionId, zoom, data?.viewport.width, data?.viewport.height, visible])
  useEffect(() => {
    const target = canvas.current
    const preventOuterScroll = (event: WheelEvent) => { if (user) event.preventDefault() }
    target?.addEventListener('wheel', preventOuterScroll, { passive: false })
    return () => target?.removeEventListener('wheel', preventOuterScroll)
  }, [user])
  const action = async (value: object) => { setError(''); try { const result = await api<BrowserState>(`/browser/${sessionId}`, value); if (socket.current?.readyState !== WebSocket.OPEN) setData(result) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Browser action failed') } }
  const send = (value: object) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value)) }
  const stop = (event: React.KeyboardEvent) => {
    if (!user) return
    event.stopPropagation()
    const key = event.key, modifier = event.ctrlKey ? 'Control+' : event.metaKey ? 'Meta+' : event.shiftKey && key === 'Tab' ? 'Shift+' : ''
    if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key) || modifier && key.toLowerCase() === 'a') { event.preventDefault(); send({ type: 'key', key: modifier && key.toLowerCase() === 'a' ? modifier + 'A' : key === 'Tab' ? modifier + key : key }) }
  }
  const navigateTabs = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!user || data?.busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const tabs = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')], index = tabs.indexOf(event.currentTarget)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    if (data?.pages[next]) { void action({ action: 'select', pageId: data.pages[next].id }); tabs[next].focus({ preventScroll: true }); tabs[next].scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
  }
  return <section className="shared-browser-panel" role="region" aria-label="Workspace browser" onKeyDownCapture={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && user) { event.preventDefault(); event.stopPropagation(); address.current?.focus(); address.current?.select() } }}>
    <header className="browser-chrome">
      <div className="browser-history"><PreviewButton label="Go back" icon="back" disabled={!user || data?.busy} onClick={() => void action({ action: 'back' })} /><PreviewButton label="Go forward" icon="arrow" disabled={!user || data?.busy} onClick={() => void action({ action: 'forward' })} /><PreviewButton label="Reload browser page" icon="refresh" disabled={!user || data?.busy} onClick={() => void action({ action: 'reload' })} /></div>
      <form className="browser-address" onSubmit={event => { event.preventDefault(); setEditingAddress(false); void action({ action: 'navigate', url: url || active?.url }) }}><Icon name="browser" size={14} /><input ref={address} aria-label="Browser address" placeholder="Enter a website URL" value={editingAddress ? url : active?.url === 'about:blank' ? '' : active?.url || ''} disabled={!user} onFocus={() => { setEditingAddress(true); setUrl(active?.url === 'about:blank' ? '' : active?.url || '') }} onBlur={() => setEditingAddress(false)} onChange={event => setUrl(event.target.value)} /><PreviewButton label="Go" icon="arrow" type="submit" disabled={!user || data?.busy || !url.trim()} /></form>
      <button className={`browser-owner${user ? ' user' : ''}`} aria-label={user ? 'Return to agent' : 'Take control'} title={user ? 'You control the page · return control to the agent' : 'Agent controls the page · take control'} disabled={!connected || data?.busy} onClick={() => void action({ action: 'owner', owner: user ? 'agent' : 'user' })}><span />{data?.busy ? 'Working' : user ? 'You' : 'Agent'}</button>
      <PreviewOptions label="Browser options">
        <label>Viewport<select aria-label="Browser viewport" value={`${data?.viewport.width || 1100}x${data?.viewport.height || 720}`} disabled={!user || data?.busy} onChange={event => { const [width, height] = event.target.value.split('x').map(Number); void action({ action: 'viewport', width, height }) }}><option value="1100x720">Desktop · 1100×720</option><option value="768x1024">Tablet · 768×1024</option><option value="390x844">Phone · 390×844</option></select></label>
        <label>Display scale<select aria-label="Browser display scale" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">Fit panel</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label>
        <label>Open in<select aria-label="Chat browser presentation" value={data?.presentation || 'workspace'} disabled={!data || data.busy} onChange={event => { const presentation = event.target.value; if (window.confirm('Switch browser presentation? This restarts only the browser when safe. Tabs and unsaved page state may be lost.')) void api('/browser-settings', { scope: 'chat', sessionId, presentation }).catch(cause => setError(cause.message)) }}><option value="workspace">Workspace</option><option value="external">External window</option></select></label>
        <button type="button" disabled={!user || data?.busy} onClick={() => { setError(''); void api(`/browser/${sessionId}`, { action: 'annotate' }).then(() => setSelectionNote('Selection added to chat context.'), cause => setError(cause.message)) }}><Icon name="quote" size={14} />Send selection to chat</button>
        <p>{session?.name || 'Chat'} · {data?.temporary ? 'Temporary website session' : 'Persistent website profile'}. Take control to interact or complete a CAPTCHA.</p>
      </PreviewOptions>
      <PreviewButton label="Close browser panel" icon="close" title="Close panel · keep browser running" onClick={() => { closeBrowserPanel(); void api(`/browser/${sessionId}`, { action: 'hide' }).catch(() => {}) }} />
    </header>
    <div className="browser-page-row"><div className="browser-page-tabs" role="tablist" aria-label="Browser pages">{data?.pages.map(page => <button type="button" role="tab" key={page.id} aria-selected={page.id === data.activeId} tabIndex={page.id === data.activeId ? 0 : -1} disabled={!user} aria-disabled={!user || data.busy} title={page.url} onKeyDown={navigateTabs} onClick={() => { if (!data.busy) void action({ action: 'select', pageId: page.id }) }}><Icon name="browser" size={12} /><span>{!page.title || page.title === 'Page' ? page.url === 'about:blank' ? 'New tab' : page.url : page.title}</span></button>)}</div><PreviewButton label="New browser page" icon="plus" disabled={!user || data?.busy} onClick={() => void action({ action: 'new' })} /><PreviewButton label="Close browser page" icon="close" disabled={!user || data?.busy || !active} onClick={() => void action({ action: 'close-page', pageId: data?.activeId })} />{!connected && <span className="browser-connection" role="status">Connecting…</span>}</div>
    {selectionNote && <div className="shared-browser-notice" role="status">{selectionNote}</div>}
    {data?.notice && (data.pending || dismissedNotice !== data.notice) && <div className="shared-browser-notice" role="status">{data.notice}{data.pending ? ' Pending: finish manual work and return control.' : ''}</div>}
    {(error || data?.error) && <div className="shared-browser-notice" role="alert">{error || data?.error}<button onClick={() => setAttempt(value => value + 1)}>Reconnect viewer</button>{data?.status === 'failed' && <button disabled={data.busy} onClick={() => { if (window.confirm('Restart this browser? Tabs and downloads will close. Persistent website data is retained; temporary website data is lost.')) void action({ action: 'restart' }) }}>Restart browser</button>}</div>}
    {data?.dialog && <div className="shared-browser-notice" role="dialog" aria-label="Browser page dialog"><span>{data.dialog.message}</span>{data.dialog.type === 'prompt' && <input aria-label="Browser dialog answer" value={dialogText} onChange={event => setDialogText(event.target.value)} />}<button disabled={!user || data.busy} onClick={() => void action({ action: 'dialog', accept: true, text: dialogText })}>Accept dialog</button><button disabled={!user || data.busy} onClick={() => void action({ action: 'dialog', accept: false })}>Dismiss dialog</button></div>}
    {data?.uploadPending && <div className="shared-browser-notice">This page requests a file.<label className="shared-browser-file">Choose file<input type="file" aria-label="Upload file to browser" disabled={!user || data.busy} onChange={event => { const file = event.target.files?.[0]; if (file) { setError(''); void browserUpload(sessionId, file).then(setData).catch(cause => setError(cause.message)) } event.target.value = '' }} /></label><button disabled={!user || data.busy} onClick={() => void action({ action: 'upload-cancel' })}>Cancel</button></div>}
    <div ref={view} className={`shared-browser-view${user ? ' interactive' : ''}`}><div ref={stage} className="shared-browser-stage"><canvas ref={canvas} width={data?.viewport.width || 1100} height={data?.viewport.height || 720} tabIndex={active?.url === 'about:blank' ? -1 : 0} aria-label="Shared browser page" onFocus={() => { if (user) input.current?.focus({ preventScroll: true }) }} onClick={event => { if (!user) return; const bounds = event.currentTarget.getBoundingClientRect(); send({ type: 'click', x: (event.clientX - bounds.left) * (data?.viewport.width || 1100) / bounds.width, y: (event.clientY - bounds.top) * (data?.viewport.height || 720) / bounds.height, double: event.detail === 2 }); input.current?.focus({ preventScroll: true }) }} onWheel={event => { if (!user) return; wheel.current.x += event.deltaX; wheel.current.y += event.deltaY; if (!wheel.current.timer) wheel.current.timer = window.setTimeout(() => { send({ type: 'wheel', x: Math.max(-4000, Math.min(4000, wheel.current.x)), y: Math.max(-4000, Math.min(4000, wheel.current.y)) }); wheel.current.x = 0; wheel.current.y = 0; wheel.current.timer = 0 }, 45) }} /><textarea ref={input} className="shared-browser-keyboard" tabIndex={-1} aria-label="Browser keyboard input" disabled={!user} autoCapitalize="off" autoComplete="off" spellCheck={false} onKeyDown={stop} onInput={event => { if (user && !event.nativeEvent.isComposing) { send({ type: 'text', text: event.currentTarget.value }); event.currentTarget.value = '' } }} onCompositionEnd={event => { if (user) { send({ type: 'text', text: event.currentTarget.value }); event.currentTarget.value = '' } }} onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (user && text.length <= 8000) send({ type: 'text', text }); else setError('Paste up to 8,000 characters at once.') }} /></div>{connected && data?.status === 'ready' && active?.url === 'about:blank' && <div className="browser-empty" role="region" aria-label="Empty browser page"><Icon name="browser" size={30} /><strong>Open a website</strong><p>{user ? 'Enter a URL in the address bar above.' : 'Ask the agent to open a page, or take control to browse.'}</p></div>}{data?.channel === 'off' ? <div className="browser-empty browser-disabled" role="region" aria-label="Browser disabled"><Icon name="browser" size={30} /><strong>Browser is disabled</strong><p>Enable a browser for this chat. Your global and project preferences stay unchanged.</p><label>Browser<select aria-label="Enable chat browser" value={enableChannel} disabled={enabling} onChange={event => setEnableChannel(event.target.value)}><option value="chrome">Google Chrome</option><option value="msedge">Microsoft Edge</option></select></label><button type="button" disabled={enabling} onClick={() => { setEnabling(true); setError(''); void api('/browser-settings', { scope: 'chat', sessionId, choice: enableChannel }).then(() => setAttempt(value => value + 1)).catch(cause => setError(cause.message)).finally(() => setEnabling(false)) }}>{enabling ? 'Enabling…' : 'Enable for this chat'}</button></div> : !connected && <div className="shared-browser-placeholder">{error ? 'Browser unavailable' : 'Connecting to browser…'}</div>}</div>
    {!!data?.downloads.length && <div className="shared-browser-downloads" aria-label="Browser downloads">{data.downloads.map(file => <button key={file.id} onClick={() => void browserDownload(sessionId, file.id, file.name).catch(cause => setError(cause.message))}><Icon name="download" size={14} />{file.name}</button>)}</div>}
  </section>
}
