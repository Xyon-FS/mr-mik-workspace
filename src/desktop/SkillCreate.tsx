import { useState } from 'react'
import { api, reportError, useDesktop } from './client'
import WorkspaceDialog from './WorkspaceDialog'
import DarkSelect from './DarkSelect'
import { Icon } from './Icons'

export default function SkillCreate({ agent, initialTarget, preferredLinkedId, onCreated, onClose }: { agent: 'codex' | 'claude' | 'opencode'; initialTarget: 'hub' | 'linked'; preferredLinkedId: string; onCreated: (skill: { path: string; repositoryId: string | null }) => void; onClose: () => void }) {
  const { settings, projects } = useDesktop()
  const workspace = projects.find(item => item.id === settings.selectedProjectId)
  const linked = workspace?.repositories.filter(item => item.available) || []
  const [target, setTarget] = useState<'hub' | 'linked'>(initialTarget === 'linked' && linked.length ? 'linked' : 'hub')
  const [linkedId, setLinkedId] = useState(preferredLinkedId && linked.some(item => item.id === preferredLinkedId) ? preferredLinkedId : linked.length === 1 ? linked[0].id : '')
  const [scope, setScope] = useState<'global' | 'project'>(workspace ? 'project' : 'global')
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const create = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const skill = await api<{ path: string; repositoryId: string | null }>('/skills/create', { target, agent, projectId: workspace?.id || null, repositoryId: target === 'linked' ? linkedId : null, name, description, instructions })
      if (target === 'hub') await api('/hub/skills/scope', { id: name, agent, scope, projectId: scope === 'project' ? workspace?.id : null, enabled: true })
      onCreated(skill)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); reportError(cause) }
    finally { setBusy(false) }
  }
  return <WorkspaceDialog label="Add skill" close={onClose} busy={busy}><section className="skills-create-dialog" aria-label="Add skill">
    <header><h2>Add {agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'OpenCode'} skill</h2><button className="desk-icon" type="button" disabled={busy} onClick={onClose} aria-label="Close Add skill"><Icon name="close" size={16} /></button></header>
    <form onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="skill-create-target" role="group" aria-label="Skill destination"><button type="button" aria-pressed={target === 'hub'} disabled={busy} onClick={() => setTarget('hub')}>Hub skill</button><button type="button" aria-pressed={target === 'linked'} disabled={busy || !linked.length} onClick={() => setTarget('linked')}>Linked project skill</button></div>
      <p>{target === 'hub' ? 'Available through the Workspace Bridge in new chats.' : 'Creates native files in the selected external project.'}</p>
      {target === 'hub' ? <label>Enable for<DarkSelect appearance="workspace" icon="" label="Enable for" value={scope} disabled={busy} options={[...(workspace ? [{ value: 'project', label: 'This workspace' }] : []), { value: 'global', label: 'All workspaces' }]} onChange={value => setScope(value as 'global' | 'project')} /></label> : <label>Linked project<DarkSelect appearance="workspace" icon="" label="Skill linked project" placeholder="Choose a linked project…" value={linkedId} disabled={busy} options={[{ value: '', label: 'Choose a linked project…', disabled: true }, ...linked.map(item => ({ value: item.id, label: item.name }))]} onChange={setLinkedId} /></label>}
      <label>Skill name<input autoFocus required pattern="[a-z0-9][a-z0-9\-]{0,63}" disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="asset-handoff" /></label>
      <label>When should it be used?<input required maxLength={500} disabled={busy} value={description} onChange={event => setDescription(event.target.value)} placeholder="Use when handing off assets between teams." /></label>
      <label>Instructions<textarea required rows={5} disabled={busy} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Describe the workflow and checks…" /></label>
      {error && <p role="alert" className="desk-error-inline">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy || target === 'linked' && !linkedId}>{busy ? 'Creating…' : 'Create skill'}</button></footer>
    </form>
  </section></WorkspaceDialog>
}
