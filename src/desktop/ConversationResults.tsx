import { useRef, useState } from 'react'
import { Icon } from './Icons'
import ConversationOutputBrowser from './ConversationOutputBrowser'

export default function ConversationResults({ sessionId, labelled = false }: { sessionId: string; labelled?: boolean }) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  return <div className="conversation-results"><button ref={trigger} type="button" className={labelled ? 'conversation-results-row' : 'desk-icon'} aria-label="Conversation outputs" title="Conversation outputs" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="files" size={16} />{labelled && <span>Conversation outputs</span>}</button>{open && <ConversationOutputBrowser key={sessionId} sessionId={sessionId} close={() => { setOpen(false); const details = trigger.current?.closest('details'); if (details) details.open = true; trigger.current?.focus() }} />}</div>
}
