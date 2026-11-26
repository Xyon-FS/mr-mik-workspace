import { Fragment, type ReactNode } from 'react'
import AnchoredMenu from './AnchoredMenu'
import { AgentLogo, Icon } from './Icons'
import type { AgentId } from './types'

// Same values and callbacks as the native settings controls; no configuration logic here.
export function ToolScopeSelect({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string; disabled?: boolean }[]; onChange: (value: string) => void; disabled?: boolean; icon?: string; compact?: boolean }) {
  return <div className="tool-scope-options" role="group" aria-label={label} data-value={value}>{options.map(option => <button type="button" key={option.value} role="radio" aria-checked={option.value === value} data-value={option.value} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
}

export default function ToolEntry({ name, subtitle, agent, browser = false, hidden = false, value, inherited = false, locked = false, availability, onCheck, checking = false, checkDisabled = false, connected = false, onVisibility, children }: { name: string; subtitle: string; agent?: AgentId; browser?: boolean; hidden?: boolean; value: string; inherited?: boolean; locked?: boolean; availability: ReactNode; onCheck?: () => void; checking?: boolean; checkDisabled?: boolean; connected?: boolean; onVisibility?: () => void; children: (close: () => void) => ReactNode }) {
  return <div className={`tools-entry${hidden ? ' is-hidden' : ''}`}>
    <AnchoredMenu label={`Details for ${name}`} className="tools-entry-name" placement="left" menuOwner="tools-details" appearance="workspace" triggerContent={<>{browser ? <Icon name="globe" size={16} /> : <AgentLogo agent={agent || 'codex'} size={16} />}<span><strong>{name}</strong><small>{subtitle.split(' · ').map((part,index) => <Fragment key={index}>{index > 0 && ' · '}<span>{part}</span></Fragment>)}</small></span></>}>
      {close => <><header className="tools-detail-header"><div><small>{subtitle}</small><h3>{name}</h3></div><button type="button" className="desk-icon" aria-label="Close tool details" onClick={close}><Icon name="close" size={15} /></button></header><div className="tools-detail-body">{children(close)}</div></>}
    </AnchoredMenu>
    <div className="tools-entry-controls"><AnchoredMenu label={`Availability for ${name}`} title={`${locked ? 'Controlled by the provider or plugin' : inherited ? 'Inherits global' : 'Explicit setting'} · ${value}`} className="tools-availability-trigger" placement="below" menuOwner="tools-availability" appearance="workspace" disabled={locked} triggerContent={<><span className="tools-inheritance-dot" data-inherited={inherited} aria-hidden="true" /><span>{value}</span><Icon name="arrow" size={10} /></>}>
      {() => <div className="tools-availability-options">{availability}</div>}
    </AnchoredMenu><button type="button" className={`desk-icon tools-check${connected ? ' connected' : ''}`} aria-label={browser ? `Check availability for ${name}` : `Check ${name} for ${agent === 'claude' ? 'Claude' : agent === 'opencode' ? 'OpenCode' : 'Codex'}`} title={!onCheck ? 'Check unavailable for this entry' : checking ? 'Checking…' : 'Check availability'} disabled={!onCheck || checking || checkDisabled} onClick={onCheck}><Icon name="refresh" size={14} /></button><button type="button" className="desk-icon tools-hide" aria-label={`${hidden ? 'Show' : 'Hide'} ${name} in Tools`} title={!onVisibility ? browser ? 'The integrated browser remains visible in Tools' : 'Visibility is controlled by the provider or plugin' : `${hidden ? 'Show' : 'Hide'} in Tools`} disabled={!onVisibility} onClick={onVisibility}><Icon name={hidden ? 'eye' : 'eyeOff'} size={14} /></button></div>
  </div>
}
