import { useState } from 'react'
import WorkspaceDialog from './WorkspaceDialog'
import { Icon } from './Icons'
import { api, pickFiles, useDesktop } from './client'

type SnapshotPreview = { path: string; metadataConflict: boolean; manifest: { project: { id: string; name: string; repositories: { id: string; name: string }[] }; cards: unknown[]; resources: unknown[] }; files: { name: string; status: string }[] }
type UpdatePreview = { path: string; projectId: string; changed: string[]; removed: string[] }

export default function WorkspaceSnapshotSettings() {
  const { settings, projects } = useDesktop()
  const project = projects.find(item => item.id === settings.selectedProjectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<SnapshotPreview | null>(null)
  const [update, setUpdate] = useState<UpdatePreview | null>(null)
  const [replace, setReplace] = useState<string[]>([])
  const [metadata, setMetadata] = useState(false)
  const [relinks, setRelinks] = useState<Record<string, string>>({})
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const choose = async () => (await pickFiles({ window: 'workspace', folder: true }))[0]
  const exportNew = () => void action(async () => {
    if (!project) return
    const folder = await choose(); if (!folder) return
    const result = await api<{ path: string; files: number }>('/workspace/snapshot/export', { folder, projectId: project.id })
    setMessage(`Workspace exported: ${result.path} · ${result.files} files. Review the content before committing it to Git.`)
  })
  const previewImport = () => void action(async () => {
    const folder = await choose(); if (!folder) return
    setPreview(await api<SnapshotPreview>('/workspace/snapshot/preview', { folder })); setReplace([]); setMetadata(false); setRelinks({}); setUpdate(null)
  })
  const previewUpdate = () => void action(async () => {
    if (!project) return
    const folder = await choose(); if (!folder) return
    setUpdate(await api<UpdatePreview>('/workspace/snapshot/update/preview', { folder, projectId: project.id })); setPreview(null)
  })
  const importSnapshot = () => void action(async () => {
    if (!preview) return
    const result = await api<{ backup: string }>('/workspace/snapshot/import', { folder: preview.path, replaceFiles: replace, replaceMetadata: metadata, relinks })
    setMessage(`Workspace imported. Backup: ${result.backup}`); setPreview(null)
  })
  const updateSnapshot = () => void action(async () => {
    if (!update) return
    const result = await api<{ backup: string }>('/workspace/snapshot/update', { folder: update.path, projectId: update.projectId })
    setMessage(`Snapshot updated. Replaced and removed files backed up in: ${result.backup}`); setUpdate(null)
  })
  return <section className="portable-settings"><h3>Workspace snapshot · Git</h3>
    <p>Share workspace files without chats, accounts or linked folders. Review content before sharing.</p>
    <p>{project ? `${project.name}` : 'Select a workspace to export.'}</p>
    <div className="portable-actions"><button disabled={busy || !project} onClick={exportNew}>Export workspace…</button><button disabled={busy || !project} onClick={previewUpdate}>Update snapshot…</button><button disabled={busy} onClick={previewImport}>Import snapshot…</button></div>
    {update && <WorkspaceDialog label="Update workspace snapshot" busy={busy} close={() => setUpdate(null)}><header className="settings-dialog-heading"><h3>Update workspace snapshot</h3><button className="desk-icon" aria-label="Close update workspace snapshot" disabled={busy} onClick={() => setUpdate(null)}><Icon name="close" size={16} /></button></header><div className="portable-preview"><small>{update.path}</small><p>{update.changed.length} changed/new files · {update.removed.length} removed files. Only files tracked by the previous manifest will be removed; backups stay outside Git.</p>{update.removed.map(name => <small key={name}>Remove: {name}</small>)}{error && <p className="desk-error-inline" role="alert">{error}</p>}<div className="portable-actions"><button disabled={busy} onClick={updateSnapshot}>Confirm update with backup</button><button disabled={busy} onClick={() => setUpdate(null)}>Cancel</button></div></div></WorkspaceDialog>}
    {preview && <WorkspaceDialog label="Import workspace snapshot" busy={busy} close={() => setPreview(null)}><header className="settings-dialog-heading"><h3>Import workspace snapshot</h3><button className="desk-icon" aria-label="Close import workspace snapshot" disabled={busy} onClick={() => setPreview(null)}><Icon name="close" size={16} /></button></header><div className="portable-preview"><strong>{preview.manifest.project.name} · import preview</strong><p>{preview.manifest.cards.length} cards · {preview.manifest.resources.length} resources · {preview.files.length} files. Existing IDs are updated, not duplicated. Missing linked projects stay unavailable until relinked.</p>
      {preview.manifest.project.repositories.map(linked => <label className="portable-project" key={linked.id}>{linked.name}<small>{relinks[linked.id] || 'Keep the local location, or leave unlinked on a new computer.'}</small><button disabled={busy} onClick={() => void action(async () => { const folder = await choose(); if (folder) setRelinks(current => ({ ...current, [linked.id]: folder })) })}>Relink folder…</button></label>)}
      {preview.metadataConflict && <label className="setting-toggle"><span>Replace workspace metadata<small>Replaces this workspace’s card/resource associations. Other workspaces are retained.</small></span><input type="checkbox" checked={metadata} onChange={event => setMetadata(event.target.checked)} /></label>}
      {preview.files.filter(item => item.status === 'conflict').map(item => <label className="setting-toggle" key={item.name}><span>Replace {item.name}<small>Backup required. Shared report styles and skill files can also affect other workspaces.</small></span><input type="checkbox" checked={replace.includes(item.name)} onChange={event => setReplace(current => event.target.checked ? [...current, item.name] : current.filter(name => name !== item.name))} /></label>)}
      {error && <p className="desk-error-inline" role="alert">{error}</p>}<div className="portable-actions"><button disabled={busy || preview.metadataConflict && !metadata || preview.files.some(item => item.status === 'conflict' && !replace.includes(item.name))} onClick={importSnapshot}>Import with backup</button><button disabled={busy} onClick={() => setPreview(null)}>Cancel</button></div>
    </div></WorkspaceDialog>}
    {message && <p className="settings-success" role="status">{message}</p>}{error && !preview && !update && <p className="desk-error-inline" role="alert">{error}</p>}
  </section>
}
