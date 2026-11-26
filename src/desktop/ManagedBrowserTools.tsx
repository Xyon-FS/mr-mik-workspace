import { useEffect, useState } from 'react'
import { api, useDesktop } from './client'
import type { Settings } from './types'
import DarkSelect from './DarkSelect'
import ToolEntry, { ToolScopeSelect } from './ToolEntry'
import WorkspaceDialog from './WorkspaceDialog'

type BrowserChoice = NonNullable<Settings['managedBrowser']>
type BrowserInfo = { desired: { choice: string; presentation: string; temporary: boolean }; pending: boolean }

export default function ManagedBrowserTools() {
  const { settings, projects, selectedId, sessions } = useDesktop()
  const project = projects.find(item => item.id === settings.selectedProjectId)
  const projectId = project?.id
  const session = sessions.find(item => item.id === selectedId)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [clearConfirmation, setClearConfirmation] = useState(false)
  const [info, setInfo] = useState<BrowserInfo | null>(null)
  useEffect(() => {
    let disposed = false
    void api<BrowserInfo>(`/browser-settings?${selectedId ? `sessionId=${encodeURIComponent(selectedId)}` : projectId ? `projectId=${encodeURIComponent(projectId)}` : ''}`).then(result => { if (!disposed) setInfo(result) }).catch(cause => { if (!disposed) setError(cause.message) })
    return () => { disposed = true }
  }, [selectedId, projectId, settings])
  const change = async (patch: object, endpoint = '/browser-settings') => {
    setBusy(true); setError('')
    try { const result = await api<BrowserInfo>(endpoint, patch); if (endpoint === '/browser-settings') setInfo(result) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const scope = project ? { scope: 'project', projectId: project.id } : { scope: 'global' }
  const stored = project ? settings.managedBrowserProjects?.[project.id] : settings.managedBrowser
  const inherited = settings.managedBrowser || 'off'
  const effective = stored ?? inherited
  const channel: BrowserChoice = effective !== 'off' ? effective : inherited !== 'off' ? inherited : 'chrome'
  const availability = project && stored == null ? 'inherit' : effective === 'off' ? 'off' : 'on'
  const presentation = project ? settings.managedBrowserPresentationProjects?.[project.id] || 'inherit' : settings.managedBrowserPresentation || 'workspace'
  const modes = [{ value: 'workspace', label: 'Workspace' }, { value: 'external', label: 'External window' }]
  const browsers = [{ value: 'off', label: 'Off' }, { value: 'msedge', label: 'Microsoft Edge' }, { value: 'chrome', label: 'Google Chrome' }]
  const globalOn = !!settings.managedBrowser && settings.managedBrowser !== 'off'
  return <ToolEntry name="Browser" subtitle="Playwright" browser value={effective === 'off' ? 'Off' : 'On'} inherited={availability === 'inherit'} locked={busy} availability={<div className="mcp-scope-controls"><label>Global<ToolScopeSelect label="Global browser availability" disabled={busy} value={globalOn ? 'on' : 'off'} options={[{value:'on',label:'On'},{value:'off',label:'Off'}]} onChange={value => void change({scope:'global',choice:value === 'off' ? 'off' : globalOn ? settings.managedBrowser : 'chrome'})} /></label>{project && <label>Workspace<ToolScopeSelect label="Browser availability" disabled={busy} value={availability} options={[{value:'inherit',label:'Inherit'},{value:'on',label:'On'},{value:'off',label:'Off'}]} onChange={value => void change({...scope,choice:value === 'inherit' ? null : value === 'off' ? 'off' : channel})} /></label>}</div>}>
    {() => <section className="managed-browser-tools" aria-label="Mr. Mik browser tools">
    <label className="tools-browser-presentation">Open in<DarkSelect appearance="workspace" label="Browser presentation" icon="" disabled={busy} value={presentation} options={[...(project ? [{ value: 'inherit', label: 'Use global setting' }] : []), ...modes]} onChange={value => void change({ ...scope, presentation: value === 'inherit' ? null : value })} /></label>
    {info?.pending && <p className="mcp-note" role="status">Browser change pending · return manual control to apply.</p>}
    <details className="mcp-sources"><summary>Advanced</summary>
      <label>Browser engine<DarkSelect appearance="workspace" label="Browser engine" icon="" disabled={busy} value={channel} options={browsers.filter(item => item.value !== 'off')} onChange={choice => void change({ ...scope, choice })} /></label>
      <label className="managed-browser-window"><input type="checkbox" checked={settings.managedBrowserHeadless !== true} disabled={busy} onChange={event => void change({ managedBrowserHeadless: !event.target.checked }, '/settings')} />Show browser window in CLI chats</label>
      {session && <div className="mcp-scope-controls">
        <label>This chat · browser<DarkSelect appearance="workspace" label="Chat browser" icon="" disabled={busy} value={settings.managedBrowserChats?.[session.id]?.choice || 'inherit'} options={[{ value: 'inherit', label: 'Use defaults' }, ...browsers]} onChange={value => void change({ scope: 'chat', sessionId: session.id, choice: value === 'inherit' ? null : value })} /></label>
        {session.chatInterface === 'chat' && <label>This chat · open in<DarkSelect appearance="workspace" label="Chat browser mode" icon="" disabled={busy} value={settings.managedBrowserChats?.[session.id]?.presentation || 'inherit'} options={[{ value: 'inherit', label: 'Use defaults' }, ...modes]} onChange={value => void change({ scope: 'chat', sessionId: session.id, presentation: value === 'inherit' ? null : value })} /></label>}
      </div>}
      <p className="mcp-note">CLI browsers use a separate temporary session. Changing presentation restarts only the graphical browser; unsaved page state may be lost.</p>
    </details>
    {session?.chatInterface === 'chat' && <details className="mcp-sources"><summary>Website data</summary>
      <label className="managed-browser-window"><input type="checkbox" disabled={busy} checked={info?.desired.temporary === true} onChange={event => void change({ scope: 'chat', sessionId: session.id, temporary: event.target.checked })} />Temporary website session</label>
      <button type="button" className="desk-secondary" disabled={busy || info?.desired.choice === 'off'} onClick={() => setClearConfirmation(true)}>Clear website data</button>
    </details>}
    {clearConfirmation && <WorkspaceDialog label="Clear website data?" role="alertdialog" close={() => setClearConfirmation(false)} busy={busy}><h3>Clear website data?</h3><p>This signs out of websites for this chat and browser. Agent account login is unchanged.</p><footer><button disabled={busy} onClick={() => setClearConfirmation(false)}>Cancel</button><button disabled={busy} onClick={() => { void change({action: 'clear', sessionId: session?.id, confirmed: true}).then(() => setClearConfirmation(false)) }}>Clear website data</button></footer></WorkspaceDialog>}
    {error && <p role="alert" className="mcp-note">{error}</p>}
  </section>}
  </ToolEntry>
}
