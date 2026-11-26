import { useState } from 'react'
import { api, useDesktop } from './client'
import AnchoredMenu from './AnchoredMenu'
import DarkSelect from './DarkSelect'
import type { LibraryResource } from './types'
import type { WorkspaceEntity } from '../types'

function Editor({ card, resource, close, refreshed }: { card?: WorkspaceEntity; resource?: LibraryResource; close: () => void; refreshed: () => void }) {
  const { projects } = useDesktop()
  const [workspace, setWorkspace] = useState(card?.projectId || resource?.projectId || '')
  const [repository, setRepository] = useState(card?.repositoryId || '')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const project = projects.find(item => item.id === workspace)
  return <form className="collection-association-editor" onSubmit={event => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    const request = card ? api('/cards/assign', { id: card.id, projectId: workspace || null, repositoryId: repository || null }) : api('/resources/assign', { kind: resource!.kind, path: resource!.path, projectId: workspace || null })
    void request.then(() => { refreshed(); close() }, cause => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) })
  }}>
    <strong>{card?.title || resource?.title}</strong>
    <label>Workspace<DarkSelect label="Workspace" appearance="workspace" contained icon="" disabled={busy} value={workspace} onChange={value => { setWorkspace(value); setRepository('') }} options={[{value:'',label:'Global Hub'},...projects.map(item=>({value:item.id,label:item.name}))]} /></label>
    {card && <label>Linked project<DarkSelect label="Linked project" appearance="workspace" contained icon="" disabled={busy} value={repository} onChange={setRepository} options={[{value:'',label:'No project'},...(project?.repositories.map(item=>({value:item.id,label:item.name+(!item.available?' · folder unavailable':'')}))||[])]} /></label>}
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></footer>
  </form>
}

export default function CollectionAssociation({ card, resource, refreshed }: { card?: WorkspaceEntity; resource?: LibraryResource; refreshed: () => void }) {
  const { projects } = useDesktop()
  const project = projects.find(item => item.id === (card?.projectId || resource?.projectId))
  const repository = project?.repositories.find(item => item.id === card?.repositoryId)
  const title = card?.title || resource?.title || ''
  return <AnchoredMenu label={`Associations for ${title}`} title={`Workspace: ${project?.name || 'Global Hub'}${card ? ` / Project: ${repository?.name || 'None'}` : ''}`} triggerText={repository?.name || project?.name || 'Global Hub'} className="collection-association-trigger" placement="below" appearance="workspace">{close => <Editor card={card} resource={resource} close={close} refreshed={refreshed} />}</AnchoredMenu>
}
