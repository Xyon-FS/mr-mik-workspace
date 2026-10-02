import { useEffect, useState } from 'react'
import { api, onServiceEvent, pickFiles, useDesktop } from './client'
import type { Settings } from './types'
import { Icon } from './Icons'
import ReasoningSelect from './ReasoningSelect'
import { useReasoningCapabilities } from './useReasoningCapabilities'
import WorkspaceSnapshotSettings from './WorkspaceSnapshotSettings'
import AccountsSettings from './AccountsSettings'

type NativeSettings = { available: boolean; winKey: boolean; error?: string }
type TransferIssue = { key: string; name: string; agent: string; reason: string }
type AttachmentReview = { token: string; files: { path: string; bytes: number }[]; issues?: TransferIssue[]; folder: string }
type ImportPreview = { reviewHash?: string; manifest: { chats: string; files: { name: string }[]; projectPaths: Record<string, Record<string, string>>; projectNames?: Record<string, string>; projectDefinitions?: Record<string, { repositories: { id: string; name: string }[] }>; native: unknown[] }; native: { agent: string; id: string; key?: string; reason?: string; name?: string; status: string; familySize?: number }[]; hubConflicts: { name: string; identical: boolean }[]; suggestedRelinks?: Record<string, Record<string, string>> }
const importStatuses: Record<string, string> = { new: 'New conversation', update: 'Continuation · updates automatically', identical: 'Identical · no transcript copy', 'local-newer': 'Local continuation · kept', conflict: 'Divergent · keep local by default', unavailable: 'Not transferable · confirmation required' }
const accentThemes = [
  { id: 'rose', name: 'Rose', color: '#f0a0b0' },
  { id: 'violet', name: 'Violet', color: '#baadff' },
  { id: 'blue', name: 'Blue', color: '#83c5ff' },
  { id: 'teal', name: 'Teal', color: '#79d8c6' },
] as const
export default function WorkspaceSettings({ onClose }: { onClose: () => void }) {
  const { settings, repo } = useDesktop()
  const reasoning = useReasoningCapabilities()
  const [native, setNative] = useState<NativeSettings>({ available: false, winKey: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [archive, setArchive] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [relinks, setRelinks] = useState<Record<string, Record<string, string>>>({})
  const [replaceNative, setReplaceNative] = useState<string[]>([])
  const [replaceHub, setReplaceHub] = useState<string[]>([])
  const [restoreSettings, setRestoreSettings] = useState(false)
  const [message, setMessage] = useState('')
  const [attachmentReview, setAttachmentReview] = useState<AttachmentReview | null>(null)
  const [approveAttachments, setApproveAttachments] = useState(false)
  const [approveExportSkips, setApproveExportSkips] = useState(false)
  const [approveImportSkips, setApproveImportSkips] = useState(false)
  useEffect(() => {
    const refresh = () => api<NativeSettings>('/native/settings').then(setNative).catch(error => setError(String(error.message || error)))
    void refresh()
    return onServiceEvent(event => { if (event.type === 'native-settings') void refresh() })
  }, [])
  const change = async (patch: Partial<Settings>) => {
    setBusy(true); setError('')
    try { await api('/settings', patch) } catch (error) { setError(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  const winKey = async (enabled: boolean) => {
    setBusy(true); setError('')
    try { setNative(await api<NativeSettings>('/native/settings', { winKey: enabled })) }
    catch (error) { setError(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  const portableAction = async (work: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const exportArchive = (chats: 'full' | 'light') => void portableAction(async () => {
    const [folder] = await pickFiles({ window: 'workspace', folder: true })
    if (!folder) return
    setAttachmentReview(null); setApproveAttachments(false); setApproveExportSkips(false)
    const review = chats === 'full' ? await api<Omit<AttachmentReview, 'folder'>>('/workspace/export/preview', { folder }) : null
    if (review && (review.files.length || review.issues?.length)) { setAttachmentReview({ ...review, folder }); return }
    const result = await api<{ path: string; files: number; chats: number }>('/workspace/export', { folder, chats, attachmentToken: review?.token })
    setMessage(`Export saved: ${result.path} · ${result.files} files · ${result.chats} native chats.`)
  })
  const confirmAttachmentExport = () => void portableAction(async () => {
    if (!attachmentReview || attachmentReview.files.length && !approveAttachments || attachmentReview.issues?.length && !approveExportSkips) return
    const review = attachmentReview; setAttachmentReview(null); setApproveAttachments(false)
    const result = await api<{ path: string; files: number; chats: number; omitted?: number }>('/workspace/export', { folder: review.folder, chats: 'full', attachmentToken: review.token, approveAttachments, skipNative: (review.issues || []).map(issue => issue.key) })
    setMessage(`Export saved: ${result.path} · ${result.files} files · ${result.chats} native chats. ${result.omitted || 0} unavailable native conversations excluded; History/screens retained.`)
  })
  const chooseArchive = () => void portableAction(async () => {
    const [path] = await pickFiles({ window: 'workspace' })
    if (!path) return
    const result = await api<ImportPreview>('/workspace/import/preview', { path })
    setArchive(path); setPreview(result); setRelinks(result.suggestedRelinks || result.manifest.projectPaths || {}); setReplaceNative([]); setReplaceHub([]); setRestoreSettings(false); setApproveImportSkips(false)
  })
  const importArchive = () => void portableAction(async () => {
    if (!preview) return
    const unavailable = preview.native.filter(item => item.status === 'unavailable')
    if (unavailable.length && !approveImportSkips) return
    const result = await api<{ imported: number; skipped: number; nativeImported: number; nativeUpdated: number; sessionsUpdated: number; nativeSkipped: number; backup: string }>('/workspace/import', { path: archive, relinks, replaceNative, replaceHub, restoreSettings, skipNative: unavailable.map(item => item.key), reviewHash: preview.reviewHash })
    setMessage(`Imported ${result.imported} Hub items and ${result.nativeImported} native chats; updated ${result.nativeUpdated} native chats and ${result.sessionsUpdated} History entries. Skipped ${result.skipped + result.nativeSkipped}. Backups: ${result.backup}`)
    setPreview(null)
  })
  const toggle = (values: string[], key: string, setter: (next: string[]) => void) => setter(values.includes(key) ? values.filter(item => item !== key) : [...values, key])
  return <div className="files-panel workspace-settings"><header><h2>Settings</h2><button className="desk-icon" onClick={onClose} aria-label="Close settings"><Icon name="close" size={17} /></button></header>
    <div className="settings-scroll"><section><h3>Windows</h3><label className="setting-toggle"><span>Win key shows Mr. Mik<small>Bring back open windows. Win shortcuts keep working; Ctrl+Esc opens Start.</small></span><input type="checkbox" checked={native.winKey} disabled={busy || !native.available} onChange={event => void winKey(event.target.checked)} /></label>{!native.available && <p>{native.error || 'Available in the Windows desktop app.'}</p>}</section>
    <section><h3>Appearance</h3><p>Choose an accent that works with the dark grey interface. This changes Mr. Mik controls in both windows, not card pages or original CLI colours.</p><div className="settings-theme-options" role="group" aria-label="Interface accent colour">{accentThemes.map(theme => <button key={theme.id} type="button" aria-label={`${theme.name} accent`} aria-pressed={(settings.accentTheme || 'rose') === theme.id} disabled={busy} onClick={() => void change({ accentTheme: theme.id })}><span className="settings-theme-swatch" style={{ backgroundColor: theme.color }} /><span>{theme.name}</span></button>)}</div></section>
    <section><h3>Chats</h3><label>Default agent<select disabled={busy} value={settings.defaultAgent} onChange={event => void change({ defaultAgent: event.target.value as Settings['defaultAgent'] })}><option value="codex">Codex</option><option value="claude">Claude</option><option value="opencode">OpenCode</option><option value="kimi">Kimi</option><option value="shell">PowerShell</option></select></label>
      <label>Default worker reasoning · Codex<ReasoningSelect label="Default worker reasoning · Codex" disabled={busy} value={settings.defaultWorkerEffort} efforts={reasoning.data?.codexWorker.efforts} onChange={value => void change({ defaultWorkerEffort: value })} /></label>
      <label>Default worker reasoning · Claude<ReasoningSelect label="Default worker reasoning · Claude" disabled={busy} value={settings.defaultClaudeWorkerEffort || 'high'} efforts={reasoning.data?.claude.efforts} onChange={value => void change({ defaultClaudeWorkerEffort: value })} /></label>
      <p>Defaults for new chats, not existing conversations. Codex choices follow its configured model; linked projects can use a different model. Native CLI model/account limits still apply.</p>
      <label>Terminal text size<select disabled={busy} value={settings.terminalFontSize || 13} onChange={event => void change({ terminalFontSize: Number(event.target.value) })}>{Array.from({ length: 15 }, (_, i) => i + 10).map(size => <option key={size} value={size}>{size} px</option>)}</select></label>
      <label>Terminal appearance<select disabled={busy} value={settings.terminalAppearance || 'focus'} onChange={event => void change({ terminalAppearance: event.target.value as Settings['terminalAppearance'] })}><option value="focus">Focus · clearer answers</option><option value="original">Original CLI colours</option></select></label>
      <label className="setting-toggle"><span>Bypass CLI permissions<small>Default for new chats.</small></span><input type="checkbox" checked={settings.defaultBypass} disabled={busy} onChange={event => void change({ defaultBypass: event.target.checked })} /></label>
    </section><section><h3>Mr. Mik</h3><label>Coordinator reasoning<ReasoningSelect label="Coordinator reasoning" disabled={busy} value={settings.coordinatorEffort || 'medium'} efforts={reasoning.data?.codex.efforts} onChange={value => void change({ coordinatorEffort: value })} /></label><p>Default for new Mik conversations. Change a saved conversation's level inside Mik without changing this default. Forks inherit their parent's level.</p>{reasoning.error && <p role="alert">Reasoning choices unavailable: {reasoning.error}. Close and reopen Settings to retry.</p>}</section>
      <section><h3>Mr. Mik Hub</h3><p className="settings-repo">{repo}</p><p>Context is shared. Knowledge and Processes may be global or workspace-scoped. Linked projects retain their own instructions and tooling.</p></section>
      <section className="portable-settings"><h3>Transfer Hub</h3><p>Export Hub cards, files, resource associations, Hub skills and scopes, portable settings and History. Linked project folders, native project/personal CLI configuration, private Claude MCP definitions, account logins and caches are not copied. Full export includes verified Codex, Claude and supported OpenCode native chats. Unavailable conversations are listed for explicit exclusion; healthy chats remain transferable. Review the archive before sharing because conversations can contain private information.</p><div className="portable-actions"><button disabled={busy} onClick={() => exportArchive('full')}>Export · full</button><button disabled={busy} onClick={() => exportArchive('light')}>Export · light</button></div><p>Light export keeps Mr. Mik History and saved terminal screens, but not native CLI transcripts for resuming chats. On import, restoring app preferences is optional and off by default.</p><button disabled={busy} onClick={chooseArchive}>Choose archive to import…</button>
      {preview && <div className="portable-preview"><strong>Import preview</strong><small>{archive}</small><p>{preview.manifest.files.length} Hub/archive files · {preview.native.length} native chats · {preview.native.filter(item => item.status === 'conflict').length} native conflicts</p>
        <p>Complete transcript continuations update automatically with a backup. Older copies never overwrite newer local chats. Divergent conversations are not merged. Codex/Claude allow explicit replacement; OpenCode keeps the local branch. History and saved screens follow the accepted conversation.</p>
        {preview.native.filter(item => item.status !== 'unavailable').map(item => <p key={item.key || `${item.agent}:${item.id}`}><strong>{item.name || item.id}</strong><br /><small>{item.agent} · {importStatuses[item.status] || item.status}{item.familySize && item.familySize > 1 ? ` · ${item.familySize} sessions including subagents` : ''}</small></p>)}
        {preview.native.some(item => item.status === 'unavailable') && <div className="portable-preview"><strong>Unavailable conversations</strong>{preview.native.filter(item => item.status === 'unavailable').map(item => <p key={item.key}><strong>{item.name || item.id}</strong><br /><small>{item.agent} · {item.reason}</small></p>)}<label className="setting-toggle"><span>Continue without these native conversations<small>Import healthy chats and retain available History/screens with a warning. Existing local chats are not downgraded. Each OpenCode family is excluded as a unit.</small></span><input type="checkbox" checked={approveImportSkips} disabled={busy} onChange={event => setApproveImportSkips(event.target.checked)} /></label></div>}
        <label className="setting-toggle"><span>Restore app preferences<small>Agent, reasoning, accent colour, terminal appearance, selected workspace and permission-bypass default. Open chat/window selection is not restored. Off keeps this computer’s preferences.</small></span><input type="checkbox" checked={restoreSettings} onChange={event => setRestoreSettings(event.target.checked)} /></label>
        {Object.entries(preview.manifest.projectPaths || {}).map(([projectId, repositories]) => <div key={projectId} className="portable-project"><strong>{preview.manifest.projectNames?.[projectId] || `Workspace ${projectId}`}</strong>{Object.entries(repositories).map(([repositoryId, previous]) => <label key={repositoryId}>{preview.manifest.projectDefinitions?.[projectId]?.repositories.find(item => item.id === repositoryId)?.name || (repositoryId === 'primary' ? 'Main project' : repositoryId)}<small>Previous: {previous}</small><input value={relinks[projectId]?.[repositoryId] || ''} onChange={event => setRelinks(current => ({ ...current, [projectId]: { ...current[projectId], [repositoryId]: event.target.value } }))} /><button disabled={busy} onClick={() => void pickFiles({ window: 'workspace', folder: true }).then(paths => { if (paths[0]) setRelinks(current => ({ ...current, [projectId]: { ...current[projectId], [repositoryId]: paths[0] } })) }).catch(cause => setError(String(cause)))}>Browse…</button></label>)}</div>)}
        {preview.native.filter(item => item.status === 'conflict').map(item => { const key = `${item.agent}:${item.id}`; return item.agent === 'opencode' ? <p key={key}><strong>Keep {item.name || 'OpenCode chat'}</strong><br /><small>Different conversation branches are not merged or replaced by OpenCode transfer. The local chat and saved screen will be retained.</small></p> : <label key={key} className="setting-toggle"><span>Replace {item.name || `${item.agent} chat ${item.id}`}<small>Replace the local branch, History and saved screen with this archive. A backup is kept; this is not a merge.</small></span><input type="checkbox" checked={replaceNative.includes(key)} onChange={() => toggle(replaceNative, key, setReplaceNative)} /></label> })}
        {preview.native.some(item => item.agent === 'opencode') && <p><small>OpenCode transfers conversation messages. Task lists are archived as reference only, not restored natively. Existing native session metadata is retained. Close OpenCode on this PC before importing.</small></p>}
        {preview.hubConflicts.filter(item => !item.identical && item.name !== 'state/settings.json').map(item => <label key={item.name} className="setting-toggle"><span>Replace {item.name}<small>Default: keep the current Hub file. Replacement creates a backup.</small></span><input type="checkbox" checked={replaceHub.includes(item.name)} onChange={() => toggle(replaceHub, item.name, setReplaceHub)} /></label>)}
        <button className="portable-import" disabled={busy || preview.native.some(item => item.status === 'unavailable') && !approveImportSkips} onClick={importArchive}>Import into this Hub</button></div>}
      {attachmentReview && <div className="portable-preview">
        {!!attachmentReview.issues?.length && <><strong>Unavailable conversations</strong>{attachmentReview.issues.map(issue => <p key={issue.key}><strong>{issue.name}</strong><br /><small>{issue.agent} · {issue.reason}</small></p>)}<label className="setting-toggle"><span>Continue without these native conversations<small>Export healthy chats. Keep available History/screens for excluded chats, marked as not transferred. OpenCode families are excluded as a unit.</small></span><input type="checkbox" checked={approveExportSkips} disabled={busy} onChange={event => setApproveExportSkips(event.target.checked)} /></label></>}
        {!!attachmentReview.files.length && <><strong>Review OpenCode attachments</strong><p>These exact files will be copied into native chat data in the archive. Original files and conversations are not changed.</p>{attachmentReview.files.map(file => <p key={file.path}><small>{file.path}<br />{(file.bytes / 1024).toFixed(1)} KB</small></p>)}<label className="setting-toggle"><span>Include all listed files<small>Check that they contain no private information before sharing.</small></span><input type="checkbox" checked={approveAttachments} disabled={busy} onChange={event => setApproveAttachments(event.target.checked)} /></label></>}
        <p>Nothing is exported before confirmation. Review expires after five minutes; changed data requires a new review.</p><div className="portable-actions"><button disabled={busy || !!attachmentReview.files.length && !approveAttachments || !!attachmentReview.issues?.length && !approveExportSkips} onClick={confirmAttachmentExport}>Confirm full export</button><button disabled={busy} onClick={() => { setAttachmentReview(null); setApproveAttachments(false); setApproveExportSkips(false) }}>Cancel</button></div>
      </div>}
      </section>
      <WorkspaceSnapshotSettings />
      <AccountsSettings />
      {message && <p className="settings-success" role="status">{message}</p>}
      {error && <p className="desk-error-inline" role="alert">{error}</p>}
    </div></div>
}
