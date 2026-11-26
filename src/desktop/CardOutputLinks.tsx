import type { ChatOutputSource, WorkspaceEntity } from '../types'
import { api, reportError, setPreview, useDesktop } from './client'
import type { Preview } from './types'
import './chat-outputs.css'

export function ChatOutputOrigin({ source }: { source: ChatOutputSource }) {
  const state = useDesktop(), available = state.sessions.some(session => session.id === source.sessionId)
  return <span className="card-output-origin"><small>{source.mode === 'live' ? 'Live file' : 'Saved response'} · {source.agent === 'claude' ? 'Claude' : 'Codex'} · {source.savedAt.slice(0, 10)}</small><button type="button" disabled={!available} title={available ? 'Open the source conversation without sending a message' : 'The source conversation is not available in this Hub'} onClick={() => { void api(`/sessions/${source.sessionId}/focus`, {}).catch(reportError) }}>Source chat</button></span>
}

export default function CardOutputLinks({ entity }: { entity: WorkspaceEntity }) {
  return <section className="card-linked-outputs" aria-label="Linked card outputs">{entity.artifacts?.map(artifact => <div key={`${artifact.scope || 'repository'}:${artifact.repositoryId || ''}:${artifact.path}`}>
    <button type="button" title={artifact.path} onClick={() => {
      const query = new URLSearchParams({ projectId: entity.projectId || '', id: entity.id, path: artifact.path, scope: artifact.scope || 'repository', ...(artifact.repositoryId ? { repositoryId: artifact.repositoryId } : {}) })
      void api<Preview>(`/cards/artifact/preview?${query}`).then(setPreview).catch(reportError)
    }}>{artifact.title}<small>{artifact.scope === 'hub' ? 'Hub file' : 'Project file'} · live link</small></button>
    {artifact.source && <ChatOutputOrigin source={artifact.source} />}
  </div>)}</section>
}
