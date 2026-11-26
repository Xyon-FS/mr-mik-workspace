import { ChatAttachmentGroup } from './ChatAttachment'
import { visibleUserText } from '../../desktop/service/chat-input-presentation.mjs'
import MakLogo from '../components/MakLogo'
import VirtualChatTurns from './VirtualChatTurns'
import useStableChatCallback from './useStableChatCallback'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ChatActivity from './GraphicalActivityCard'
import { Icon } from './Icons'
import { matches } from './graphicalSearch'
import type { ToolResource } from './GraphicalToolResults'
import { InspectResultButton } from './ChangesInspector'
import GraphicalMessageActions, { MessageTextActions } from './GraphicalMessageActions'
import { MessageQuote } from './GraphicalComposerContext'
import ChatOutputActions from './ChatOutputActions'
import { IntermediateOutputContext } from './intermediateOutputContext'
import { isFailedActivity } from './graphicalActivityState'
import type { ComposerContext } from '../../desktop/service/graphical-composer.mjs'
import { skillMentions } from '../../desktop/service/skill-mentions.mjs'

function messageText(item: GraphicalItem) {
  const text = item.type === 'userMessage' ? visibleUserText(item) : item.text
  if (item.type !== 'userMessage' || !item.composerContext?.some(value => value.type === 'skill')) return text
  const named = new Set(skillMentions(item.text).map(value => value.name))
  const legacy = item.composerContext?.filter(value => value.type === 'skill' && !named.has(value.name)) || []
  return text + (legacy.length ? '\n\n' + legacy.map(value => value.type === 'skill' ? `$${value.name}` : '').join(' ') : '')
}

export type StepPresentation = { arguments?: string; argumentsTruncated?: boolean; structured?: string; structuredTruncated?: boolean; resultText?: string; resultTextLength?: number; resultTextTruncated?: boolean; error?: string; cwd?: string; actions?: { type: string; path: string; query: string }[]; web?: { action: string; queries: string[]; url: string; pattern: string }; label?: string; note?: string }
export type GraphicalItem = { presentation?: StepPresentation; composerContext?: ComposerContext[]; resources?: ToolResource[]; agents?: { id: string; status: string; message: string }[]; id: string; type: string; text: string; details: string; detailsTruncated?: boolean; plan?: { step: string; status: string }[]; attachments?: { path: string; name: string; kind: string }[]; changes?: { path: string; previousPath?: string | null; kind: string; diff: string; diffTruncated?: boolean }[]; status: string; path?: string | null; turnId?: string | null; phase?: string | null; durationMs?: number | null; exitCode?: number | null; tool?: string; server?: string }
export type GraphicalTurn = { id: string; status: string; startedAt: number | null; completedAt: number | null; durationMs: number | null; timingSource: string; observedUntil?: number }

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function ChangesSummary({ sessionId, items }: { sessionId: string; items: GraphicalItem[] }) {
  const edits = items.filter(item => item.type === 'fileChange' && item.status === 'completed' && item.changes?.length)
  if (!edits.length) return null
  const changes = edits.flatMap(item => item.changes || [])
  const count = new Set(changes.map(change => change.path)).size
  let added = 0, removed = 0
  for (const change of changes) {
    let hunk = false
    for (const line of change.diff.split('\n')) {
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) { hunk = true; continue }
      if (hunk && line.startsWith('+')) added++
      else if (hunk && line.startsWith('-')) removed++
    }
  }
  const turnId = edits[0].turnId
  const combined = turnId && edits.every(item => item.turnId === turnId)
  return <section className="graphical-changes-summary" aria-label="Changes made in this response"><span className="graphical-changes-caption"><Icon name="files" size={18} /><span><strong>{count} {count === 1 ? 'file changed' : 'files changed'}</strong><small>{added > 0 && <span className="changes-added">+{added}</span>}{removed > 0 && <span className="changes-removed">−{removed}</span>}{!added && !removed && 'Recorded changes'}</small></span></span><div className="graphical-changes-actions">{combined ? <InspectResultButton sessionId={sessionId} itemId={`turn-changes:${turnId}`} label="View changes" /> : edits.map((item, index) => <InspectResultButton key={item.id} sessionId={sessionId} itemId={item.id} label={edits.length === 1 ? 'View changes' : `View changes ${index + 1}`} />)}</div></section>
}

