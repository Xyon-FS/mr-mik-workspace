import { useState } from 'react'
import type { Settings } from './types'
import { Icon } from './Icons'
import './window-layout-settings.css'

export default function WindowLayoutSettings({ value, busy, change }: { value: number; busy: boolean; change: (patch: Partial<Settings>) => Promise<void> }) {
  const [percent, setPercent] = useState(value)
  return <section className="window-layout-setting" aria-label="Window sizes">
    <h3>Window sizes</h3>
    <label htmlFor="chat-window-share">Chats {percent}% · Workspace {100 - percent}%</label>
    <div className="window-layout-compact"><input id="chat-window-share" type="range" min={20} max={65} step={1} value={percent} disabled={busy} aria-label="Chats share of screen" aria-valuetext={`Chats ${percent} percent, Workspace ${100 - percent} percent`} onChange={event => setPercent(Number(event.target.value))} />
    <button type="button" className="desk-icon" aria-label="Apply window sizes" title="Arrange both windows on this monitor; minimum widths may limit the split" disabled={busy} onClick={() => void change({ chatWidthPercent: percent })}><Icon name="layout" size={13} /></button><button type="button" className="desk-icon" aria-label="Reset to 30 / 70" title="Reset to Chats 30% / Workspace 70%" disabled={busy} onClick={() => setPercent(30)}><Icon name="refresh" size={13} /></button></div>
  </section>
}
