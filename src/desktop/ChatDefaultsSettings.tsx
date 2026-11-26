import { useState } from 'react'
import type { Settings } from './types'
import DarkSelect from './DarkSelect'
import ReasoningSelect from './ReasoningSelect'
import CodexPermissionsSelect from './CodexPermissionsSelect'
import { useReasoningCapabilities } from './useReasoningCapabilities'

const agents = [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]
export default function ChatDefaultsSettings({ settings, busy, change }: { settings: Settings; busy: boolean; change: (patch: Partial<Settings>) => Promise<void> }) {
  const [reasoningAgent, setReasoningAgent] = useState(settings.defaultAgent === 'claude' ? 'claude' : 'codex')
  const reasoning = useReasoningCapabilities(undefined, 'system', 'defaults')
  return <>
    <div className="settings-provider-tabs" role="group" aria-label="Default provider">{agents.map(agent => <button type="button" key={agent.value} disabled={busy} aria-pressed={reasoningAgent === agent.value} onClick={() => setReasoningAgent(agent.value)}>{agent.label}</button>)}</div>
    <div className="chat-default-setting" role="group" aria-label="Default worker reasoning"><strong>Worker reasoning</strong>
      <ReasoningSelect icon="" appearance="workspace" label="Worker reasoning level" disabled={busy} value={reasoningAgent === 'claude' ? settings.defaultClaudeWorkerEffort || 'high' : settings.defaultWorkerEffort} efforts={reasoningAgent === 'claude' ? reasoning.data?.claude.efforts : reasoning.data?.codexWorker.efforts} onChange={value => void change(reasoningAgent === 'claude' ? { defaultClaudeWorkerEffort: value } : { defaultWorkerEffort: value })} />
    </div>
    <div className="chat-default-setting" role="group" aria-label="Default permissions"><strong>Default permissions</strong>
      {reasoningAgent === 'codex' ? <CodexPermissionsSelect appearance="workspace" icon="" disabled={busy} value={settings.defaultCodexPermissions || (settings.defaultBypass ? 'bypass' : 'ask')} onChange={value => void change({ defaultCodexPermissions: value })} /> : <DarkSelect appearance="workspace" label="Claude permissions" icon="" disabled={busy} value={settings.defaultClaudePermissions || (settings.defaultBypass ? 'bypass' : 'ask')} options={[{ value: 'ask', label: 'Ask' }, { value: 'bypass', label: 'Bypass permissions' }]} onChange={value => void change({ defaultClaudePermissions: value as 'ask' | 'bypass' })} />}
    </div>
    <p className="desk-muted">Each agent keeps its own defaults. Applies to new chats; existing chats keep their settings.</p>
  </>
}
