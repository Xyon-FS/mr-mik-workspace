import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons'
import { defaultChatShortcuts, shortcutChord, shortcutError, useChatShortcuts, type ChatShortcut } from './chatShortcuts'

export default function NavigationPreferences({ overlay, setOverlay }: { overlay: boolean; setOverlay: (value: boolean) => void }) {
  const [editing, setEditing] = useState(false), [message, setMessage] = useState(''), [shortcuts, save] = useChatShortcuts()
  const section = useRef<HTMLElement>(null)
  useEffect(() => { if (editing) section.current?.querySelector('input')?.focus() }, [editing])
  const labels: Record<ChatShortcut, string> = { new: 'New chat', search: 'Search', history: 'History', sidebar: 'Sidebar' }
  return <section ref={section} className={`navigation-preferences${editing ? ' editing-shortcuts' : ''}`}>
    <header>{editing && <button type="button" className="desk-icon" aria-label="Back to navigation preferences" onClick={() => setEditing(false)}><Icon name="back" size={15} /></button>}<strong>{editing ? 'Shortcuts' : 'Navigation'}</strong></header>
    {editing ? <><div className="navigation-shortcut-list">{(Object.keys(labels) as ChatShortcut[]).map(key => <label key={key}><span>{labels[key]}</span><input readOnly aria-label={`${labels[key]} shortcut`} value={shortcuts[key]} onKeyDown={event => {
      if (event.key === 'Tab') return
      event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation()
      if (event.key === 'Escape') { event.currentTarget.blur(); return }
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
      const chord = shortcutChord(event.nativeEvent), error = shortcutError(chord, shortcuts, key)
      setMessage(error || 'Shortcut updated.')
      if (!error) save({ ...shortcuts, [key]: chord })
    }} /></label>)}</div><p role="status">{message || 'Select a shortcut and press a new combination.'}</p><button type="button" onClick={() => { save({ ...defaultChatShortcuts }); setMessage('Default shortcuts restored.') }}><Icon name="refresh" size={14} />Restore defaults</button></> : <><label className="navigation-overlay-switch"><span>Always overlay sidebar</span><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} /></label><button type="button" onClick={() => setEditing(true)}><Icon name="keyboard" size={15} />Shortcuts</button></>}
  </section>
}
