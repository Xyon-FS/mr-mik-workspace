import { useEffect, useState, type ReactNode } from 'react'
import { api, onServiceEvent, pickFiles, useDesktop } from './client'
import type { Settings } from './types'
import { Icon } from './Icons'
import ReasoningSelect from './ReasoningSelect'
import DarkSelect from './DarkSelect'
import { useReasoningCapabilities } from './useReasoningCapabilities'
import WindowLayoutSettings from './WindowLayoutSettings'
import WorkspaceSnapshotSettings from './WorkspaceSnapshotSettings'
import AccountsSettings from './AccountsSettings'
import ChatDefaultsSettings from './ChatDefaultsSettings'
import AnchoredMenu from './AnchoredMenu'
import WorkspaceDialog from './WorkspaceDialog'
import './settings-panel.css'

type NativeSettings = { available: boolean; winKey: boolean; error?: string }
type TransferIssue = { key: string; name: string; agent: string; reason: string }
type TransferCoverage = { agent: string; historyEntries: number; nativeConversations: number; reason: string | null }
type MediaReview = { files: { path: string; bytes: number }[]; hubFiles: number; totalBytes: number; omissions: { source: string; reason: string }[] }
type SkillConflict = { id: string; agent: string; skill: string; scope: string; projectId: string | null; local: boolean; incoming: boolean }
type AttachmentReview = { token: string; files: { path: string; bytes: number }[]; media?: MediaReview; issues?: TransferIssue[]; notices?: TransferCoverage[]; folder: string }
type ImportPreview = { skillConflicts?: SkillConflict[]; coverage?: TransferCoverage[]; reviewHash?: string; manifest: { media?: { refs: unknown[]; omissions?: { source: string; reason: string }[] }; chats: string; files: { name: string }[]; projectPaths: Record<string, Record<string, string>>; projectNames?: Record<string, string>; projectDefinitions?: Record<string, { repositories: { id: string; name: string }[] }>; native: unknown[] }; native: { agent: string; id: string; key?: string; reason?: string; name?: string; status: string; familySize?: number }[]; hubConflicts: { name: string; identical: boolean }[]; suggestedRelinks?: Record<string, Record<string, string>> }
const importStatuses: Record<string, string> = { new: 'New conversation', update: 'Continuation · updates automatically', identical: 'Identical · no transcript copy', 'local-newer': 'Local continuation · kept', conflict: 'Divergent · keep local by default', unavailable: 'Not transferable · confirmation required' }
const accentThemes = [
  { id: 'rose', name: 'Rose', color: '#f0a0b0' },
  { id: 'violet', name: 'Violet', color: '#baadff' },
  { id: 'blue', name: 'Blue', color: '#83c5ff' },
  { id: 'teal', name: 'Teal', color: '#79d8c6' },
] as const
export default function WorkspaceSettings({ onClose }: { onClose: () => void }) {
  const { settings } = useDesktop()
  const reasoning = useReasoningCapabilities(undefined, 'system', 'defaults')
  const [native, setNative] = useState<NativeSettings>({ available: false, winKey: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [archive, setArchive] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [relinks, setRelinks] = useState<Record<string, Record<string, string>>>({})
  const [replaceNative, setReplaceNative] = useState<string[]>([])
  const [replaceHub, setReplaceHub] = useState<string[]>([])
  const [replaceSkills, setReplaceSkills] = useState<string[]>([])
  const [includeMedia, setIncludeMedia] = useState(false)
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
    setAttachmentReview(null); setApproveAttachments(false); setApproveExportSkips(false); setIncludeMedia(false)
    const review = chats === 'full' ? await api<Omit<AttachmentReview, 'folder'>>('/workspace/export/preview', { folder }) : null
    if (review && (review.files.length || review.issues?.length || review.notices?.length || review.media?.files.length || review.media?.omissions.length)) { setAttachmentReview({ ...review, folder }); return }
    const result = await api<{ path: string; files: number; chats: number }>('/workspace/export', { folder, chats, attachmentToken: review?.token })
    setMessage(`Export saved: ${result.path} · ${result.files} files · ${result.chats} native chats.`)
  })
  const confirmAttachmentExport = () => void portableAction(async () => {
    if (!attachmentReview || attachmentReview.files.length && !approveAttachments || attachmentReview.issues?.length && !approveExportSkips) return
    const review = attachmentReview; setAttachmentReview(null); setApproveAttachments(false)
    const result = await api<{ path: string; files: number; chats: number; omitted?: number }>('/workspace/export', { folder: review.folder, chats: 'full', attachmentToken: review.token, approveAttachments, includeMedia, approveMedia: includeMedia, skipNative: (review.issues || []).map(issue => issue.key) })
    setMessage(`Export saved: ${result.path} · ${result.files} files · ${result.chats} native chats. ${result.omitted || 0} unavailable native conversations excluded; History/screens retained.`)
  })
  const chooseArchive = () => void portableAction(async () => {
    const [path] = await pickFiles({ window: 'workspace' })
    if (!path) return
    const result = await api<ImportPreview>('/workspace/import/preview', { path })
    setArchive(path); setPreview(result); setRelinks(result.suggestedRelinks || result.manifest.projectPaths || {}); setReplaceNative([]); setReplaceHub([]); setReplaceSkills([]); setRestoreSettings(false); setApproveImportSkips(false)
  })
  const importArchive = () => void portableAction(async () => {
    if (!preview) return
    const unavailable = preview.native.filter(item => item.status === 'unavailable')
    if (unavailable.length && !approveImportSkips) return
    const result = await api<{ imported: number; skipped: number; nativeImported: number; nativeUpdated: number; sessionsUpdated: number; nativeSkipped: number; backup: string }>('/workspace/import', { path: archive, relinks, replaceNative, replaceHub, replaceSkills, restoreSettings, skipNative: unavailable.map(item => item.key), reviewHash: preview.reviewHash })
    setMessage(`Imported ${result.imported} Hub items and ${result.nativeImported} native chats; updated ${result.nativeUpdated} native chats and ${result.sessionsUpdated} History entries. Skipped ${result.skipped + result.nativeSkipped}. Backups: ${result.backup}`)
    setPreview(null)
  })
  const toggle = (values: string[], key: string, setter: (next: string[]) => void) => setter(values.includes(key) ? values.filter(item => item !== key) : [...values, key])
  const category = (name: string, summary: string, icon: string, content: ReactNode) => <AnchoredMenu label={`${name} settings`} className="settings-category" placement="left" menuOwner="settings-details" appearance="workspace" triggerContent={<><Icon name={icon} size={16} /><span><strong>{name}</strong><small>{summary}</small></span><Icon name="arrow" size={12} /></>}>{close => <><header className="settings-detail-heading"><h3>{name}</h3><button className="desk-icon" aria-label="Close settings details" onClick={close}><Icon name="close" size={15} /></button></header><div className="settings-detail-content">{content}</div></>}</AnchoredMenu>
  return <div className="files-panel workspace-settings settings-concept-panel"><header><h2>Settings</h2><button className="desk-icon" onClick={onClose} aria-label="Close settings"><Icon name="close" size={17} /></button></header><div className="settings-categories"><p className="settings-scope-label">Application preferences</p>
    {category('Appearance', 'Accent, windows and layout', 'palette', <>
    <section><h3>Interface</h3><div className="settings-accent-row"><span>Accent</span><div className="settings-theme-options" role="group" aria-label="Interface accent colour">{accentThemes.map(theme => <button key={theme.id} type="button" aria-label={`${theme.name} accent`} aria-pressed={(settings.accentTheme || 'rose') === theme.id} disabled={busy} onClick={() => void change({ accentTheme: theme.id })}><span className="settings-theme-swatch" style={{ backgroundColor: theme.color }} /><span>{theme.name}</span></button>)}</div></div></section>
<section><h3>Windows</h3><label className="setting-toggle"><span>Win key shows Mr. Mik<small>Ctrl+Esc opens Start.</small></span><input type="checkbox" checked={native.winKey} disabled={busy || !native.available} onChange={event => void winKey(event.target.checked)} /></label>{!native.available && <p>{native.error || 'Available in the Windows desktop app.'}</p>}</section>
    <WindowLayoutSettings key={settings.chatWidthPercent || 30} value={settings.chatWidthPercent || 30} busy={busy} change={change} />
</>)}
    {category('Chats', 'Defaults, coordinator and terminal', 'chat', <>
    <section><h3>New chats</h3>
      <ChatDefaultsSettings settings={settings} busy={busy} change={change} />
      </section><section><h3>Terminal</h3><label>Text size<DarkSelect appearance="workspace" label="Terminal text size" icon="" disabled={busy} value={String(settings.terminalFontSize || 13)} onChange={value => void change({ terminalFontSize: Number(value) })} options={Array.from({ length: 15 }, (_, i) => ({ value: String(i + 10), label: `${i + 10} px` }))} /></label>
      <label>Appearance<DarkSelect appearance="workspace" label="Terminal appearance" icon="" disabled={busy} value={settings.terminalAppearance || 'focus'} onChange={value => void change({ terminalAppearance: value as Settings['terminalAppearance'] })} options={[{ value: 'focus', label: 'Focus · clearer answers' }, { value: 'original', label: 'Original CLI colours' }]} /></label>
    </section><section><h3>Behaviour</h3><label>Coordinator reasoning<ReasoningSelect icon="" appearance="workspace" label="Coordinator reasoning" disabled={busy} value={settings.coordinatorEffort || 'medium'} efforts={reasoning.data?.codex.efforts} onChange={value => void change({ coordinatorEffort: value })} /></label>{reasoning.error && <p role="alert">Could not load reasoning defaults.</p>}      <label className="setting-toggle"><span>Completion notifications<small>Notify when a background chat finishes.</small></span><input type="checkbox" checked={settings.completionNotifications !== false} disabled={busy} onChange={event => void change({ completionNotifications: event.target.checked })} /></label>
      <label className="setting-toggle"><span>Bypass permissions · OpenCode<small>Default for new OpenCode chats.</small></span><input type="checkbox" checked={settings.defaultBypass} disabled={busy} onChange={event => void change({ defaultBypass: event.target.checked })} /></label>
</section>

</>)}
    {category('Accounts', 'Codex, Claude and OpenCode', 'users', <AccountsSettings />)}
    {category('Transfer Hub', 'Full or light archives', 'archive', <>
      <section className="portable-settings"><h3>Transfer Hub</h3><p>Move Hub content and chats between computers. Accounts and linked folders are excluded.</p><div className="portable-actions"><button disabled={busy} onClick={() => exportArchive('full')}>Export · full</button><button disabled={busy} onClick={() => exportArchive('light')}>Export · light</button></div><p>Full: supported native chats, with optional external media. Light: History and saved screens. Hub files are always included; unsent drafts are excluded.</p><button disabled={busy} onClick={chooseArchive}>Choose archive to import…</button>
</section></>)}
    {category('Workspace snapshots', 'Export, update and import', 'branch', <WorkspaceSnapshotSettings />)}
    </div>
{preview && <WorkspaceDialog label="Import Hub archive" busy={busy} close={() => setPreview(null)}><header className="settings-dialog-heading"><h3>Import Hub archive</h3><button className="desk-icon" aria-label="Close import hub archive" disabled={busy} onClick={() => setPreview(null)}><Icon name="close" size={16} /></button></header><div className="portable-preview"><small>{archive}</small><p>{preview.manifest.files.length} Hub/archive files · {preview.native.length} native chats · {preview.native.filter(item => item.status === 'conflict').length} native conflicts</p>
        <p>Continuations update with a backup. Conflicting chats stay local unless replaced.</p>
        <details open><summary>Conversations and coverage</summary>
        {preview.native.filter(item => item.status !== 'unavailable').map(item => <p key={item.key || `${item.agent}:${item.id}`}><strong>{item.name || item.id}</strong><br /><small>{item.agent} · {importStatuses[item.status] || item.status}{item.familySize && item.familySize > 1 ? ` · ${item.familySize} sessions including subagents` : ''}</small></p>)}
        {preview.native.some(item => item.status === 'unavailable') && <div className="portable-preview"><strong>Unavailable conversations</strong>{preview.native.filter(item => item.status === 'unavailable').map(item => <p key={item.key}><strong>{item.name || item.id}</strong><br /><small>{item.agent} · {item.reason}</small></p>)}<label className="setting-toggle"><span>Continue without these native conversations<small>Import healthy chats and retain available History/screens with a warning. Existing local chats are not downgraded. Each OpenCode family is excluded as a unit.</small></span><input type="checkbox" checked={approveImportSkips} disabled={busy} onChange={event => setApproveImportSkips(event.target.checked)} /></label></div>}
        {preview.coverage?.map(item => <p key={item.agent}><small>{item.agent} · {item.historyEntries} History entries · {item.nativeConversations} native conversations{item.reason ? ` · ${item.reason}` : ''}</small></p>)}
        {!!preview.manifest.media?.refs.length && <p><small>{preview.manifest.media.refs.length} conversation file links will be relocated. Existing Hub file conflict choices still apply.</small></p>}
        {!!preview.manifest.media?.omissions?.length && <details><summary>{preview.manifest.media.omissions.length} conversation files excluded or unavailable</summary>{preview.manifest.media.omissions.map((item, index) => <p key={index}><small>{item.source} · {item.reason}</small></p>)}</details>}
        {!!preview.skillConflicts?.length && <details open><summary>Skill activation conflicts · keep local by default</summary>{preview.skillConflicts.map(item => <label key={item.id} className="setting-toggle"><span>{item.agent} · {item.skill} · {item.projectId ? preview.manifest.projectNames?.[item.projectId] || item.projectId : 'Global'}<small>Local: {item.local ? 'On' : 'Off'} · Imported: {item.incoming ? 'On' : 'Off'}. Select to use the imported choice.</small></span><input type="checkbox" checked={replaceSkills.includes(item.id)} disabled={busy} onChange={() => toggle(replaceSkills, item.id, setReplaceSkills)} /></label>)}</details>}
        </details>
        <label className="setting-toggle"><span>Restore app preferences<small>Keep off to retain this computer’s preferences.</small></span><input type="checkbox" checked={restoreSettings} onChange={event => setRestoreSettings(event.target.checked)} /></label>
        <details><summary>Linked folders</summary>
        {Object.entries(preview.manifest.projectPaths || {}).map(([projectId, repositories]) => <div key={projectId} className="portable-project"><strong>{preview.manifest.projectNames?.[projectId] || `Workspace ${projectId}`}</strong>{Object.entries(repositories).map(([repositoryId, previous]) => <label key={repositoryId}>{preview.manifest.projectDefinitions?.[projectId]?.repositories.find(item => item.id === repositoryId)?.name || (repositoryId === 'primary' ? 'Main project' : repositoryId)}<small>Previous: {previous}</small><input value={relinks[projectId]?.[repositoryId] || ''} onChange={event => setRelinks(current => ({ ...current, [projectId]: { ...current[projectId], [repositoryId]: event.target.value } }))} /><button disabled={busy} onClick={() => void pickFiles({ window: 'workspace', folder: true }).then(paths => { if (paths[0]) setRelinks(current => ({ ...current, [projectId]: { ...current[projectId], [repositoryId]: paths[0] } })) }).catch(cause => setError(String(cause)))}>Browse…</button></label>)}</div>)}
        </details>
        <details open><summary>Conflicts and replacement choices</summary>
        {preview.native.filter(item => item.status === 'conflict').map(item => { const key = `${item.agent}:${item.id}`; return item.agent === 'opencode' ? <p key={key}><strong>Keep {item.name || 'OpenCode chat'}</strong><br /><small>Different conversation branches are not merged or replaced by OpenCode transfer. The local chat and saved screen will be retained.</small></p> : <label key={key} className="setting-toggle"><span>Replace {item.name || `${item.agent} chat ${item.id}`}<small>Replace the local branch, History and saved screen with this archive. A backup is kept; this is not a merge.</small></span><input type="checkbox" checked={replaceNative.includes(key)} onChange={() => toggle(replaceNative, key, setReplaceNative)} /></label> })}
        {preview.native.some(item => item.agent === 'opencode') && <p><small>Close OpenCode before importing. Task lists remain reference-only.</small></p>}
        {preview.hubConflicts.filter(item => !item.identical && item.name !== 'state/settings.json').map(item => <label key={item.name} className="setting-toggle"><span>Replace {item.name}<small>Default: keep the current Hub file. Replacement creates a backup.</small></span><input type="checkbox" checked={replaceHub.includes(item.name)} onChange={() => toggle(replaceHub, item.name, setReplaceHub)} /></label>)}
        </details>
        {error && <p className="desk-error-inline" role="alert">{error}</p>}<button className="portable-import" disabled={busy || preview.native.some(item => item.status === 'unavailable') && !approveImportSkips} onClick={importArchive}>Import into this Hub</button></div></WorkspaceDialog>}
{attachmentReview && <WorkspaceDialog label="Full Hub export" busy={busy} close={() => setAttachmentReview(null)}><header className="settings-dialog-heading"><h3>Full Hub export</h3><button className="desk-icon" aria-label="Close full hub export" disabled={busy} onClick={() => setAttachmentReview(null)}><Icon name="close" size={16} /></button></header><div className="portable-preview">
        {attachmentReview.media && <><p><small>{attachmentReview.media.hubFiles} referenced Hub files remain included. External file sizes below are an upper estimate before deduplication.</small></p>{!!attachmentReview.media.files.length && <><label className="setting-toggle"><span>Include external conversation files<small>{attachmentReview.media.files.length} files · up to {(attachmentReview.media.totalBytes / 1024 / 1024).toFixed(1)} MB. Identical content is stored once.</small></span><input type="checkbox" checked={includeMedia} disabled={busy} onChange={event => setIncludeMedia(event.target.checked)} /></label><details><summary>Review external files</summary>{attachmentReview.media.files.map(file => <p key={file.path}><small>{file.path} · {(file.bytes / 1024 / 1024).toFixed(2)} MB</small></p>)}</details></>}{!!attachmentReview.media.omissions.length && <details><summary>{attachmentReview.media.omissions.length} unavailable or unsupported files</summary>{attachmentReview.media.omissions.map((item, index) => <p key={index}><small>{item.source} · {item.reason}</small></p>)}</details>}<p><small>Media already embedded in native transcripts remains included. OpenCode attachments retain their separate required review.</small></p></>}
        {attachmentReview.notices?.map(item => <p key={item.agent}><strong>{item.agent}</strong><br /><small>{item.reason}</small></p>)}
        {!!attachmentReview.issues?.length && <><strong>Unavailable conversations</strong>{attachmentReview.issues.map(issue => <p key={issue.key}><strong>{issue.name}</strong><br /><small>{issue.agent} · {issue.reason}</small></p>)}<label className="setting-toggle"><span>Continue without these native conversations<small>Export healthy chats. Keep available History/screens for excluded chats, marked as not transferred. OpenCode families are excluded as a unit.</small></span><input type="checkbox" checked={approveExportSkips} disabled={busy} onChange={event => setApproveExportSkips(event.target.checked)} /></label></>}
        {!!attachmentReview.files.length && <><strong>Review OpenCode attachments</strong><p>These exact files will be copied into native chat data in the archive. Original files and conversations are not changed.</p>{attachmentReview.files.map(file => <p key={file.path}><small>{file.path}<br />{(file.bytes / 1024).toFixed(1)} KB</small></p>)}<label className="setting-toggle"><span>Include all listed files<small>Check that they contain no private information before sharing.</small></span><input type="checkbox" checked={approveAttachments} disabled={busy} onChange={event => setApproveAttachments(event.target.checked)} /></label></>}
        <p>Confirm within five minutes. Changed data requires a new review.</p><div className="portable-actions"><button disabled={busy || !!attachmentReview.files.length && !approveAttachments || !!attachmentReview.issues?.length && !approveExportSkips} onClick={confirmAttachmentExport}>Confirm full export</button><button disabled={busy} onClick={() => { setAttachmentReview(null); setApproveAttachments(false); setApproveExportSkips(false) }}>Cancel</button></div>
      </div></WorkspaceDialog>}
    {message && <p className="settings-success" role="status">{message}</p>}{error && !preview && !attachmentReview && <p className="desk-error-inline" role="alert">{error}</p>}
  </div>
}
