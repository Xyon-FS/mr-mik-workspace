import { useEffect, useState } from 'react'
import { api, reportError, useDesktop } from './client'
import DarkSelect from './DarkSelect'
import { Icon } from './Icons'

type NativeSkill = { kind: string; id: string; name: string; source: string; path?: string; location?: string; projectOverride: boolean | null; projectDefined: boolean; projectEditable: boolean; requiresApproval?: boolean }
type Inventory = { rows: NativeSkill[]; notice?: string }

export default function NativeSkills({ projectId, repositoryId, agent = 'codex', revision = 0, onOpen }: { projectId: string; repositoryId: string; agent?: 'codex' | 'claude' | 'opencode'; revision?: number; onOpen: (path: string) => void }) {
  const { preview } = useDesktop()
  const [skills, setSkills] = useState<NativeSkill[]>([])
  const [busy, setBusy] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void api<Inventory>(`/${agent}/scopes?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)
      .then(value => { if (active) { setSkills(value.rows.filter(row => row.kind === 'skill')); setNotice(value.notice || ''); setError('') } }).catch(cause => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [projectId, repositoryId, agent, revision])
  const change = async (skill: NativeSkill, enabled: boolean | null) => {
    setBusy(skill.id)
    try {
      await api(`/${agent}/scopes`, { projectId, repositoryId, kind: 'skill', id: skill.id, enabled })
      const value = await api<Inventory>(`/${agent}/scopes?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)
      setSkills(value.rows.filter(row => row.kind === 'skill'))
    } catch (cause) { reportError(cause) } finally { setBusy('') }
  }
  const label = agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'OpenCode'
  const shown = skills.filter(skill => `${skill.name} ${skill.source}`.toLowerCase().includes(query.toLowerCase()))
  return <section className="project-native-skills skill-catalog" aria-label={`${label} skill controls`}>
    <label className="skills-search"><Icon name="search" size={16} /><input className="skill-search" aria-label="Find native skill" placeholder="Find a skill…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {error && <p role="alert" className="desk-error-inline">{error}</p>}
    <h4>Native skills</h4>
    {shown.map(skill => {
      const path = skill.path || skill.location || (/[/\\]/.test(skill.id) ? skill.id : /[/\\]SKILL\.md$/i.test(skill.source) ? skill.source : '')
      const selected = path && preview?.path.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase()
      const defined = agent === 'codex' && skill.projectDefined
      return <div key={skill.id} className={`project-native-skill skill-catalog-row${selected ? ' selected' : ''}`}>
        <button type="button" className="skill-open" disabled={!path} title={path || skill.id} onClick={() => onOpen(path)}><strong>{skill.name}</strong><small>{skill.source}{skill.requiresApproval && ' · Approval may be required'}</small></button>
        <DarkSelect appearance="workspace" icon="" label={`${skill.name} native ${agent === 'codex' ? 'project' : label} setting`} disabled={!!busy || !skill.projectEditable} value={skill.projectOverride == null ? defined ? 'defined' : 'inherit' : skill.projectOverride ? 'on' : 'off'} options={[{ value: 'inherit', label: 'Inherit', disabled: defined }, ...(defined ? [{ value: 'defined', label: 'Defined here', disabled: true }] : []), { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void change(skill, value === 'inherit' ? null : value === 'on')} />
      </div>
    })}
    {!skills.length && <p>No native {label} skills discovered for this folder.</p>}
    {!!skills.length && !shown.length && <p>No matching skills.</p>}
    <details className="skills-availability"><summary><Icon name="info" size={16} />Availability</summary><p>Native files belong to the selected linked project. Settings apply in new {label} chats. Managed policy and native approval still apply.</p>{notice && <p>{notice}</p>}</details>
    <footer className="skills-count">{shown.length} skills · {label}</footer>
  </section>
}
