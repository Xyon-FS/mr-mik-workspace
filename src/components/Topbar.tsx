import { useState } from 'react'
import type { WorkspaceEntity } from '../types'
import { api, isDesktop, reportError } from '../desktop/client'
import { AgentLogo, Icon } from '../desktop/Icons'
import CardActions from '../desktop/CardActions'

interface TopbarProps {
  entity: WorkspaceEntity | null
  projectId?: string | null
  workspaceName?: string
  onHome: () => void
  reportUrl: string | null
}

export default function Topbar({ entity, projectId, workspaceName, onHome, reportUrl }: TopbarProps) {
  const [openingChat, setOpeningChat] = useState(false)
  const openChat = async (agent: 'codex' | 'claude' | 'opencode' = 'codex') => {
    if (openingChat) return
    setOpeningChat(true)
    try {
      const workspaceId = entity ? entity.projectId || null : projectId || null
      if (workspaceId || agent !== 'codex') await api('/chats/quick', { agent, projectId: workspaceId, cardId: entity?.id || null })
      else await api('/chats/compose', { projectId: null, cardId: null })
    } catch (error) { reportError(error) }
    finally { setOpeningChat(false) }
  }
  return (
    <div className="topbar">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <button className="crumb-link" onClick={onHome}>
          Workspace{workspaceName && ` · ${workspaceName}`}
        </button>
        {entity && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{entity.title}</span>
          </>
        )}
      </nav>

      {(entity || isDesktop) && (
        <div className="topbar-right">
          {isDesktop && entity && <button className="topbar-card-pin" aria-label={`${entity.pinned ? 'Unpin' : 'Pin'} card ${entity.title}`} title={entity.pinned ? 'Unpin card' : 'Pin card'} onClick={() => void api('/cards/pin', { id: entity.id, pinned: !entity.pinned }).catch(reportError)}>{entity.pinned ? '📌 Pinned' : '📌 Pin'}</button>}
          {isDesktop && (['codex', 'claude', 'opencode'] as const).map(agent => <button key={agent} className="topbar-new-chat" disabled={openingChat} aria-label={`New ${agent === 'opencode' ? 'OpenCode' : agent === 'codex' ? 'Codex' : 'Claude'} chat`} aria-busy={openingChat} title={`New ${agent === 'opencode' ? 'OpenCode' : agent === 'codex' ? 'Codex' : 'Claude'} chat`} onClick={() => void openChat(agent)}><AgentLogo agent={agent} size={18} /><Icon name="plus" size={12} /></button>)}
          {entity && reportUrl && (
            <a
              className="open-ext"
              href={reportUrl}
              target="_blank"
              rel="noreferrer"
              title="Open report in a new tab"
            >
              ↗
            </a>
          )}
          {isDesktop && entity && <CardActions entity={entity} />}
        </div>
      )}
    </div>
  )
}
