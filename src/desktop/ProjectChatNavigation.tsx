import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ChatSession } from './types'
import { useDesktop } from './client'
import { Icon } from './Icons'
import ChatTabs from './ChatTabs'
import ProjectIcon from './ProjectIcon'
import { WorkspaceIconMenu } from './WorkspaceIconDialog'
import WorkspaceChatPreview from './WorkspaceChatPreview'
import { chatRepositoryGroups } from './chatRepositoryGroups'
import AnchoredMenu from './AnchoredMenu'
import NavigationPreferences from './NavigationPreferences'
import { shortcutChord, useChatShortcuts } from './chatShortcuts'
import './project-chat-navigation.css'

type Filter = 'recent' | 'attention' | 'results' | 'working' | 'pinned'
const feedback = (chats: ChatSession[]) => ({ unread: chats.filter(chat => chat.unread).length, waiting: chats.filter(chat => chat.status === 'running' && chat.activity === 'waiting').length, working: chats.filter(chat => chat.status === 'running' && chat.activity === 'working').length })
const feedbackLabel = (value: ReturnType<typeof feedback>) => `${value.unread} chats with unread results · ${value.waiting} need input · ${value.working} working`
const projectKey = (chat: ChatSession, repo: string) => chat.projectId ? `project:${chat.projectId}` : chat.cwd.replace(/[\\/]+$/, '').toLowerCase() === repo.replace(/[\\/]+$/, '').toLowerCase() ? 'hub' : 'external'
const projectInitials = (name: string) => {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').match(/[\p{L}\p{N}]+/gu) || []
  return (words.length > 1 ? `${words[0]?.[0] || ''}${words[words.length - 1]?.[0] || ''}` : words[0]?.slice(0, 2) || '?').toLocaleUpperCase()
}

