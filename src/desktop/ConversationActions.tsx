import { useState } from 'react'
import { api, reportError, selectChat, useDesktop } from './client'
import { Icon } from './Icons'
import type { ChatSession } from './types'
import { tabColors } from './chatOrder'
import TerminalTextSize from './TerminalTextSize'
import { canForkConversation } from './conversationCapabilities'

export default function ConversationActions({ session, onDone, onSearch, onHistory }: { session: ChatSession; onDone?: () => void; onSearch?: () => void; onHistory?: () => void }) {
  const state = useDesktop(), [renaming, setRenaming] = useState(false), [name, setName] = useState(session.name), [closing, setClosing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const run = async (task: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await task(); onDone?.() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const saveName = () => { if (name.trim()) void run(async () => { await api(`/sessions/${session.id}`, { name: name.trim() }, 'PATCH'); setRenaming(false) }) }
  const close = () => run(() => api(`/sessions/${session.id}`, {}, 'DELETE'))
  return <section className="conversation-actions" aria-label="Conversation actions">
    {renaming ? <div className="conversation-rename" role="group" aria-label="Rename conversation"><label>Chat name<input autoFocus aria-label="Chat name" value={name} maxLength={100} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); saveName() } }} /></label><button type="button" disabled={busy || !name.trim()} onClick={saveName}>Save</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button></div> : <button type="button" onClick={() => { setName(session.name); setRenaming(true) }}><Icon name="edit" size={14} />Rename chat</button>}
    <button type="button" disabled={busy} onClick={() => void run(() => api(`/sessions/${session.id}`, { pinned: !session.pinned }, 'PATCH'))}><Icon name="pin" size={14} />{session.pinned ? 'Unpin from History' : 'Pin in History'}</button>
    <button type="button" disabled={busy || !canForkConversation(session)} title={!canForkConversation(session) ? 'Fork requires an idle, captured native conversation. For Claude Chat use the message actions.' : undefined} onClick={() => void run(async () => { const result = await api<ChatSession>(`/sessions/${session.id}/fork`, {}); selectChat(result.id) })}><Icon name="fork" size={14} />Fork selected conversation</button>
    {onSearch && <button type="button" onClick={() => { onSearch(); onDone?.() }}><Icon name="search" size={14} />Find a chat</button>}{onHistory && <button type="button" onClick={() => { onHistory(); onDone?.() }}><Icon name="history" size={14} />History</button>}
    <button type="button" onClick={() => void api('/reveal', { path: session.cwd }).catch(reportError)}><Icon name="folder" size={14} />Show working folder</button>
    {session.chatInterface !== 'chat' && <>
      <div className="conversation-option"><span className="conversation-setting-title"><Icon name="settings" size={14} />Terminal appearance</span><div className="conversation-terminal-appearance" role="group" aria-label="Terminal appearance">{(['focus', 'original'] as const).map(value => <button type="button" key={value} aria-pressed={(state.settings.terminalAppearance || 'focus') === value} onClick={() => void api('/settings', { terminalAppearance: value }).catch(reportError)}>{value === 'focus' ? 'Focus' : 'CLI colors'}</button>)}</div></div>
      <label className="conversation-option"><span className="conversation-setting-title"><Icon name="terminal" size={14} />Terminal text</span><span className="conversation-pixel-field"><TerminalTextSize value={state.settings.terminalFontSize || 13} /><span>px</span></span></label>
    </>}
    <div className="conversation-option conversation-color"><span className="conversation-setting-title"><Icon name="circle" size={14} />Tab color</span><div role="group" aria-label="Tab color"><button type="button" disabled={busy} aria-label="No tab color" aria-pressed={!session.tabColor} onClick={() => void run(() => api(`/sessions/${session.id}`, { tabColor: null }, 'PATCH'))}><Icon name="slash" size={12} /></button>{tabColors.map(color => <button type="button" disabled={busy} key={color.value} aria-label={`${color.name} tab color`} aria-pressed={session.tabColor === color.value} style={{ background: color.value }} onClick={() => void run(() => api(`/sessions/${session.id}`, { tabColor: color.value }, 'PATCH'))}>{session.tabColor === color.value && <Icon name="check" size={11} />}</button>)}</div></div>
    {session.chatInterface !== 'chat' && <button type="button" disabled={busy} onClick={() => void run(() => api(`/sessions/${session.id}/clear`, {}))}><Icon name="clean" size={14} />Clear terminal scrollback</button>}
    {closing ? <div className="conversation-close-confirm"><p>This interrupts the current request. The chat stays in History.</p><button type="button" disabled={busy} onClick={() => void close()}>Interrupt and archive</button><button type="button" onClick={() => setClosing(false)}>Cancel</button></div> : <button type="button" className="conversation-close" disabled={busy} onClick={() => { if (session.status === 'running' && session.activity !== 'idle') setClosing(true); else void close() }}><Icon name="archive" size={14} />Archive chat</button>}
    {error && <p role="alert">{error}</p>}
  </section>
}