function TurnStatus({ turn, active, waiting, connected, uncertain, items, historical, compact = false }: { compact?: boolean; turn?: GraphicalTurn; active: boolean; waiting: boolean; connected: boolean; uncertain?: boolean; items: GraphicalItem[]; historical?: boolean; messageActionsDisabled?: boolean }) {
  const [now, setNow] = useState(Date.now)
  const [visible, setVisible] = useState(true)
  const element = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let inView = true
    const update = () => setVisible(inView && !document.hidden)
    const observer = new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? true; update() })
    if (element.current) observer.observe(element.current)
    document.addEventListener('visibilitychange', update); update()
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [])
  useEffect(() => {
    if (!active || !connected || uncertain || !visible) return
    const update = () => setNow(Date.now())
    update(); const timer = window.setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [active, connected, uncertain, visible])
  const live = [...items].reverse().find(item => item.status === 'inProgress' && !['agentMessage', 'userMessage'].includes(item.type))
  const label = uncertain ? 'Delivery uncertain' : active && !connected ? 'Disconnected' : active ? waiting ? 'Waiting for your response' : ({ reasoning: 'Thinking', commandExecution: 'Running command', mcpToolCall: 'Using tool', dynamicToolCall: 'Using tool', webSearch: 'Searching', imageGeneration: 'Creating image', contextCompaction: 'Condensing context' } as Record<string, string>)[live?.type || ''] || 'Working' : turn?.status === 'interrupted' ? 'Stopped' : turn?.status === 'failed' ? 'Failed' : turn?.status === 'inProgress' ? historical ? 'Earlier activity' : 'Connection interrupted' : turn?.status === 'completed' ? 'Worked' : 'Earlier activity'
  const elapsed = turn?.durationMs ?? (turn?.startedAt != null && (active || turn.completedAt != null || turn.observedUntil != null) ? Math.max(0, (turn.completedAt ?? turn.observedUntil ?? now) - turn.startedAt) : null)
  const animated = active && connected && !waiting && !uncertain && visible
  const settled = !active && turn != null && ['completed', 'failed', 'interrupted'].includes(turn.status)
  const hasActivities = settled && items.some(item => !['agentMessage', 'userMessage'].includes(item.type) && !(item.path && item.status !== 'failed') && (item.type !== 'reasoning' || !!(item.text || item.details).trim()))
  const caption = <><span className="graphical-working-caption">{active && <span className="graphical-working-mark"><MakLogo tone="black" size={17} /></span>}<span role="status" aria-live="polite" className="graphical-status-label">{label}</span>{elapsed != null && <span className="graphical-elapsed">{active ? '·' : 'for'} {duration(elapsed)}</span>}</span></>
  return <span ref={element} className={`graphical-turn-status ${compact ? 'compact' : ''} ${animated ? 'active' : ''} ${settled ? 'settled' : ''}`} data-turn-status={active ? 'active' : turn?.status || 'unknown'}>{hasActivities && !compact ? <button type="button" className="graphical-turn-disclosure" title="Show or hide recorded activities" onClick={() => {
    const groups = [...(element.current?.closest('.graphical-turn')?.querySelectorAll<HTMLDetailsElement>('details.graphical-work-group') || [])]
    const show = groups.some(group => !group.open); groups.forEach(group => { group.open = show })
  }}>{caption}<Icon name="arrow" size={12} /></button> : caption}</span>
}