export default function ProjectChatNavigation({ items, selectedId, choose, close, newChat, onSearch, onHistory, onExpandedChange, children }: {
  items: ChatSession[]; selectedId?: string; choose: (id: string) => void; close: (id: string) => void
  newChat: (projectId: string | null, repositoryId?: string) => void
  onSearch: (scope?: string) => void; onHistory: (projectId?: string) => void; onExpandedChange: (open: boolean) => void; children: ReactNode
}) {
  const layout = useRef<HTMLDivElement>(null)
  const [shortcuts] = useChatShortcuts()
  const [alwaysOverlay, setAlwaysOverlay] = useState(() => { try { return localStorage.getItem('mrmak.chat-sidebar-overlay') === 'true' } catch { return false } })
  const overlay = () => alwaysOverlay || (layout.current?.clientWidth || 0) < 805
  const state = useDesktop(), panelId = useId(), toggle = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false), [browse, setBrowse] = useState<string | null>(() => { const current = items.find(item => item.id === selectedId); return current ? projectKey(current, state.repo) : null })
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<Filter>('recent')
  const [preview, setPreview] = useState<{ key: string; anchor: HTMLButtonElement } | null>(null)
  const hoverTimer = useRef(0)
  const cancelHover = () => window.clearTimeout(hoverTimer.current)
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])
  const showPreview = (key: string, anchor: HTMLButtonElement) => { cancelHover(); if (!open) hoverTimer.current = window.setTimeout(() => setPreview({ key, anchor }), 230) }
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const selected = items.find(item => item.id === selectedId)
  const selectedKey = selected ? projectKey(selected, state.repo) : 'hub'
  const activeKey = open && browse ? browse : selectedKey
  const known = state.projects.map(project => ({ key: `project:${project.id}`, id: project.id as string | null, name: project.name, icon: 'folder', missing: false }))
  const orphanIds = [...new Set(items.map(item => item.projectId).filter((id): id is string => !!id && !state.projects.some(project => project.id === id)))]
  const groups = [...known, ...orphanIds.map(id => ({ key: `project:${id}`, id, name: 'Unlinked workspace', icon: 'folder', missing: true })), { key: 'hub', id: null, name: 'Global Hub', icon: 'workspace', missing: false }, ...(items.some(item => projectKey(item, state.repo) === 'external') ? [{ key: 'external', id: null, name: 'External folders', icon: 'external', missing: false }] : [])]
  const previewAvailable = !!preview && groups.some(group => group.key === preview.key && items.some(item => projectKey(item, state.repo) === group.key))
  if (preview && !previewAvailable) setPreview(null)
  const visibleGroups = browse ? groups.filter(group => group.key === browse) : groups
  const totals = feedback(items)
  const allMode = open && browse === null && filter === 'recent' && !query
  const matches = (item: ChatSession, groupName: string) => (filter !== 'attention' || item.activity === 'waiting') && (filter !== 'results' || item.unread) && (filter !== 'working' || item.status === 'running' && item.activity === 'working') && (filter !== 'pinned' || item.pinned) && `${item.name} ${item.agent} ${item.cwd} ${groupName} ${state.projects.find(project => project.id === item.projectId)?.repositories.find(repository => repository.id === item.repositoryId)?.name || ''}`.toLowerCase().includes(query.toLowerCase())
  useEffect(() => {
    const element = layout.current; if (!element) return
    const update = () => onExpandedChange(!!preview || open && (alwaysOverlay || element.clientWidth < 805))
    const observer = new ResizeObserver(update); observer.observe(element); update()
    return () => observer.disconnect()
  }, [open, preview, alwaysOverlay, onExpandedChange])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (!event.defaultPrevented && !event.isComposing && shortcutChord(event) === shortcuts.sidebar) { event.preventDefault(); cancelHover(); setPreview(null); setOpen(value => !value) } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [shortcuts.sidebar])
  const scopedNew = () => { const group = groups.find(group => group.key === browse); const id = group ? group.id : selected?.projectId ?? null; newChat(id && state.projects.some(project => project.id === id) ? id : null) }
  const setExpanded = (value: boolean) => { cancelHover(); setPreview(null); setOpen(value); onExpandedChange(value && overlay()) }
  const collapse = (restoreFocus = false) => { setExpanded(false); if (restoreFocus) toggle.current?.focus() }
  const pick = (id: string) => { cancelHover(); setPreview(null); choose(id); if (overlay()) collapse() }
  const focusInput = (target: EventTarget | null) => target instanceof HTMLElement && target.matches('textarea,input:not([type]),input[type="text"],[contenteditable="true"]')
  return <div ref={layout} className={`project-chats-layout${alwaysOverlay ? ' always-overlay' : ''}${open ? ' projects-expanded' : ''}`} onKeyDownCapture={event => { if (event.key === 'Escape' && open && !document.querySelector('dialog[open],details.graphical-details[open],details.cli-session-settings[open],details.graphical-context-menu[open],[role=dialog],[role=listbox]')) { event.preventDefault(); event.stopPropagation(); collapse(true) } }}>
    <nav className="project-chat-rail" aria-label="Compact project navigation">
      <button ref={toggle} type="button" className={`desk-icon navigation-all-projects ${allMode ? 'selected' : ''}`} aria-label="Show all projects" title="All projects" aria-controls={panelId} aria-expanded={open} onClick={() => { if (open) { collapse(); return } setBrowse(null); setQuery(''); setFilter('recent'); setExpanded(true) }}><Icon name="layers" size={18} /></button>
      <button type="button" className="desk-icon navigation-find-chat" aria-label="Find a chat" title={`Find a chat · ${shortcuts.search}`} onClick={() => onSearch()}><Icon name="search" size={17} /></button>
      <button type="button" className="desk-icon navigation-new-chat" aria-label="New chat" title={`New chat · ${shortcuts.new}`} onClick={scopedNew}><Icon name="plus" size={18} /></button>
      {groups.map(group => {
        const chats = items.filter(item => projectKey(item, state.repo) === group.key)
        if (!chats.length) return null
        const status = feedback(chats)
        return <button type="button" key={group.key} className={`desk-icon project-rail-item ${activeKey === group.key ? 'selected' : ''} ${status.working ? 'has-working' : ''} ${status.waiting ? 'has-waiting' : ''} ${status.unread ? 'has-unread' : ''}`} aria-label={`${group.name} projects`} aria-pressed={activeKey === group.key} aria-expanded={open && browse === group.key} aria-controls={panelId} onPointerEnter={event => { if (event.pointerType !== 'touch') showPreview(group.key, event.currentTarget) }} onPointerLeave={cancelHover} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) showPreview(group.key, event.currentTarget) }} onBlur={cancelHover} aria-description={`${group.name}${group.missing ? ' · project no longer linked' : ''} · ${chats.length} open chats\n${feedbackLabel(status)}`} onClick={() => { if (open && browse === group.key) { collapse(); return } setBrowse(group.key); setFolded(value => ({ ...value, [group.key]: false })); setQuery(''); setFilter('recent'); setExpanded(true) }}><span className="workspace-feedback-trace" aria-hidden="true">{status.waiting > 0 && <i className="waiting" />}{status.working > 0 && <i className="working" />}{status.unread > 0 && <i className="unread" />}</span>{group.id && !group.missing ? <ProjectIcon id={group.id} location={state.projects.find(project => project.id === group.id)?.repositoryPath} initials={projectInitials(group.name)} className="project-rail-initials" /> : <span className="project-rail-initials">{projectInitials(group.name)}</span>}</button>
      })}
      <span className="project-rail-spacer" /><button className="desk-icon navigation-history" aria-label="History" title={`History · ${shortcuts.history}`} onClick={() => onHistory(open ? browse?.startsWith('project:') ? browse.slice(8) : browse === 'hub' ? 'hub' : browse === 'external' ? 'external' : 'all' : undefined)}><Icon name="history" size={17} /></button>
      <AnchoredMenu label="Navigation preferences" icon="settings" align="end">{() => <NavigationPreferences overlay={alwaysOverlay} setOverlay={value => { setAlwaysOverlay(value); try { localStorage.setItem('mrmak.chat-sidebar-overlay', String(value)) } catch { /* Retain the in-memory choice. */ } }} />}</AnchoredMenu>
      <span className="project-feedback-summary" role="status" aria-live="polite">{feedbackLabel(totals)}</span>
    </nav>
    {preview && !open && groups.filter(group => group.key === preview.key && items.some(item => projectKey(item, state.repo) === group.key)).map(group => <WorkspaceChatPreview key={group.key} anchor={preview.anchor} name={group.name} projectId={group.id} items={items.filter(item => projectKey(item, state.repo) === group.key)} selectedId={selectedId} choose={pick} close={close} dismiss={() => { cancelHover(); setPreview(null) }} expand={() => { setBrowse(group.key); setFolded(value => ({ ...value, [group.key]: false })); setQuery(''); setFilter('recent'); setExpanded(true) }} />)}
    <aside id={panelId} className="project-chat-drawer" aria-label="Conversations by project" hidden={!open}>
      <div className="project-drawer-heading"><strong>{browse ? groups.find(group => group.key === browse)?.name || 'Project' : 'All projects'}</strong>{browse && <button type="button" className="desk-icon" aria-label="Find a chat in this workspace" title="Search this workspace" onClick={() => onSearch(browse)}><Icon name="search" size={15} /></button>}{browse?.startsWith('project:') && state.projects.filter(project => `project:${project.id}` === browse).map(project => <WorkspaceIconMenu key={project.id} project={project} />)}<AnchoredMenu label="Filter chats" icon="filter">{dismiss => <div className="navigation-filter-options" role="group" aria-label="Conversation filters">{(['recent', 'working', 'attention', 'results', 'pinned'] as Filter[]).map(value => <button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); dismiss() }}>{value === 'recent' ? 'Open chats' : value === 'attention' ? 'Needs input' : value === 'working' ? 'Working' : value === 'results' ? 'Unread results' : 'Pinned'}</button>)}</div>}</AnchoredMenu><button type="button" className="desk-icon" aria-label="Collapse project panel" onClick={() => collapse(true)}><Icon name="back" size={17} /></button></div>
      <div className="project-chat-tree">
        {visibleGroups.map(group => {
          const projectItems = items.filter(item => projectKey(item, state.repo) === group.key)
          if (!projectItems.length) return null
          const visible = projectItems.filter(item => matches(item, group.name))
          if ((query || filter !== 'recent') && !visible.length && !group.name.toLowerCase().includes(query.toLowerCase())) return null
          if (filter !== 'recent' && !visible.length) return null
          const workspace = state.projects.find(project => project.id === group.id)
          const repositories = workspace ? chatRepositoryGroups(visible, workspace) : null
          const expanded = !!query || filter !== 'recent' || (folded[group.key] ?? (group.key !== activeKey)) === false
          return <section key={group.key} className={`project-chat-group ${browse ? 'is-scoped' : ''}`} data-chat-project={group.key}>
            <div className="project-chat-group-heading"><button type="button" aria-expanded={expanded} onClick={() => { setFolded(value => ({ ...value, [group.key]: expanded })) }}><Icon name={expanded ? 'up' : 'arrow'} size={12} />{group.id && !group.missing ? <ProjectIcon id={group.id} location={state.projects.find(project => project.id === group.id)?.repositoryPath} initials={projectInitials(group.name)} className="project-group-initials" /> : <span className="project-group-initials">{projectInitials(group.name)}</span>}<strong>{group.name}</strong><small>{projectItems.length}</small></button>{!browse && <button type="button" className="desk-icon navigation-project-search" aria-label={`Find a chat in ${group.name}`} title="Search this workspace" onClick={() => onSearch(group.key)}><Icon name="search" size={15} /></button>}{workspace && !browse && <WorkspaceIconMenu project={workspace} />}{!group.missing && group.key !== 'external' && <button className="desk-icon" type="button" aria-label={`New chat in ${group.name}`} title={`New chat in ${group.name}`} onClick={() => { collapse(); newChat(group.id) }}><Icon name="plus" size={15} /></button>}</div>
            {expanded && <div className="project-chat-group-content">{repositories ? repositories.map(repository => <section className="project-chat-repository" key={repository.id} data-chat-repository={repository.id} aria-label={repository.name}>
              <div className="project-chat-scope-heading"><span><Icon name={repository.id === 'hub' ? 'workspace' : 'folder'} size={13} />{repository.name}{repository.missing && <small> · missing</small>}</span>{!repository.missing && <button type="button" className="desk-icon" aria-label={`New chat in ${group.name} / ${repository.name}`} title={`New chat in ${repository.name}`} onClick={() => { collapse(); newChat(group.id, repository.id) }}><Icon name="plus" size={14} /></button>}</div>
              <ChatTabs vertical items={repository.items} orderItems={visible} selectedId={selectedId} agents={state.agents} choose={pick} close={close} />
            </section>) : <ChatTabs vertical items={visible} selectedId={selectedId} agents={state.agents} choose={pick} close={close} />}{!visible.length && <p className="project-chat-empty">No open chats in this project.</p>}</div>}
          </section>
        })}
        {!visibleGroups.some(group => items.some(item => projectKey(item, state.repo) === group.key && matches(item, group.name))) && (query || filter !== 'recent') && <p className="project-chat-empty" role="status">No matching conversations.</p>}
      </div>
    </aside>
    <div className="project-chat-content" onFocusCapture={event => { if (open && overlay() && focusInput(event.target)) collapse() }} onInputCapture={event => { if (open && overlay() && focusInput(event.target)) collapse() }} onPointerDownCapture={() => { if (open && overlay()) collapse() }}>{children}</div>
  </div>
}
