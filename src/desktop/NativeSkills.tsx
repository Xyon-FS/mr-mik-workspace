import { useEffect, useState } from 'react'
import { api, reportError } from './client'
import DarkSelect from './DarkSelect'

type NativeSkill = { kind: string; id: string; name: string; source: string; projectOverride: boolean | null; projectDefined: boolean; projectEditable: boolean; requiresApproval?: boolean }
type Inventory = { rows: NativeSkill[]; notice?: string }

export default function NativeSkills({ projectId, repositoryId, agent = 'codex' }: { projectId: string; repositoryId: string; agent?: 'codex' | 'claude' | 'opencode' }) {
  const [skills, setSkills] = useState<NativeSkill[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void api<Inventory>(`/${agent}/scopes?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)
      .then(value => { if (active) { setSkills(value.rows.filter(row => row.kind === 'skill')); setNotice(value.notice || '') } }).catch(reportError)
    return () => { active = false }
  }, [projectId, repositoryId, agent])
  const change = async (skill: NativeSkill, enabled: boolean | null) => {
    setBusy(skill.id)
    try {
      await api(`/${agent}/scopes`, { projectId, repositoryId, kind: 'skill', id: skill.id, enabled })
      const value = await api<Inventory>(`/${agent}/scopes?projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)
      setSkills(value.rows.filter(row => row.kind === 'skill'))
    } catch (error) { reportError(error) } finally { setBusy('') }
  }
  const label = agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'OpenCode'
  return <details className="project-native-skills"><summary>{label} skill controls <small>{skills.length} discovered · selected linked project</small></summary>
    <p>These are native skill files. Linked-project settings can override their availability in new {label} chats. Managed policy still applies.</p>
    {agent === 'opencode' && notice && <p>{notice}</p>}
    {agent !== 'codex' && skills.map(skill => <label key={skill.id} className="project-native-skill"><span title={`Native ID: ${skill.id}`}>{skill.name}<small>{skill.source}{skill.requiresApproval && ' · Native approval may be required'}</small></span><DarkSelect compact label={`${skill.name} native ${label} setting`} disabled={!!busy || !skill.projectEditable} value={skill.projectOverride === null ? 'inherit' : skill.projectOverride ? 'on' : 'off'} options={[{ value: 'inherit', label: 'Inherit' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={value => void change(skill, value === 'inherit' ? null : value === 'on')} /></label>)}
    {agent === 'codex' && skills.map(skill => <label key={skill.id} className="project-native-skill"><span title={skill.id}>{skill.name}<small>{skill.source}</small></span><select aria-label={`${skill.name} native project setting`} disabled={!!busy || !skill.projectEditable} value={skill.projectOverride == null ? skill.projectDefined ? 'defined' : 'inherit' : skill.projectOverride ? 'on' : 'off'} onChange={event => void change(skill, event.target.value === 'inherit' ? null : event.target.value === 'on')}><option value="inherit" disabled={skill.projectDefined}>Inherit</option>{skill.projectDefined && <option value="defined" disabled>Defined here</option>}<option value="on">On</option><option value="off">Off</option></select></label>)}
    {!skills.length && <p>No native {label} skills discovered for this folder.</p>}
  </details>
}
