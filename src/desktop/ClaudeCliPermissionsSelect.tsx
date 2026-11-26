import { useState } from 'react'
import DarkSelect from './DarkSelect'
import { api, reportError } from './client'
import type { ChatSession } from './types'

export default function ClaudeCliPermissionsSelect({ session, disabled }: { session: ChatSession; disabled: boolean }) {
  const [busy, setBusy] = useState(false)
  const value = session.claudePermissionMode || (session.bypass ? 'bypassPermissions' : 'default')
  const options = [{ value: 'default', label: 'Ask' }, { value: 'auto', label: 'Auto' }, { value: 'acceptEdits', label: 'Accept edits' }, { value: 'plan', label: 'Plan' }, ...(session.bypass || session.claudeBypassAllowed || value === 'bypassPermissions' ? [{ value: 'bypassPermissions', label: 'Bypass permissions' }] : [])]
  return <DarkSelect variant="permissions" label="Claude permissions" compact icon="" value={value} options={options} disabled={disabled || busy || session.status !== 'running' || session.activity !== 'idle'} onChange={permissionMode => { setBusy(true); void api(`/sessions/${session.id}/claudepermissions`, { permissionMode }).catch(reportError).finally(() => setBusy(false)) }} />
}
