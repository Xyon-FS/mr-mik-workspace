import { useEffect, useRef, useState } from 'react'
import WorkspaceDialog from './WorkspaceDialog'

export function useSettingsConfirmation() {
  const [message, setMessage] = useState('')
  const result = useRef<((approved: boolean) => void) | null>(null)
  useEffect(() => () => { result.current?.(false) }, [])
  const decide = (approved: boolean) => { result.current?.(approved); result.current = null; setMessage('') }
  const confirm = (text: string) => new Promise<boolean>(resolve => { result.current?.(false); result.current = resolve; setMessage(text) })
  return { confirm, dialog: message ? <WorkspaceDialog label="Confirm account action" close={() => decide(false)}><h3>Confirm account action</h3><p>{message}</p><footer><button onClick={() => decide(false)}>Cancel</button><button onClick={() => decide(true)}>Confirm</button></footer></WorkspaceDialog> : null }
}