function WorkGroup({ sessionId, items, markdown, output, file, query, status, visible = true }: { visible?: boolean; status?: ReactNode; runtimeId?: string; sessionId: string; items: GraphicalItem[]; markdown: (text: string, streaming?: boolean, itemId?: string, skillContext?: ComposerContext[], origin?: 'input' | 'output') => ReactNode; output: (id: string) => Promise<string>; file: (item: GraphicalItem, index: number) => ReactNode; query: string }) {
  const allFailed = items.length > 0 && items.every(isFailedActivity)
  const [opened, setOpened] = useState(false)
  const label = items.length === 1 && items[0].type === 'reasoning' ? 'Thought summary' : `${items.length} ${items.length === 1 ? 'activity' : 'activities'}`
  return <details onToggle={event => { if (event.target === event.currentTarget) setOpened(event.currentTarget.open) }} className={`graphical-work-group ${allFailed ? 'failed' : ''}`}><summary>{status}<span className="graphical-activity-count">{label}</span>{allFailed && <span> · Failed activity</span>}</summary><div>{items.map(item => <div key={item.id} data-chat-item={item.id} data-search-match={matches(item, query) || undefined}>{visible && (opened || !!query) && <ChatActivity sessionId={sessionId} item={item} markdown={markdown} output={() => output(item.id)} file={index => file(item, index)} />}</div>)}</div></details>
}

function ProcessDisclosure({ summary, children, active, completed }: { summary: ReactNode; children: (expanded: boolean) => ReactNode; active: boolean; completed: boolean }) {
  const [expanded, setExpanded] = useState(active && !completed)
  const root = useRef<HTMLDetailsElement>(null)
  const [pins, setPins] = useState(0)
  useEffect(() => {
    const turn = root.current?.closest<HTMLElement>('[data-turn-id]'), view = turn?.closest('.graphical-messages')
    if (!view) return
    const pin = (event: Event) => { const detail = (event as CustomEvent<{ key: string; pin?: boolean }>).detail; if (detail.key === turn?.dataset.turnId && detail.pin != null) setPins(count => Math.max(0, count + (detail.pin ? 1 : -1))) }
    view.addEventListener('graphical-preview-pin', pin)
    return () => view.removeEventListener('graphical-preview-pin', pin)
  }, [])
  const settled = useRef(false)
  useLayoutEffect(() => {
    if (completed && !settled.current) {
      settled.current = true
      if (root.current) root.current.open = false
      setExpanded(false)
    } else if (active && !completed && !settled.current) setExpanded(true)
  }, [active, completed])
  return <details ref={root} open={expanded} className="graphical-turn-process" onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open) }}><summary>{summary}</summary><div className="graphical-process-steps"><IntermediateOutputContext.Provider value={true}>{children(expanded || pins > 0)}</IntermediateOutputContext.Provider></div></details>
}

