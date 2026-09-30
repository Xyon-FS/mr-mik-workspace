import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import guide from '../../docs/user-guide.md?raw'
import snapshots from '../../docs/workspace-snapshots.md?raw'
import { Icon, Nose } from './Icons'
import './help.css'

const handbook = `${guide}\n\n## Workspace snapshot reference\n\n${snapshots.replace(/^# .+\n/, '').replace(/^## /gm, '### ')}`
const sections = handbook.split(/\n(?=## )/).map((body, index) => ({
  id: index,
  title: index === 0 ? 'Overview' : /^## (.+)$/m.exec(body)?.[1] || `Section ${index}`,
  body,
}))

export default function HelpSite({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState(0)
  const [query, setQuery] = useState('')
  const matches = useMemo(() => sections.filter(section => `${section.title} ${section.body}`.toLowerCase().includes(query.trim().toLowerCase())), [query])
  const active = sections[selected]
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return <div className="help-site-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="help-site" role="dialog" aria-modal="true" aria-label="Mr. Mik guide">
      <header className="help-site-top"><div><Nose size={31} /><span><small>MR. MIK · HANDBOOK</small><strong>Workspace guide</strong></span></div><button className="desk-icon" onClick={onClose} title="Close guide" aria-label="Close guide"><Icon name="close" size={19} /></button></header>
      <div className="help-site-layout"><aside className="help-site-nav" aria-label="Guide sections"><label className="help-site-search"><Icon name="search" size={16} /><input autoFocus placeholder="Search the guide…" aria-label="Search the guide" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="help-site-nav-list">{matches.map(section => <button key={section.id} className={selected === section.id ? 'selected' : ''} aria-current={selected === section.id ? 'page' : undefined} onClick={() => setSelected(section.id)}><span>{String(section.id + 1).padStart(2, '0')}</span>{section.title}</button>)}{!matches.length && <p>No sections match your search.</p>}</div><small className="help-site-nav-foot">Local guide · no account or network needed</small></aside>
        <main className="help-site-content" key={active.id}><div className="help-site-kicker">{String(active.id + 1).padStart(2, '0')} / {String(sections.length).padStart(2, '0')} · USER GUIDE</div><ReactMarkdown remarkPlugins={[remarkGfm]}>{active.body}</ReactMarkdown><div className="help-site-next">{selected > 0 && <button onClick={() => setSelected(selected - 1)}><Icon name="back" size={15} /> Previous</button>}{selected < sections.length - 1 && <button onClick={() => setSelected(selected + 1)}>Next: {sections[selected + 1].title} <Icon name="arrow" size={15} /></button>}</div></main>
      </div>
    </section>
  </div>
}
