import { useEffect, useState } from 'react'
import { api, reportError, useDesktop } from './client'
import { Icon } from './Icons'
import DarkSelect from './DarkSelect'

type HubSkill = { id: string; name: string; description: string; global: boolean; projectOverride: boolean | null; effective: boolean; projectCount: number }

export default function HubSkills({ agent, revision = 0, folder, onOpen }: { agent: 'codex' | 'claude' | 'opencode'; revision?: number; folder: string; onOpen: (path: string) => void }) {
  const { settings, projects, preview } = useDesktop()
  const projectId = settings.selectedProjectId || ''
  const project = projects.find(item => item.id === projectId)
  const [skills, setSkills] = useState<HubSkill[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api<HubSkill[]>(`/hub/skills?projectId=${encodeURIComponent(projectId)}&agent=${agent}`).then(items => { if (active) { setSkills(items); setError('') } }).catch(cause => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [projectId, agent, revision])
  const activeScope = project ? 'project' : 'global'
  async function change(id: string, scope: 'global' | 'project', enabled: boolean | null) {
    setBusy(id)
    try {
      await api('/hub/skills/scope', { id, scope, projectId: scope === 'project' ? projectId : null, enabled, agent })
      setSkills(await api<HubSkill[]>(`/hub/skills?projectId=${encodeURIComponent(projectId)}&agent=${agent}`))
    } catch (error) { reportError(error) } finally { setBusy('') }
  }
  const shown = skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  const renderSkill = (skill: HubSkill) => <div className={`hub-skill skill-catalog-row${preview?.path.replace(/\\/g, '/').toLowerCase() === `${folder}/${skill.id}/SKILL.md`.replace(/\\/g, '/').toLowerCase() ? ' selected' : ''}`} key={skill.id}>
    <button type="button" className="skill-open" title={skill.description || skill.name} onClick={() => onOpen(`${folder}/${skill.id}/SKILL.md`)}><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}</button>
    <DarkSelect appearance="workspace" icon="" label={`${skill.name} ${activeScope === 'global' ? 'global' : 'project'} setting`} value={activeScope === 'global' ? skill.global ? 'on' : 'off' : skill.projectOverride === null ? 'inherited' : skill.projectOverride ? 'on' : 'off'} disabled={!!busy} onChange={value => void change(skill.id, activeScope, value === 'inherited' ? null : value === 'on')} options={[...(activeScope === 'project' ? [{ value: 'inherited', label: `Inherit · ${skill.global ? 'On' : 'Off'}` }] : []), { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
  </div>
  return <section className="hub-skills" aria-label="Skill management">
    <>
      <label className="skills-search"><Icon name="search" size={16} /><input className="skill-search" aria-label="Find Hub skill" placeholder="Find a skill…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {error && <p role="alert" className="desk-error-inline">{error}</p>}
      <div className="hub-skill-list">{activeScope === 'global' ? <><h4>Global Hub skills</h4>{shown.map(renderSkill)}</> : <>
        {shown.some(skill => skill.global) && <><h4>Shared from Global Hub</h4>{shown.filter(skill => skill.global).map(renderSkill)}</>}
        {shown.some(skill => !skill.global) && <><h4>Other Hub skills</h4>{shown.filter(skill => !skill.global).map(renderSkill)}</>}
      </>}</div>
      {!skills.length && <p>No local Hub skills found in {agent === 'claude' ? '.claude' : '.agents'}/skills.</p>}
      {!!skills.length && !shown.length && <p>No matching skills.</p>}
      <details className="skills-availability"><summary><Icon name="info" size={16} />Availability</summary><p>{activeScope === 'global' ? 'On enables a skill in every workspace. Off keeps any workspace-specific selections.' : 'Inherit follows the Global Hub setting. On or Off overrides it only in this workspace.'} Discoverable in new workspace chats through the Workspace Bridge. Full instructions are read on request.</p></details>
      <footer className="skills-count">{shown.length} skills · {agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'OpenCode'}</footer>
    </>
  </section>
}
