import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Native modal containment provides focus trapping, Escape and return focus.
export default function WorkspaceDialog({ label, close, busy = false, children, role = 'dialog', className = '' }: { label: string; close: () => void; busy?: boolean; children: ReactNode; role?: 'dialog' | 'alertdialog'; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close() }, [])
  return createPortal(<dialog ref={dialog} className={`file-confirm workspace-edit-dialog workspace-native-dialog ${className}`} role={role} aria-label={label} onCancel={event => { event.preventDefault(); if (!busy) close() }} onClick={event => { if (event.target === event.currentTarget && !busy) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close() } }}>{children}</dialog>, document.body)
}
