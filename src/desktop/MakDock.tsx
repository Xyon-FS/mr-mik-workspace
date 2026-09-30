import { useEffect, useState } from 'react'
import { onServiceEvent, useDesktop } from './client'
import { Nose } from './Icons'
import MakPanel from './MakPanel'
import './mak-dock.css'

export default function MakDock() {
  const { settings } = useDesktop()
  const [open, setOpen] = useState(false)
  useEffect(() => onServiceEvent(event => {
    if (event.type === 'navigate' && event.window === 'workspace' && event.section === 'mak') setOpen(true)
  }), [])
  return <div className={`mak-dock ${open ? 'panel-open' : ''}`}>
    {open && <MakPanel key={settings.selectedProjectId || 'global'} onClose={() => setOpen(false)} />}
    <button className="mak-launcher" aria-label="Toggle Mik" aria-expanded={open} aria-controls={open ? 'mak-conversation-panel' : undefined} title={open ? 'Hide Mik' : 'Open Mik'} onClick={() => setOpen(value => !value)}><Nose size={30} /></button>
  </div>
}
