import { useEffect, useRef, useState } from 'react'
import type { AgentInfo, ChatSession } from './types'
import { api, reportError, useDesktop } from './client'
import { chatActivityLabel } from './chatActivity'
import { Icon } from './Icons'
import SessionLogo from './SessionLogo'
import AnchoredMenu from './AnchoredMenu'
import ConversationActions from './ConversationActions'
import ConversationStatus from './ConversationStatus'

type Drag = { id: string; pinned: boolean; startX: number; startY: number; moving: boolean }
type Drop = { id: string; position: 'before' | 'after' }

export default function ChatTabs({ items, orderItems = items, selectedId, agents, choose, vertical = false, reorder = true, menuOwner }: {
  items: ChatSession[]; orderItems?: ChatSession[]; selectedId?: string; agents: AgentInfo[]; choose: (id: string) => void; close: (id: string) => void; vertical?: boolean; reorder?: boolean; menuOwner?: string
}) {
  const state = useDesktop()
  const gesture = useRef<Drag | null>(null)
  const drop = useRef<Drop | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null)
  const [target, setTarget] = useState<Drop | null>(null)
  const clear = () => { gesture.current = null; drop.current = null; setDragging(null); setTarget(null) }
  const clearRef = useRef(clear)
  useEffect(() => { clearRef.current = clear })
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') clearRef.current() }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [])
  function begin(event: React.PointerEvent<HTMLButtonElement>, item: ChatSession) {
    if (!reorder || event.button !== 0) return
    suppressClick.current = false
    if (vertical && event.pointerType === 'touch') return
    gesture.current = { id: item.id, pinned: item.pinned, startX: event.clientX, startY: event.clientY, moving: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: React.PointerEvent<HTMLButtonElement>) {
    const current = gesture.current
    if (!current) return
    if (!current.moving && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return
    current.moving = true; suppressClick.current = true
    setDragging({ id: current.id, x: event.clientX, y: event.clientY })
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-chat-tab]')
    const item = orderItems.find(item => item.id === element?.dataset.chatTab)
    let next: Drop | null = null
    if (element && item && item.id !== current.id && item.pinned === current.pinned) {
      const rect = element.getBoundingClientRect()
      next = { id: item.id, position: (vertical ? event.clientY >= rect.top + rect.height / 2 : event.clientX >= rect.left + rect.width / 2) ? 'after' : 'before' }
    }
    drop.current = next; setTarget(next)
  }
  function finish() {
    const current = gesture.current, destination = drop.current
    clear()
    if (current?.moving && destination) api(`/sessions/${current.id}/reorder`, { targetId: destination.id, position: destination.position }).catch(reportError)
  }
  const dragged = items.find(item => item.id === dragging?.id)
  return <div className={`chat-tabs ${dragging ? 'is-reordering' : ''}`} role="tablist" aria-label="Agent chats" aria-orientation={vertical ? 'vertical' : 'horizontal'}>
    {items.map((item, index) => {
      const workspace = state.projects.find(project => project.id === item.projectId)
      const workingProject = workspace?.repositories.find(project => project.id === item.repositoryId)
      const workingName = workingProject?.name === 'Main project' && workingProject.repositoryPath ? workingProject.repositoryPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] : workingProject?.name
      const scope = workspace ? `${workspace.name} · ${workingName || (item.repositoryId ? 'Unlinked project' : 'General')}` : item.projectId ? 'Unlinked workspace' : item.cwd.toLowerCase() === state.repo.toLowerCase() ? 'Global Hub' : 'External folder'
      return <div key={item.id} data-chat-tab={item.id} className={`chat-tab ${selectedId === item.id ? 'selected' : ''} ${item.tabColor ? 'has-color' : ''} ${dragging?.id === item.id ? 'dragging' : ''} ${target?.id === item.id ? `drop-${target.position}` : ''}`} style={{ '--tab-accent': item.tabColor || '#dfa3b8' } as React.CSSProperties}>
      <button role="tab" aria-selected={selectedId === item.id} tabIndex={selectedId === item.id || !items.some(chat => chat.id === selectedId) && index === 0 ? 0 : -1} onKeyDown={event => {
        const previous = vertical ? 'ArrowUp' : 'ArrowLeft', next = vertical ? 'ArrowDown' : 'ArrowRight'
        if (![previous, next, 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tabs = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
        const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === next ? 1 : -1) + items.length) % items.length
        // Focus first; Enter/Space selects without reopening sessions on arrows.
        tabs?.[targetIndex]?.focus()
      }} onClick={event => { if (!suppressClick.current || event.detail === 0) choose(item.id) }} onPointerDown={event => begin(event, item)} onPointerMove={move} onPointerUp={finish} onPointerCancel={clear} onLostPointerCapture={clear}
        className="chat-tab-select" aria-label={`${item.name} · ${scope} · ${chatActivityLabel(item)}`} title={`${agents.find(a => a.id === item.agent)?.label} · ${item.name}\n${scope}\n${chatActivityLabel(item)}\nDrag to reorder ${item.pinned ? 'pinned' : 'unpinned'} tabs\nWorking folder: ${item.cwd}`}>
        <span style={{ color: agents.find(a => a.id === item.agent)?.color }}><SessionLogo session={item} combined feedback={false} /></span><span className="chat-tab-text"><span className="chat-tab-title"><span className={`chat-tab-name ${item.unread ? 'has-unread-result' : ''}`}>{item.name}</span></span>{!vertical && <small className="chat-tab-scope">{scope}</small>}</span>{item.pinned && <span className="tab-pinned" title="Pinned in History"><Icon name="pin" size={11} /></span>}
      </button>
      <ConversationStatus session={item} /><AnchoredMenu label={`Actions for ${item.name}`} className="chat-tab-more" menuOwner={menuOwner}>{dismiss => <ConversationActions session={item} onDone={dismiss} />}</AnchoredMenu>
    </div>})}
    {dragging && dragged && <div className="chat-tab-ghost" style={{ left: dragging.x + 13, top: dragging.y + 13, color: dragged.tabColor || '#d8c9da' }} aria-hidden="true"><SessionLogo session={dragged} /><span>{dragged.name}</span>{dragged.pinned && <Icon name="pin" size={12} />}</div>}
  </div>
}
