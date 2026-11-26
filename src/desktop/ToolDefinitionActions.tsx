import { useEffect, useState } from 'react'
import { api } from './client'
import WorkspaceDialog from './WorkspaceDialog'

export type ToolDefinition = { name: string; transport: string; scope: 'global' | 'project' }
export default function ToolDefinitionActions({ agent, name, projectId, repositoryId, onEdit, onChanged }: { agent: 'codex' | 'claude' | 'opencode'; name: string; projectId: string; repositoryId: string; onEdit: (definition: ToolDefinition) => void; onChanged: () => Promise<void> }) {
  const [owned, setOwned] = useState<ToolDefinition[]>([]), [error, setError] = useState(''), [removing, setRemoving] = useState<ToolDefinition | null>(null), [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const scopes = ['global', ...(projectId ? ['project'] : [])] as ('global' | 'project')[]
    void Promise.all(scopes.map(async scope => {
      const result = await api<{ servers: { name: string; transport: string; managed?: boolean; inheritedCopy?: boolean }[] }>(`/${agent}/mcp-managed?profileId=system&scope=${agent === 'claude' && scope === 'project' ? 'local' : scope}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`)
      return result.servers.filter(row => row.name === name && row.managed !== false && !row.inheritedCopy).map(row => ({ name: row.name, transport: row.transport, scope }))
    })).then(rows => { if (active) setOwned(rows.flat()) }).catch(cause => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [agent, name, projectId, repositoryId])
  const remove = async () => {
    if (!removing || busy) return
    setBusy(true); setError('')
    try {
      await api(`/${agent}/mcp-managed`, { profileId: 'system', projectId, repositoryId, scope: agent === 'claude' && removing.scope === 'project' ? 'local' : removing.scope, action: 'remove', name })
      setOwned(rows => rows.filter(row => row.scope !== removing.scope)); setRemoving(null); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return <>{owned.map(definition => <div className="tools-definition-actions" key={definition.scope}><span>{definition.scope === 'global' ? 'Global' : 'Linked project'} · Mr. Mik definition</span><div><button type="button" onClick={() => onEdit(definition)}>Edit definition</button><button type="button" className="danger" onClick={() => setRemoving(definition)}>Remove definition</button></div></div>)}{error && !removing && <p role="alert" className="desk-error-inline">{error}</p>}{removing && <WorkspaceDialog label="Remove MCP definition?" role="alertdialog" busy={busy} close={() => setRemoving(null)}><h3>Remove MCP definition?</h3><p>Remove {name} from {removing.scope === 'global' ? 'the global configuration for all projects' : 'this linked project'}? Other definitions, account logins and conversations are preserved.</p>{error && <p role="alert" className="desk-error-inline">{error}</p>}<footer><button disabled={busy} onClick={() => setRemoving(null)}>Cancel</button><button disabled={busy} className="danger" onClick={() => void remove()}>Remove definition</button></footer></WorkspaceDialog>}</>
}
