import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatSession } from './types'
import { useDesktop } from './client'
import { chatRepositoryGroups } from './chatRepositoryGroups'
import ChatTabs from './ChatTabs'
import { Icon } from './Icons'

export default function WorkspaceChatPreview({ anchor, name, projectId, items, selectedId, choose, close, dismiss, expand }: {
  anchor: HTMLButtonElement; name: string; projectId: string | null; items: ChatSession[]; selectedId?: string
  choose: (id: string) => void; close: (id: string) => void; dismiss: () => void; expand: () => void
}) {
  const state = useDesktop(), panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 55, top: 8, maxHeight: 500 })
  const latest = useRef(dismiss)
  useEffect(() => { latest.current = dismiss })
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect(), element = panel.current
      if (!element) return
      const maxHeight = Math.max(80, window.innerHeight - 16)
      setPosition({ left: Math.max(8, Math.min(rect.right + 5, window.innerWidth - element.offsetWidth - 8)), top: Math.max(8, Math.min(rect.top, window.innerHeight - Math.min(element.scrollHeight, maxHeight) - 8)), maxHeight })
    }
    place(); const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor])
  useEffect(() => {
    let timer = 0
    const ownedMenu = () => document.querySelector('[data-menu-owner="workspace-preview"]')
    const inside = (target: EventTarget | null) => target instanceof Node && (panel.current?.contains(target) || anchor.contains(target) || ownedMenu()?.contains(target))
    const check = (event: Event) => {
      clearTimeout(timer)
      if (!inside(event.target) && !ownedMenu()) timer = window.setTimeout(() => latest.current(), 260)
    }
    const outside = (event: Event) => { if (!inside(event.target)) latest.current() }
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !ownedMenu()) { event.preventDefault(); event.stopPropagation(); anchor.focus(); latest.current() }
      if (event.key === 'ArrowDown' && event.target === anchor) { event.preventDefault(); panel.current?.querySelector<HTMLElement>('[role="tab"]')?.focus() }
    }
    const hidden = () => { if (document.hidden) latest.current() }
    document.addEventListener('pointermove', check); document.addEventListener('focusin', check); document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', keys); document.addEventListener('visibilitychange', hidden)
    window.addEventListener('blur', dismissOnBlur)
    function dismissOnBlur() { latest.current() }
    return () => { clearTimeout(timer); document.removeEventListener('pointermove', check); document.removeEventListener('focusin', check); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keys); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('blur', dismissOnBlur) }
  }, [anchor])
  const project = state.projects.find(project => project.id === projectId)
  const groups = project ? chatRepositoryGroups(items, project) : [{ id: 'all', name: '', items }]
  const counts = [
    { key: 'waiting', label: 'need input', count: items.filter(item => item.status === 'running' && item.activity === 'waiting').length },
    { key: 'working', label: 'working', count: items.filter(item => item.status === 'running' && item.activity === 'working').length },
    { key: 'unread', label: 'unread', count: items.filter(item => item.unread).length },
  ]
  return createPortal(<div ref={panel} className="workspace-chat-preview project-chat-drawer" role="region" aria-label={`${name} chat preview`} style={position}>
    <header><strong>{name}</strong><button className="desk-icon" aria-label="Close chat preview" onClick={dismiss}><Icon name="close" size={14} /></button></header>
    <div className="workspace-preview-counts">{counts.filter(value => value.count).map(value => <span key={value.key} className={value.key}>{value.count} {value.label}</span>)}</div>
    <div className="workspace-preview-chats">{groups.map(group => <section key={group.id} aria-label={group.name || name}>
      {group.name && <div className="project-chat-scope-heading"><span><Icon name={group.id === 'hub' ? 'workspace' : 'folder'} size={12} />{group.name}</span></div>}
      <ChatTabs vertical reorder={false} menuOwner="workspace-preview" items={group.items} selectedId={selectedId} agents={state.agents} choose={id => { dismiss(); choose(id) }} close={close} />
    </section>)}</div>
    <button className="workspace-preview-expand" onClick={expand}><Icon name="workspace" size={14} />Open project menu</button>
  </div>, document.body)
}