type TimelineTurnProps = Pick<Parameters<typeof Timeline>[0], 'runtimeId' | 'sessionId' | 'waiting' | 'connected' | 'uncertain' | 'query' | 'markdown' | 'image' | 'attachment' | 'output' | 'file' | 'quote' | 'quoteSource' | 'historical' | 'messageActionsDisabled' | 'messageActionsAvailable' | 'responseLabel'> & { id: string; groupItems: GraphicalItem[]; turn?: GraphicalTurn; active: boolean }
const TimelineTurn = memo(function TimelineTurn({ id, groupItems, turn, active, runtimeId, sessionId, waiting, connected, uncertain, query, markdown, image, attachment, output, file, quote, quoteSource, historical, messageActionsDisabled, messageActionsAvailable, responseLabel }: TimelineTurnProps) {
    const filtered = groupItems.filter(item => (item.type !== 'reasoning' || !!(item.text || item.details).trim()) && (item.type !== 'agentMessage' || !!item.text.trim() || !!item.attachments?.length))
    const rows: { id: string; items: GraphicalItem[]; work: boolean }[] = []
    for (const item of filtered) {
      const work = !['userMessage', 'agentMessage'].includes(item.type) && !(item.path && item.status !== 'failed')
      const previous = rows[rows.length - 1]
      if (work && previous?.work) previous.items.push(item)
      else rows.push({ id: item.id, items: [item], work })
    }
    let finalRow = -1
    rows.forEach((row, index) => { if (row.items[0].type === 'agentMessage' && row.items[0].phase === 'final_answer') finalRow = index })
    if (finalRow < 0 && !active) rows.forEach((row,index) => { if (row.items[0].type === 'agentMessage' && row.items[0].phase !== 'commentary') finalRow = index })
    const intermediate = (row: typeof rows[number], index: number) => row.work || (row.items[0].type === 'agentMessage' ? index !== finalRow && row.items[0].phase !== 'final_answer' : row.items[0].type !== 'userMessage' && (active || finalRow >= 0 && index < finalRow))
    let orderedRows = rows.map((row, index) => ({ row, index, step: intermediate(row, index) }))
    const hasSteps = orderedRows.some(entry => entry.step)
    if (!active && finalRow >= 0 && hasSteps) {
      let prompt = finalRow - 1
      while (prompt >= 0 && rows[prompt].items[0].type !== 'userMessage') prompt--
      const firstAnswer = rows.findIndex((row, index) => index > prompt && (index === finalRow || row.items[0].type === 'agentMessage' && row.items[0].phase === 'final_answer'))
      const nextPrompt = rows.findIndex((row, index) => index > finalRow && row.items[0].type === 'userMessage')
      const end = nextPrompt < 0 ? rows.length : nextPrompt
      const reply = orderedRows.slice(firstAnswer, end)
      // Late activity belongs above the answer within the same user-message span.
      if (reply.some(entry => entry.step)) orderedRows = [
        ...orderedRows.slice(0, firstAnswer),
        ...reply.filter(entry => entry.step),
        ...reply.filter(entry => !entry.step),
        ...orderedRows.slice(end),
      ]
    }
    const status = (active || turn != null || hasSteps) && !query ? <TurnStatus compact historical={historical} turn={turn} active={active} waiting={waiting} connected={connected} uncertain={active ? uncertain : false} items={groupItems} /> : null
    const renderRow = (row: typeof rows[number], index: number, visible = true) => {
      if (row.work) return <WorkGroup key={row.id} visible={visible} sessionId={sessionId} items={row.items} markdown={markdown} output={output} file={file} query={query} />
      const item = row.items[0]
      if (item.type !== 'userMessage' && item.type !== 'agentMessage') {
        return <article key={item.id} data-chat-item={item.id} data-search-match={matches(item, query) || undefined} className="graphical-message graphical-result">{visible && image(item)}</article>
      }
      const user = item.type === 'userMessage'
      const text = messageText(item)
      const quotes = item.composerContext?.filter(value => value.type === 'quote') || []
      const canCite = user || !active && !intermediate(row, index)
      const canSave = !user && canCite && !!item.text.trim()
      const canBranch = messageActionsAvailable && !!item.turnId && (user || index === finalRow)
      return <article key={item.id} data-chat-item={item.id} data-search-match={matches(item, query) || undefined} className={`graphical-message ${item.type}`} aria-label={user ? 'Your message' : responseLabel}>
        {visible && <>
          {!!quotes.length && <div className="graphical-sent-context" aria-label="Quoted context">{quotes.map(value => <MessageQuote key={value.id} item={value} source={value.inspection ? undefined : id => quoteSource(id, true)} />)}</div>}
          <div className="graphical-message-text">{markdown(text, active && !user && item.status === 'inProgress', item.id, user ? item.composerContext : undefined, user ? 'input' : 'output')}</div>
          {!!item.attachments?.length && <div className="graphical-sent-attachments">{user ? <ChatAttachmentGroup sessionId={sessionId} itemId={item.id} items={item.attachments} /> : item.attachments.map((_, index) => <Fragment key={index}>{attachment(item, index)}</Fragment>)}</div>}
          {(text.trim() || canBranch) && <div className="graphical-message-actions" role="toolbar" aria-label="Message actions">
            <MessageTextActions text={text} user={user} quote={canCite ? value => quote(item, value) : undefined} />
            {canSave && <ChatOutputActions sessionId={sessionId} reference={{ itemId: item.id, message: true }} />}
            {canBranch && <GraphicalMessageActions runtimeId={runtimeId} sessionId={sessionId} itemId={item.id} user={user} disabled={messageActionsDisabled || active} />}
          </div>}
        </>}
      </article>
    }
    const chunks: { steps: boolean; rows: { row: typeof rows[number]; index: number }[] }[] = []
    orderedRows.forEach(({ row, index, step }) => {
      const previous = chunks[chunks.length - 1]
      if (previous?.steps === step) previous.rows.push({ row, index })
      else chunks.push({ steps: step, rows: [{ row, index }] })
    })
    const lastStep = chunks.map(chunk => chunk.steps).lastIndexOf(true)
    const trailingUser = rows[rows.length - 1]?.items[0].type === 'userMessage'
    return <section key={id} className="graphical-turn" data-turn-id={id}>
      {chunks.map((chunk, chunkIndex) => {
        if (!chunk.steps) return <Fragment key={chunk.rows[0].row.id}>{chunk.rows.map(({row,index}) => <Fragment key={row.id}>{!hasSteps && !(active && trailingUser) && index === rows.findIndex(value => value.items[0].type !== 'userMessage') && status}{renderRow(row,index)}</Fragment>)}</Fragment>
        const current = chunkIndex === lastStep && !(active && trailingUser)
        const activityCount = chunk.rows.reduce((count,{row}) => count + (row.work ? row.items.length : 0),0)
        const caption = current ? status : !query ? <span className="graphical-turn-status">Earlier activity</span> : null
        return <ProcessDisclosure key={chunk.rows[0].row.id} active={active && current} completed={turn?.status === 'completed'} summary={<>{caption || <span>Response steps</span>}{activityCount > 0 && <span className="graphical-activity-count">· {activityCount} {activityCount === 1 ? 'activity' : 'activities'}</span>}<Icon name="arrow" size={12} /></>}>{expanded => chunk.rows.map(({row,index}) => renderRow(row,index,expanded))}</ProcessDisclosure>
      })}
      {(!rows.length || trailingUser) && status}
      {!active && <ChangesSummary sessionId={sessionId} items={groupItems} />}
    </section>
}, (before, after) => Object.keys(before).length === Object.keys(after).length && (Object.keys(before) as (keyof TimelineTurnProps)[]).every(key => key === 'groupItems'
  ? before.groupItems.length === after.groupItems.length && before.groupItems.every((item, index) => item === after.groupItems[index])
  : before[key] === after[key]))

