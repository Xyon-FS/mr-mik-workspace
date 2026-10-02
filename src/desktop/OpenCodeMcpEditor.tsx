import { useEffect, useState } from 'react'
import { api } from './client'
import DarkSelect from './DarkSelect'

type Definitions = { servers: { name: string; transport: string; managed: boolean }[]; note: string }
export default function OpenCodeMcpEditor({ projectId, repositoryId, scope, onSaved }: { projectId: string; repositoryId: string; scope: string; onSaved: () => Promise<void> }) {
  const [definitions, setDefinitions] = useState<Definitions | null>(null)
  const [name, setName] = useState(''), [transport, setTransport] = useState('stdio'), [url, setUrl] = useState(''), [command, setCommand] = useState(''), [args, setArgs] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [removing, setRemoving] = useState('')
  useEffect(() => {
    let active = true
    void api<Definitions>(`/opencode/mcp-managed?scope=${scope}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`).then(value => { if (active) setDefinitions(value) }).catch(cause => { if (active) setError(String(cause.message || cause)) })
    return () => { active = false }
  }, [scope, projectId, repositoryId])
  const change = async (action: 'save' | 'remove', server = name) => {
    setBusy(true); setError('')
    try {
      await api('/opencode/mcp-managed', { projectId, repositoryId, scope, action, name: server, transport, url, command, args: args.split('\n').map(value => value.trim()).filter(Boolean), enabled: true })
      setDefinitions(await api<Definitions>(`/opencode/mcp-managed?scope=${scope}&projectId=${encodeURIComponent(projectId)}&repositoryId=${encodeURIComponent(repositoryId)}`))
      setRemoving(''); setName(''); setUrl(''); setCommand(''); setArgs(''); await onSaved()
    } catch (cause) { setError(String((cause as Error).message || cause)) }
    finally { setBusy(false) }
  }
  return <section className="mcp-editor"><p>{scope === 'global' ? 'Global OpenCode configuration applies across linked projects.' : 'Writes OpenCode configuration only in the selected linked project folder.'} Affected open chats update when safe; pending updates can be applied in Chats. No software or login is installed.</p>
    <p>{definitions?.note}</p>
    {definitions?.servers.map(server => <div className="mcp-managed-row" key={server.name}><span>{server.name} · {server.transport}</span><div><button disabled={busy || !server.managed} onClick={() => { setName(server.name); setTransport(server.transport) }}>Edit</button><button disabled={busy || !server.managed} onClick={() => setRemoving(server.name)}>Remove</button></div></div>)}
    {removing && <div className="mcp-note" role="alert">Remove the owned definition {removing}?<div><button disabled={busy} onClick={() => setRemoving('')}>Cancel</button><button disabled={busy} onClick={() => void change('remove', removing)}>Remove definition</button></div></div>}
    <form onSubmit={event => { event.preventDefault(); void change('save') }}><label>Server name<input required pattern="[A-Za-z_][A-Za-z_0-9-]*" maxLength={64} value={name} onChange={event => setName(event.target.value)} /></label><label>Transport<DarkSelect label="OpenCode MCP transport" value={transport} options={[{ value: 'stdio', label: 'Local process (stdio)' }, { value: 'http', label: 'HTTP' }]} onChange={setTransport} /></label>{transport === 'http' ? <label>MCP URL<input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></label> : <><label>Command<input required value={command} onChange={event => setCommand(event.target.value)} placeholder="node" /></label><label>Arguments · one per line<textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} /></label></>}<button disabled={busy || scope === 'project' && !projectId}>Save definition</button></form>
    <p>Existing external definitions can be switched in Tools, but not replaced here. Headers and environment credentials stay in their original configuration. Remote OAuth is handled by OpenCode.</p>
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
  </section>
}
