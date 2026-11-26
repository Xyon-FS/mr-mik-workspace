import { useState } from 'react'
import { api } from './client'

type Review = { token: string; name: string; localFile: string; localFiles?: string[]; globalFile: string; reason: string; transport: string }
export type McpRecoveryUndo = { undoToken: string; backup: string }
export default function McpRecoveryControls({ name, agent, projectId, repositoryId, eligible, onChanged, profileId = 'system', undo, onUndoChange }: { undo?: McpRecoveryUndo; onUndoChange: (value: McpRecoveryUndo | undefined) => void; profileId?: string; name: string; agent: string; projectId: string; repositoryId: string; eligible: boolean; onChanged: () => Promise<void> }) {
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  if (!eligible && !undo && !review) return null
  return <div className="mcp-recovery">
    {eligible && !review && <button disabled={busy} onClick={() => void run(async () => setReview(await api<Review>('/mcp/recovery/preview', { profileId, agent, projectId, repositoryId, name })))}>Use global configuration</button>}
    {review && <div className="mcp-recovery-review" role="group" aria-label={`Review recovery for ${name}`}>
      <p className="mcp-note">{review.reason} Remove only this server’s local definition and inherit the global {review.transport.toUpperCase()} configuration. A private backup is retained. The global definition is valid for this recovery; its live connection has not been checked.</p>
      <p className="mcp-note">Local: {(review.localFiles || [review.localFile]).map(file => <code key={file}>{file}<br /></code>)}Global: <code>{review.globalFile}</code></p>
      <p className="mcp-note">Global configuration stays unchanged. Affected chats update when safe; busy requests and drafts defer the update.</p>
      <button disabled={busy} onClick={() => void run(async () => { onUndoChange(await api('/mcp/recovery/apply', { profileId, token: review.token })); setReview(null); await onChanged() })}>Confirm recovery</button>
      <button disabled={busy} onClick={() => setReview(null)}>Cancel</button>
    </div>}
    {undo && <><p className="mcp-note">Local definition recovered. Backup: <code>{undo.backup}</code></p><button disabled={busy} onClick={() => void run(async () => { await api('/mcp/recovery/undo', { profileId, token: undo.undoToken }); onUndoChange(undefined); await onChanged() })}>Undo recovery</button></>}
    {error && <p role="alert" className="desk-error-inline">{error}</p>}
  </div>
}