function Timeline({ getView, runtimeId, sessionId, items, turns = [], activeTurnId, working, waiting, connected, uncertain, query, markdown, image, attachment, output, file, quote, quoteSource, historical, messageActionsDisabled = true, messageActionsAvailable = true, responseLabel = 'Codex response' }: { getView: () => HTMLDivElement | null; runtimeId?: string; sessionId: string; items: GraphicalItem[]; turns?: GraphicalTurn[]; activeTurnId?: string | null; working: boolean; waiting: boolean; connected: boolean; uncertain?: boolean; query: string; markdown: (text: string, streaming?: boolean, itemId?: string, skillContext?: ComposerContext[], origin?: 'input' | 'output') => ReactNode; image: (item: GraphicalItem) => ReactNode; attachment: (item: GraphicalItem, index: number) => ReactNode; output: (id: string) => Promise<string>; file: (item: GraphicalItem, index: number) => ReactNode; quote: (item: GraphicalItem, text: string) => Promise<void>; quoteSource: (id: string, sent?: boolean) => void; historical?: boolean; messageActionsDisabled?: boolean; messageActionsAvailable?: boolean; responseLabel?: string }) {
  const groups = useMemo(() => {
  const grouped = new Map<string, GraphicalItem[]>()
  let current = 'history'
  for (const item of items) {
    current = item.turnId || (item.type === 'userMessage' ? `message-${item.id}` : current)
    if (!item.turnId && item.type === 'agentMessage' && grouped.get(current)?.some(value => value.type === 'agentMessage')) current = `message-${item.id}`
    if (!grouped.has(current)) grouped.set(current, [])
    grouped.get(current)!.push(item)
  }
  if (activeTurnId && !grouped.has(activeTurnId)) grouped.set(activeTurnId, [])
  return [...grouped]
  }, [items, activeTurnId])
  const keys = useMemo(() => groups.map(([id]) => id), [groups])
  useEffect(() => {
    if (!connected) return
    if (!performance.getEntriesByName('mr-mik:chat-snapshot-ready').length) performance.mark('mr-mik:chat-snapshot-ready')
    const view = getView(), mark = 'mr-mik:chat-transcript-visible'
    if (!view || !items.length || performance.getEntriesByName(mark).length) return
    let frame = 0
    const check = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds = view.getBoundingClientRect()
        const visible = [...view.querySelectorAll('article.graphical-message[data-chat-item]')].some(message => {
          const row = message.getBoundingClientRect()
          return row.height > 0 && row.bottom > bounds.top && row.top < bounds.bottom
        })
        if (!visible || document.hidden) return
        if (!performance.getEntriesByName(mark).length) performance.mark(mark)
        view.removeEventListener('graphical-rows-ready', check)
        document.removeEventListener('visibilitychange', check)
      })
    }
    check()
    view.addEventListener('graphical-rows-ready', check)
    document.addEventListener('visibilitychange', check)
    return () => { cancelAnimationFrame(frame); view.removeEventListener('graphical-rows-ready', check); document.removeEventListener('visibilitychange', check) }
  }, [connected, getView, items.length])
  // History restoration runs in layout and needs the indices from this commit.
  useLayoutEffect(() => {
    const view = getView(); if (!view) return
    const reveal = (event: Event) => { const detail = (event as CustomEvent<{ id: string; index?: number }>).detail; detail.index = groups.findIndex(([, values]) => values.some(item => item.id === detail.id)) }
    view.addEventListener('graphical-reveal', reveal, true)
    return () => view.removeEventListener('graphical-reveal', reveal, true)
  }, [groups, getView])
  return <><VirtualChatTurns keys={keys} getView={getView} startAtEnd={!historical && !query} render={index => {
    const [id, groupItems] = groups[index]
    const turn = turns.find(value => value.id === id)
    const active = working && id === activeTurnId
    return <TimelineTurn id={id} groupItems={groupItems} turn={turn} active={active} runtimeId={runtimeId} sessionId={sessionId} waiting={waiting} connected={connected} uncertain={uncertain} query={query} markdown={markdown} image={image} attachment={attachment} output={output} file={file} quote={quote} quoteSource={quoteSource} historical={historical} messageActionsDisabled={messageActionsDisabled} messageActionsAvailable={messageActionsAvailable} responseLabel={responseLabel} />
  }} />{working && !activeTurnId && <div className="graphical-turn-status"><span role="status">{uncertain ? 'Delivery uncertain' : 'Sending…'}</span></div>}</>
}

const MemoTimeline = memo(Timeline)
export default function GraphicalTimeline(props: Parameters<typeof Timeline>[0]) {
  const image = useStableChatCallback(props.image), attachment = useStableChatCallback(props.attachment), output = useStableChatCallback(props.output), file = useStableChatCallback(props.file), quote = useStableChatCallback(props.quote), quoteSource = useStableChatCallback(props.quoteSource)
  return <MemoTimeline {...props} image={image} attachment={attachment} output={output} file={file} quote={quote} quoteSource={quoteSource} />
}
