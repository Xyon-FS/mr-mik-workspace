import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'

export type CompletionSkill = { name: string; path: string; description: string }
export default function SkillCompletionMenu({ host, id, skills, selected, loading, error, warning, blocked, close, choose, retry }: { host: HTMLElement; id: string; skills: CompletionSkill[]; selected: number; loading: boolean; error: string; warning: string; blocked: (skill: CompletionSkill) => string; close: () => void; choose: (skill: CompletionSkill) => void; retry: () => void }) {
  const menu = useRef<HTMLDivElement>(null), [height, setHeight] = useState(340)
  useLayoutEffect(() => {
    const measure = () => setHeight(Math.max(90, Math.min(340, host.getBoundingClientRect().top - 10)))
    measure(); const observer = new ResizeObserver(measure); observer.observe(host)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [host])
  useLayoutEffect(() => {
    const list = menu.current?.querySelector<HTMLElement>('.skill-completion-list'), row = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !row) return
    const viewport = list.getBoundingClientRect(), bounds = row.getBoundingClientRect()
    if (bounds.top < viewport.top) list.scrollTop -= viewport.top - bounds.top
    else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom
  }, [selected])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!host.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [host, close])
  return createPortal(<div ref={menu} className="graphical-skill-completion" style={{ maxHeight: height }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); host.querySelector('textarea')?.focus() } }}>
    <header><strong>Skills</strong>{!loading && !!skills.length && <small>{skills.length} {skills.length === 1 ? 'skill' : 'skills'}</small>}</header>
    <div id={id} role="listbox" aria-label="Available skills" aria-busy={loading} className="skill-completion-list">
      {loading ? <p role="status">Loading skills…</p> : error ? <p role="alert">{error}<button type="button" onClick={retry}>Retry</button></p> : !skills.length ? <p role="status">No available skills match.</p> : skills.map((skill, index) => <button type="button" role="option" tabIndex={-1} key={skill.path} id={`${id}-${index}`} aria-selected={index === selected} disabled={!!blocked(skill)} title={blocked(skill) || skill.description || skill.name} onPointerDown={event => event.preventDefault()} onClick={() => choose(skill)}><Icon name="skills" size={16} /><span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}</span>{index === selected && <span aria-hidden="true" className="skill-completion-return">↵</span>}</button>)}
    </div>
    <footer>{warning || (skills[selected] && blocked(skills[selected])) || <><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> insert</span><span><kbd>esc</kbd> close</span></>}</footer>
  </div>, host)
}
