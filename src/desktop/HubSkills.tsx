import { useEffect, useState } from 'react'
import { api, reportError, useDesktop } from './client'

type HubSkill = { id: string; name: string; description: string; global: boolean; projectOverride: boolean | null; effective: boolean; projectCount: number }

export default function HubSkills({ agent }: { agent: 'codex' | 'claude' }) {
  const { settings, projects } = useDesktop()
  const projectId = settings.selectedProjectId || ''
  const project = projects.find(item => item.id === projectId)
  const [skills, setSkills] = useState<HubSkill[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    let active = true
    void api<HubSkill[]>(`/hub/skills?projectId=${encodeURIComponent(projectId)}&agent=${agent}`).then(items => { if (active) setSkills(items) }).catch(reportError)
    return () => { active = false }
  }, [projectId, agent])
  const activeScope = project ? 'project' : 'global'
  async function change(id: string, scope: 'global' | 'project', enabled: boolean | null) {
    setBusy(id)
    try {
      await api('/hub/skills/scope', { id, scope, projectId: scope === 'project' ? projectId : null, enabled, agent })
      setSkills(await api<HubSkill[]>(`/hub/skills?projectId=${encodeURIComponent(projectId)}&agent=${agent}`))
    } catch (error) { reportError(error) } finally { setBusy('') }
  }
  const shown = skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  const renderSkill = (skill: HubSkill) => <div className="hub-skill" key={skill.id}>
    <div><strong>{skill.name}</strong>{skill.description && <small title={skill.description}>{skill.description}</small>}</div>
    {activeScope === 'global' ? <select aria-label={`${skill.name} global setting`} value={skill.global ? 'on' : 'off'} disabled={!!busy} onChange={event => void change(skill.id, 'global', event.target.value === 'on')}><option value="on">On</option><option value="off">Off</option></select>
      : <select aria-label={`${skill.name} project setting`} value={skill.projectOverride === null ? 'inherited' : skill.projectOverride ? 'on' : 'off'} disabled={!!busy} onChange={event => void change(skill.id, 'project', event.target.value === 'inherited' ? null : event.target.value === 'on')}><option value="inherited">Inherit ({skill.global ? 'On' : 'Off'})</option><option value="on">On</option><option value="off">Off</option></select>}
  </div>
  return <section className="hub-skills" aria-label="Skill management">
    <>
      <h3>Mr. Mik Hub skills <small>{project ? `${project.name} · Workspace Bridge` : 'Global · Workspace Bridge'}</small></h3>
      <p>Discoverable in new {agent === 'codex' ? 'Codex' : 'Claude'} workspace chats. Full instructions are read on request; linked-project skills remain native.</p>
      <input className="skill-search" aria-label="Find Hub skill" placeholder="Find a skill…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="hub-skill-list">{activeScope === 'global' ? <><h4>Global Hub skills</h4>{shown.map(renderSkill)}</> : <>
        {shown.some(skill => skill.global) && <><h4>Shared from Global Hub</h4>{shown.filter(skill => skill.global).map(renderSkill)}</>}
        {shown.some(skill => !skill.global) && <><h4>Other Hub skills</h4>{shown.filter(skill => !skill.global).map(renderSkill)}</>}
      </>}</div>
      {!skills.length && <p>No local Hub skills found in {agent === 'codex' ? '.agents' : '.claude'}/skills.</p>}
      {!!skills.length && !shown.length && <p>No matching skills.</p>}
      {activeScope === 'global' && <p>On enables a skill in every workspace. Off keeps any workspace-specific selections.</p>}
      {activeScope === 'project' && <p>Inherit follows the Hub default. On or Off overrides it only in this workspace.</p>}
    </>
  </section>
}
