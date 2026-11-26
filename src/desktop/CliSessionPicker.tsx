import { useEffect, useRef, useState } from 'react'
import type { ChatSession } from './types'
import CodexModelMenu from './CodexModelMenu'
import { useConversationChrome } from './ConversationChrome'
import { AgentLogo, Icon } from './Icons'

export default function CliSessionPicker({ session }: { session: ChatSession }) {
  const { account } = useConversationChrome(), [open, setOpen] = useState(false), [selectedModel, setSelectedModel] = useState<{ id: string; source: string; label: string } | null>(null), container = useRef<HTMLDetailsElement>(null)
  const source = session.cliModelLabel || ''
  const selectionKey = `${session.id}:${session.accountProfileId || 'system'}:${session.cliModelLaunchId || ''}`
  const modelLabel = selectedModel?.id === selectionKey && selectedModel.source === source ? selectedModel.label : source
  const setModelLabel = (label: string) => setSelectedModel({ id: selectionKey, source, label })
  useEffect(() => {
    const outside = (event: Event) => {
      const node = event.target as HTMLElement, list = node.closest?.('[role="listbox"]')
      if (list && [...(container.current?.querySelectorAll('[aria-controls]') || [])].some(control => control.getAttribute('aria-controls') === list.id)) return
      if (!container.current?.contains(node) && container.current) container.current.open = false
    }
    const keys = (event: KeyboardEvent) => { if (event.key === 'Escape' && container.current?.open) { container.current.open = false; container.current.querySelector('summary')?.focus() } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keys)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keys) }
  }, [])
  if (!['codex', 'claude', 'opencode'].includes(session.agent)) return null
  return <details className="cli-session-settings" ref={container} onToggle={event => setOpen(event.currentTarget.open)}><summary aria-label="Model and session"><span>{modelLabel || (session.agent === 'claude' ? 'Claude' : session.agent === 'opencode' ? 'OpenCode' : 'Codex')}</span><Icon name="arrow" size={11} /></summary><div className="cli-session-settings-panel" role="group" aria-label="Model and session"><header className="cli-picker-heading"><AgentLogo agent={session.agent} size={16} /><strong>{session.agent === 'claude' ? 'Claude' : session.agent === 'opencode' ? 'OpenCode' : 'Codex'}</strong><button type="button" className="desk-icon" aria-label="Close model and session" onClick={() => { if (container.current) container.current.open = false; container.current?.querySelector('summary')?.focus() }}><Icon name="close" size={15} /></button></header>{open && account && <section><strong>Account</strong>{account}</section>}<CodexModelMenu sessionId={session.id} running={session.status === 'running'} agent={session.agent as 'codex' | 'claude' | 'opencode'} visible={open} modelLabel={modelLabel} effort={session.effort} onModelLabel={setModelLabel} /></div></details>
}
