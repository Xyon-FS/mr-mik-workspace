import { useState } from 'react'
import { api, reportError, useDesktop } from './client'

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
    setBusy(true); setError('')
    try {
      const skill = await api<{ path: string; repositoryId: string | null }>('/skills/create', { target, agent, projectId: workspace?.id || null, repositoryId: target === 'linked' ? linkedId : null, name, description, instructions })
      if (target === 'hub') await api('/hub/skills/scope', { id: name, agent, scope, projectId: scope === 'project' ? workspace?.id : null, enabled: true })
      onCreated(skill)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); reportError(cause) }
    finally { setBusy(false) }
  }
  return <section className="skill-create" aria-label="Add skill"><header><strong>Add {agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'OpenCode'} skill</strong><button type="button" onClick={onClose} aria-label="Close Add skill">×</button></header>
    <div className="skill-create-target" role="group" aria-label="Skill destination"><button type="button" className={target === 'hub' ? 'selected' : ''} onClick={() => setTarget('hub')}>Hub skill</button><button type="button" className={target === 'linked' ? 'selected' : ''} disabled={!linked.length} onClick={() => setTarget('linked')}>Linked project skill</button></div>
    <p>{target === 'hub' ? 'Saved in Mr. Mik. Available through the Workspace Bridge in new chats.' : 'Creates a native skill in the selected external project folder. This writes to that folder.'}</p>
    {target === 'hub' ? <label>Enable for<select value={scope} onChange={event => setScope(event.target.value as 'global' | 'project')}><option value="global">All workspaces</option>{workspace && <option value="project">{workspace.name} only</option>}</select></label> : <label>Linked project<select aria-label="Skill linked project" required value={linkedId} onChange={event => setLinkedId(event.target.value)}><option value="">Choose a linked project…</option>{linked.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    <form onSubmit={event => { event.preventDefault(); void create() }}><label>Skill name<input required pattern="[a-z0-9][a-z0-9-]{0,63}" value={name} onChange={event => setName(event.target.value)} placeholder="asset-handoff" /></label><label>When should it be used?<input required maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="Use when handing off assets between teams." /></label><label>Instructions<textarea required rows={5} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Describe the workflow and checks…" /></label><button disabled={busy || target === 'linked' && !linkedId}>{busy ? 'Creating…' : 'Create skill'}</button></form>
    {error && <p role="alert" className="desk-error-inline">{error}</p>}
  </section>
}
