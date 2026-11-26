import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import guide from '../../docs/user-guide.md?raw'
import snapshots from '../../docs/workspace-snapshots.md?raw'
import { Icon } from './Icons'
import './help.css'

const handbook = `${guide}\n\n## Workspace snapshot reference\n\n${snapshots.replace(/^# .+\n/, '').replace(/^## /gm, '### ')}`
const slug = (text: string) => text.toLowerCase().replace(/[`*]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')
const headingText = (children: ReactNode): string => Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? headingText(child.props.children) : '').join('')
const category = (title: string) => /account|Settings and/.test(title) ? 'Accounts and settings' : /Files|Skills|Tools/.test(title) ? 'Workspace tools' : /Chats|terminal|graphical|History|OpenCode|coordinator/.test(title) ? 'Conversations' : /Overview|Start here|Hub, workspaces/.test(title) ? 'Getting started' : 'Reference'
const categories = ['Getting started', 'Conversations', 'Workspace tools', 'Accounts and settings', 'Reference']
const sections = handbook.split(/\n(?=## )/).map((body, index) => {
  const title = index === 0 ? 'Overview' : /^## (.+)$/m.exec(body)?.[1] || `Section ${index}`
  return { id: index, title, body, category: category(title), anchors: [...body.matchAll(/^#{1,6} (.+)$/gm)].map(match => slug(match[1])) }
})

export default function HelpSite({ onClose }: { onClose: () => void }) {
  const opener = useRef(document.activeElement as HTMLElement | null)
  const dialog = useRef<HTMLDialogElement>(null), content = useRef<HTMLElement>(null), target = useRef('')
  const [selected, setSelected] = useState(0), [query, setQuery] = useState('')
  const matches = useMemo(() => sections.filter(section => `${section.title} ${section.body}`.toLowerCase().includes(query.trim().toLowerCase())), [query])
  const active = sections[selected]
  useEffect(() => { const previous = opener.current; const node = dialog.current; node?.showModal(); node?.querySelector<HTMLInputElement>('input')?.focus(); return () => { node?.close(); if (previous?.isConnected) previous.focus() } }, [])
  useEffect(() => {
    const destination = target.current; target.current = ''
    if (destination) content.current?.querySelector<HTMLElement>(`[id="${CSS.escape(destination)}"]`)?.scrollIntoView({ block: 'start' })
    else content.current?.scrollTo({ top: 0 })
  }, [selected])
  const navigate = (id: number) => { target.current = ''; setSelected(id); content.current?.scrollTo({ top: 0 }) }
  const search = (value: string) => {
    setQuery(value)
    const found = sections.filter(section => `${section.title} ${section.body}`.toLowerCase().includes(value.trim().toLowerCase()))
    if (found.length && !found.some(section => section.id === selected)) navigate(found[0].id)
  }
  return createPortal(<dialog ref={dialog} className="help-site" aria-label="Mr. Mik guide" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target !== event.currentTarget) return; const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose() }}>
    <header className="help-site-top"><div><Icon name="help" size={20} /><strong>Workspace guide</strong></div><button className="desk-icon" onClick={onClose} title="Close guide" aria-label="Close guide"><Icon name="close" size={17} /></button></header>
    <div className="help-site-layout"><aside className="help-site-nav" aria-label="Guide sections"><label className="help-site-search"><Icon name="search" size={15} /><input autoFocus placeholder="Search the guide…" aria-label="Search the guide" value={query} onChange={event => search(event.target.value)} />{query && <button className="desk-icon" type="button" aria-label="Clear guide search" onClick={() => search('')}><Icon name="close" size={13} /></button>}</label><div className="help-site-nav-list">{categories.map(group => { const entries = matches.filter(section => section.category === group); return entries.length ? <section key={group}><h3>{group}</h3>{entries.map(section => <button key={section.id} className={selected === section.id ? 'selected' : ''} aria-current={selected === section.id ? 'page' : undefined} onClick={() => navigate(section.id)}>{section.title}</button>)}</section> : null })}{!matches.length && <p role="status">No sections match your search.</p>}</div><small className="help-site-nav-foot">Available offline</small></aside>
    <main ref={content} className="help-site-content"><article key={active.id}><div className="help-site-kicker">{active.category}</div><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      h1: ({ children }) => <h1 id={slug(headingText(children))}>{children}</h1>, h2: ({ children }) => <h2 id={slug(headingText(children))}>{children}</h2>, h3: ({ children }) => <h3 id={slug(headingText(children))}>{children}</h3>,
      a: ({ href, children }) => <a href={href} target={href?.startsWith('https:') || href?.startsWith('http:') ? '_blank' : undefined} rel="noreferrer" onClick={event => { if (!href?.startsWith('#')) return; event.preventDefault(); let anchor; try { anchor = decodeURIComponent(href.slice(1)) } catch { return } const section = sections.find(section => section.anchors.includes(anchor)); if (!section) return; if (section.id === selected) content.current?.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' }); else { target.current = anchor; setSelected(section.id) } }}>{children}</a>,
    }}>{active.body}</ReactMarkdown><nav className="help-site-next" aria-label="Guide pages">{selected > 0 && <button onClick={() => navigate(selected - 1)}><Icon name="back" size={14} />Previous</button>}{selected < sections.length - 1 && <button onClick={() => navigate(selected + 1)}>Next<Icon name="arrow" size={14} /></button>}</nav></article></main>
    </div>
  </dialog>, document.body)
}
