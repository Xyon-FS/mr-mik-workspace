import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, selectChat, useDesktop } from './client'
import type { Project } from './types'
import { AgentLogo, Icon } from './Icons'
import DarkSelect from './DarkSelect'
import AccountProfileSelect from './AccountProfileSelect'
import AnchoredMenu from './AnchoredMenu'
import { normalizeWorkspaceIcon } from './workspaceIconImage'
import './workspace-icon.css'

type ImageReference = { itemId: string; href?: string; index?: number }
type Prepared = { sessionId: string; runtimeId: string; models: { model?: string; value?: string; displayName?: string; label?: string }[] }
type Progress = { working: boolean; images: ImageReference[]; requests: number; error: string; text: string }

function Candidate({ sessionId, image, choose }: { sessionId: string; image: ImageReference; choose: (url: string) => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const route = image.href ? `/sessions/${sessionId}/chatimage?href=${encodeURIComponent(image.href)}` : `/sessions/${sessionId}/chatasset?item=${encodeURIComponent(image.itemId)}${image.index == null ? '' : `&attachment=${image.index}`}`
    void api<{ url: string }>(route).then(result => { if (active) setUrl(result.url) }, cause => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [sessionId, image.href, image.itemId, image.index])
  return url ? <button type="button" className="workspace-icon-candidate transparency-grid" aria-label="Preview generated icon" onClick={() => choose(url)}><img src={url} alt="Generated icon proposal" /></button> : <span role={error ? 'alert' : 'status'}>{error || 'Loading image…'}</span>
}

export default function WorkspaceIconDialog({ projectId, initialImage, close }: { projectId: string; initialImage?: string; close: () => void }) {
  const state = useDesktop(), dialog = useRef<HTMLDialogElement>(null), upload = useRef<HTMLInputElement>(null)
  const [target, setTarget] = useState(projectId), [tab, setTab] = useState<'upload' | 'generate'>('upload')
  const project = state.projects.find(item => item.id === target)
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex'), [account, setAccount] = useState(''), [model, setModel] = useState('')
  const [description, setDescription] = useState(() => { const project = state.projects.find(item => item.id === projectId); return project ? `A distinctive icon for ${project.name}${project.repositories.length ? `, covering ${project.repositories.map(item => item.name).join(', ')}` : ''}. Simple shapes, no text.` : '' })
  const [prepared, setPrepared] = useState<Prepared | null>(null), [submitted, setSubmitted] = useState(false), [attempt, setAttempt] = useState(0), [progress, setProgress] = useState<Progress | null>(null)
  const [preview, setPreview] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const descriptionEdited = useRef(false), imageLoadVersion = useRef(0)
  const alive = useRef(true), generation = useRef(0), owned = useRef<{ id: string; submitted: boolean } | null>(null), returnFocus = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    alive.current = true; const element = dialog.current!, focus = returnFocus.current; element.showModal()
    return () => { alive.current = false; element.close(); (focus?.isConnected ? focus : document.querySelector<HTMLElement>('.project-chat-rail .selected'))?.focus({ preventScroll: true }); const current = owned.current; if (current && !current.submitted) void api(`/sessions/${current.id}`, {}, 'DELETE').catch(() => {}) }
  }, [])
  useEffect(() => {
    if (!submitted || !prepared) return
    let stopped = false, timer = 0
    const refresh = async () => {
      try { const result = await api<Progress>(`/projects/${target}/icon-generation`, { action: 'status', sessionId: prepared.sessionId, runtimeId: prepared.runtimeId }); if (!stopped) { setProgress(result); if (result.working || result.requests) timer = window.setTimeout(refresh, 1200) } }
      catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : String(cause)) }
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer) }
  }, [submitted, prepared, target, attempt])
  const loadImage = useCallback(async (source: Blob | string) => { const version = ++imageLoadVersion.current; setBusy(true); setError(''); try { const value = await normalizeWorkspaceIcon(source); if (alive.current && version === imageLoadVersion.current) setPreview(value) } catch (cause) { if (alive.current && version === imageLoadVersion.current) setError(cause instanceof Error ? cause.message : String(cause)) } finally { if (alive.current && version === imageLoadVersion.current) setBusy(false) } }, [])
  useEffect(() => { if (!initialImage) return; let active = true; void normalizeWorkspaceIcon(initialImage).then(value => { if (active) setPreview(value) }, cause => { if (active) setError(cause.message) }); return () => { active = false } }, [initialImage])
  useEffect(() => {
    if (initialImage) return
    let active = true
    void api<{ description: string }>(`/projects/${target}/icon-generation`, { action: 'context' }).then(value => { if (active && !descriptionEdited.current) setDescription(value.description) }).catch(() => {})
    return () => { active = false }
  }, [target, initialImage])
  const resetConnection = () => {
    generation.current++; const current = owned.current; owned.current = null
    if (current && !current.submitted) void api(`/sessions/${current.id}`, {}, 'DELETE').catch(() => {})
    setPrepared(null); setProgress(null); setSubmitted(false); setModel(''); setError('')
  }
  const loadModels = async () => {
    const version = ++generation.current; setBusy(true); setError('')
    try {
      const result = await api<Prepared>(`/projects/${target}/icon-generation`, { action: 'prepare', agent, accountProfileId: account })
      if (!alive.current || generation.current !== version) { void api(`/sessions/${result.sessionId}`, {}, 'DELETE').catch(() => {}); return }
      owned.current = { id: result.sessionId, submitted: false }; setPrepared(result)
      setModel(result.models[0]?.model || result.models[0]?.value || '')
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const generate = async () => {
    if (!prepared || !owned.current) return
    setBusy(true); setError(''); owned.current.submitted = true
    try { await api(`/projects/${target}/icon-generation`, { action: 'generate', sessionId: prepared.sessionId, runtimeId: prepared.runtimeId, model, description }); setSubmitted(true); setAttempt(value => value + 1); setProgress(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSubmitted(true) }
    finally { setBusy(false) }
  }
  const apply = async (dataUrl: string | null) => { setBusy(true); setError(''); try { await api(`/projects/${target}/icon`, { dataUrl }); close() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) } }
  const working = busy || !!progress?.working
  return createPortal(<dialog ref={dialog} className="workspace-icon-dialog workspace-native-dialog" aria-label="Workspace icon" onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <header><div><h2>Workspace icon</h2><small>{project?.name || 'Choose workspace'}</small></div><button type="button" className="desk-icon" aria-label="Close workspace icon" onClick={close}><Icon name="close" size={17} /></button></header>
    <div className="workspace-icon-body">
    {initialImage && <label className="desk-field">Workspace<DarkSelect appearance="workspace" label="Icon workspace" icon="workspace" value={target} disabled={working} options={state.projects.map(item => ({ value: item.id, label: item.name }))} onChange={value => { resetConnection(); setTarget(value) }} /></label>}
    {!initialImage && <div className="workspace-icon-tabs" role="group" aria-label="Icon source"><button type="button" aria-pressed={tab === 'upload'} onClick={() => setTab('upload')}>Upload</button><button type="button" aria-pressed={tab === 'generate'} onClick={() => setTab('generate')}>Generate with AI</button></div>}
    <div className="workspace-icon-stage transparency-grid">{preview ? <img src={preview} alt="Workspace icon preview" /> : <Icon name="image" size={42} />}</div>
    <span className="workspace-icon-transparency">{preview && <Icon name="check" size={12} />}Transparent PNG</span>
    {tab === 'upload' && !initialImage && <><input ref={upload} type="file" accept="image/png,image/webp" aria-label="Upload workspace icon" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void loadImage(file) }} /><button className="workspace-icon-upload" type="button" disabled={busy} onClick={() => upload.current?.click()}><Icon name="files" size={15} />Choose image</button></>}
    {tab === 'generate' && <>
      <div className="workspace-icon-providers" role="group" aria-label="Icon provider">{(['codex', 'claude'] as const).map(value => <button type="button" key={value} disabled={working || submitted} aria-pressed={agent === value} onClick={() => { resetConnection(); setAgent(value); setAccount('') }}><AgentLogo agent={value} size={17} />{value === 'codex' ? 'Codex' : 'Claude'}</button>)}</div>
      <AccountProfileSelect appearance="workspace" key={agent} agent={agent} value={account} disabled={working || submitted} onChange={value => { resetConnection(); setAccount(value) }} />
      <label className="desk-field">Model<DarkSelect appearance="workspace" label="Icon model" icon="" value={model} disabled={working || !prepared} options={prepared?.models.map(item => ({ value: item.model || item.value || '', label: item.displayName || item.label || item.model || item.value || '' })) || [{ value: '', label: 'Load available models' }]} onChange={setModel} /></label>
      <label className="desk-field">Description<textarea aria-label="Icon description" maxLength={6000} rows={3} value={description} disabled={working} onChange={event => { descriptionEdited.current = true; setDescription(event.target.value) }} /></label>
      {!prepared ? <button type="button" className="workspace-icon-generate" disabled={busy || !account} onClick={() => void loadModels()}>{busy ? 'Loading models…' : 'Load models'}</button> : <button type="button" className="workspace-icon-generate" disabled={working || !model || !description.trim()} onClick={() => void generate()}><Icon name="image" size={15} />{busy ? 'Starting…' : progress?.working ? 'Generating…' : submitted ? 'Regenerate' : 'Generate'}</button>}
      <small className="workspace-icon-note">Uses the selected account and its available image tools. No API fallback. Each generation sends one request.</small>
      {submitted && prepared && <><div className="workspace-icon-results">{progress?.images.map(image => <Candidate key={`${image.itemId}:${image.href || image.index || ''}`} sessionId={prepared.sessionId} image={image} choose={url => void loadImage(url)} />)}</div>{progress && !progress.working && !progress.images.length && <p className="workspace-icon-result-note">{progress.text || progress.error || 'No image returned. Open the chat to inspect the result.'}</p>}<button className="workspace-icon-chat" type="button" onClick={() => { selectChat(prepared.sessionId); close() }}>{progress?.requests ? 'Respond in chat' : 'Open generation chat'}<Icon name="external" size={13} /></button></>}
    </>}
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
    </div>
    <footer><button type="button" disabled={busy || !project?.iconRevision} onClick={() => void apply(null)}>Reset initials</button><button type="button" className="workspace-icon-apply" disabled={busy || !preview || !project} onClick={() => void apply(preview)}>Use icon</button></footer>
  </dialog>, document.body)
}

export function WorkspaceIconMenu({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  return <><AnchoredMenu label={`Workspace actions for ${project.name}`} className="workspace-actions-trigger">{dismiss => <div className="conversation-actions"><button type="button" onClick={() => { setOpen(true); dismiss() }}><Icon name="image" size={14} />Workspace icon</button></div>}</AnchoredMenu>{open && <WorkspaceIconDialog projectId={project.id} close={() => setOpen(false)} />}</>
}
