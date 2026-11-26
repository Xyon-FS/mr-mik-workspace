import { useId, useState, type ComponentProps, type ReactNode } from 'react'
import { ChatAttachmentGroup } from './ChatAttachment'
import { useConversationChrome } from './ConversationChrome'

// Shared presentation only. Providers retain their native delivery, approval
// and settings handlers; capabilities determine which controls are supplied.
export function GraphicalComposer(props: ComponentProps<'form'>) {
  return <form {...props} className="graphical-composer" />
}

export function GraphicalSendButton({ stopping, disabled, onStop, title, interruptAvailable = false, interruptDisabled = false }: { stopping: boolean; disabled: boolean; onStop: () => void; title?: string; interruptAvailable?: boolean; interruptDisabled?: boolean }) {
  return <>{interruptAvailable && !stopping && <button type="button" className="graphical-interrupt-action" aria-label="Interrupt response" title="Stop response" disabled={interruptDisabled} onClick={onStop}><span className="graphical-stop-square" aria-hidden="true" /></button>}<button type={stopping ? 'button' : 'submit'} className={`graphical-primary-action ${stopping ? 'is-stop' : 'is-send'}`} aria-label={stopping ? 'Interrupt response' : 'Send message'} title={stopping ? 'Stop response' : title || 'Send message'} disabled={disabled} onClick={stopping ? onStop : undefined}>{stopping ? <span className="graphical-stop-square" aria-hidden="true" /> : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}</button></>
}

export function GraphicalDraftAttachments({ sessionId, items, disabled, remove }: { sessionId: string; items: { path: string; name: string; kind: string; unavailable?: boolean }[]; disabled?: boolean; remove: (path: string) => void }) {
  return <div className="graphical-attachments" aria-label="Draft attachments"><ChatAttachmentGroup sessionId={sessionId} itemId="draft" items={items} disabled={disabled} remove={remove} /></div>
}

export function GraphicalHistoryNav({ visible, loading, hasOlder, connected, historical, older }: { visible: boolean; loading: boolean; hasOlder?: boolean; connected: boolean; historical: boolean; older: () => Promise<void> }) {
  return visible ? <div className="graphical-history"><button type="button" disabled={loading || hasOlder === false || !connected} onClick={() => void older()}>{loading ? 'Loading history…' : hasOlder === false ? 'Beginning of conversation' : 'Load older messages'}</button><small>{historical ? 'Reading earlier messages' : 'Recent messages'}</small></div> : null
}

export function GraphicalChatDetails({ connected, children, actions, conversation, sessionInfo, limits }: { connected: boolean; children?: ReactNode; actions?: ReactNode; conversation?: ReactNode; sessionInfo?: ReactNode; limits?: ReactNode }) {
  const [selected, setSelected] = useState(0), id = useId()
  const chrome = useConversationChrome()
  const sections = [{ name: 'Session', content: <>{chrome.summary}{sessionInfo}{actions}</> }, { name: 'Context', content: <>{chrome.context}{children}</> }, { name: 'Actions', content: <>{conversation}{chrome.actions}</> }, { name: 'Usage', content: limits }].filter(section => section.content != null)
  return <div className="graphical-info-panel"><header className="graphical-menu-heading"><strong>Chat details</strong><span className={connected ? 'graphical-connection connected' : 'graphical-connection'} title={connected ? 'Connected' : 'Disconnected'} aria-label={connected ? 'Connected' : 'Disconnected'} /><button type="button" className="graphical-details-close" aria-label="Close chat details" onClick={event => { const panel = event.currentTarget.closest('details'); if (panel) { panel.open = false; panel.querySelector<HTMLElement>(':scope > summary')?.focus() } }}><svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header><nav className="graphical-detail-tabs" role="tablist" aria-label="Chat detail sections">{sections.map((section, index) => <button key={section.name} type="button" id={`${id}-tab-${index}`} role="tab" aria-selected={selected === index} aria-controls={`${id}-panel-${index}`} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length; setSelected(next); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus() }}>{section.name}</button>)}</nav>{sections.map((section, index) => <div className="graphical-detail-panel" key={section.name} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} hidden={selected !== index}>{section.content}</div>)}</div>
}

