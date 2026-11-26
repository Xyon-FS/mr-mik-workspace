import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from './client'
import { Icon } from './Icons'
import { PreviewOptions } from './PreviewChrome'
import type { Inspection, InspectedFile, InspectedChange } from '../../desktop/service/chat-inspector.mjs'
import './changes-inspector.css'

export function InspectResultButton({ sessionId, itemId, review = false, label }: { sessionId: string; itemId: string; review?: boolean; label?: string }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return <><button type="button" disabled={busy} onClick={() => {
    setBusy(true); setError('')
    void api(`/inspector/${sessionId}`, { action: 'show', itemId }).catch(cause => setError(cause.message)).finally(() => setBusy(false))
  }}><Icon name="files" size={14} />{label || (review ? 'Inspect review' : 'Inspect changes')}</button>{error && <small role="alert">{error}</small>}</>
}

type View = { fileKey: string; mode: 'diff' | 'current'; patchId?: string; line?: number; end?: number; request?: number; focusLine?: boolean }
type RowSelection = { key: string; anchor: number; end: number }

function fileName(displayPath: string) {
  const slash = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'))
  return { name: displayPath.slice(slash + 1), folder: displayPath.slice(0, slash + 1) }
}

function Counts({ file }: { file: InspectedChange }) {
  return file.added || file.removed ? <span className="inspector-counts" title={file.patches.length > 1 ? 'Totals across recorded patches' : undefined}>
    <span className="inspector-added">+{file.added}</span>
    <span className="inspector-removed">&minus;{file.removed}</span>
  </span> : null
}

export default function ChangesInspector({ selection }: { selection: { sessionId: string; itemId: string } }) {
  const endpoint = `/inspector/${selection.sessionId}`
  const [attempt, setAttempt] = useState(0)
  const [recorded, setRecorded] = useState<{ attempt: number; data?: Inspection; error?: string }>()
  const [view, setView] = useState<View>()
  const [wrap, setWrap] = useState(true)
  const [goto, setGoto] = useState(false)
  const [range, setRange] = useState<RowSelection | null>(null)
  const [cursor, setCursor] = useState<{ key: string; index: number }>()
  const [quoteResult, setQuoteResult] = useState<{ key: string; message: string; error: boolean }>()
  const [quoting, setQuoting] = useState(false)
  const [live, setLive] = useState<{ key: string; file?: InspectedFile; error?: string }>()
  const body = useRef<HTMLDivElement>(null)
  const gotoInput = useRef<HTMLInputElement>(null)
  const quoteButton = useRef<HTMLButtonElement>(null)
  const positions = useRef(new Map<string, { top: number; left: number }>())
  const nextRequest = useRef(0), appliedFocus = useRef(0)

  useEffect(() => {
    let active = true
    void api<Inspection>(`${endpoint}?itemId=${encodeURIComponent(selection.itemId)}`).then(data => {
      if (active) setRecorded({ attempt, data })
    }).catch(cause => {
      if (active) setRecorded(previous => ({ attempt, data: previous?.data, error: cause.message }))
    })
    return () => { active = false }
  }, [attempt, endpoint, selection.itemId])

  const data = recorded?.data
  const review = data?.type === 'exitedReviewMode'
  const file = data?.files.find(entry => entry.key === view?.fileKey) || data?.files[0]
  const fileKey = file?.key
  const choice = view?.fileKey === fileKey ? view : undefined
  const patch = file?.patches.find(entry => entry.id === choice?.patchId) || file?.patches[0]
  const mode = choice?.mode === 'current' || review && !patch ? 'current' : 'diff'
  const findingForFile = review ? data.findings.find(value => value.fileId === file?.id) : undefined
  const currentLine = choice?.line ?? findingForFile?.line ?? 1
  const currentEnd = choice?.end ?? findingForFile?.end ?? currentLine
  const request = choice?.request || 0, focusLine = choice?.focusLine
  const version = data?.version, fileId = file?.id, itemId = data?.itemId
  const activePatchId = patch?.id
  const liveKey = JSON.stringify([version, fileId, currentLine, request, recorded?.attempt])
  const savedKey = JSON.stringify([fileKey, mode, mode === 'diff' ? activePatchId : null])
  const rangeKey = JSON.stringify([version, fileKey, activePatchId])
  const current = live?.key === liveKey ? live.file : undefined
  const liveError = live?.key === liveKey ? live.error : undefined
  const pending = mode === 'current' && !current && !liveError
  const activeRange = range?.key === rangeKey ? range : null
  const activeRow = cursor?.key === rangeKey ? cursor.index : 0
  const selectedFrom = activeRange ? Math.min(activeRange.anchor, activeRange.end) : -1
  const selectedTo = activeRange ? Math.max(activeRange.anchor, activeRange.end) : -1
  const selectable = mode === 'diff' && !!patch?.rows.length && !patch.binary
  const feedback = quoteResult?.key === rangeKey && mode === 'diff' ? quoteResult : undefined
  const path = file ? fileName(file.displayPath) : null
  const refreshing = recorded?.attempt !== attempt

  useEffect(() => {
    if (mode !== 'current' || !version || !fileId || !itemId) return
    let active = true
    void api<InspectedFile>(endpoint, { action: 'file', itemId, version, fileId, line: currentLine }).then(result => {
      if (active) setLive({ key: liveKey, file: result })
    }).catch(cause => {
      if (active) setLive({ key: liveKey, error: cause.message })
    })
    return () => { active = false }
  }, [mode, version, fileId, itemId, liveKey, endpoint, currentLine])

  useLayoutEffect(() => {
    if (!body.current || pending) return
    if (mode === 'current' && focusLine && request > appliedFocus.current && current?.status === 'ready') {
      appliedFocus.current = request
      const target = body.current.querySelector<HTMLElement>('[data-current-line="true"]')
      target?.scrollIntoView({ block: 'center', inline: 'nearest' })
      target?.focus({ preventScroll: true })
      return
    }
    const position = positions.current.get(savedKey)
    if (!position && mode === 'current' && current?.status === 'ready' && current.line && current.line > 1) {
      body.current.querySelector<HTMLElement>('[data-current-line="true"]')?.scrollIntoView({ block: 'center', inline: 'nearest' })
      return
    }
    body.current.scrollTop = position?.top || 0
    body.current.scrollLeft = wrap ? 0 : position?.left || 0
  }, [current, focusLine, mode, pending, request, savedKey, version, wrap])

  useLayoutEffect(() => { if (goto) gotoInput.current?.focus() }, [goto])

  const chooseFile = (entry: InspectedChange) => {
    setRange(null); setQuoteResult(undefined); setGoto(false)
    if (review && !entry.patches.length) {
      const finding = data?.findings.find(value => value.fileId === entry.id)
      openLine(entry, finding?.line || 1, finding?.end || finding?.line || 1)
    } else setView({ fileKey: entry.key, mode: 'diff' })
  }
  const openLine = (entry: InspectedChange, line: number, end = line) => {
    setGoto(false)
    setView({ fileKey: entry.key, mode: 'current', patchId: entry.key === fileKey ? activePatchId : undefined, line, end, request: ++nextRequest.current, focusLine: true })
  }
  const selectRow = (index: number, extend: boolean, from = index) => {
    setCursor({ key: rangeKey, index })
    setQuoteResult(undefined)
    setRange(previous => ({ key: rangeKey, anchor: extend ? previous?.key === rangeKey ? previous.anchor : from : index, end: index }))
  }
  const quote = async () => {
    if (!data || !file || !patch || !activeRange || quoting) return
    setQuoting(true); setQuoteResult(undefined)
    try {
      await api(endpoint, { action: 'quote', runtimeId: data.runtimeId, itemId: data.itemId, version: data.version, fileId: file.id, patchId: patch.id, start: selectedFrom, end: selectedTo })
      if (document.activeElement === quoteButton.current) body.current?.querySelector<HTMLElement>('.inspector-select-row[tabindex="0"]')?.focus()
      setRange(previous => previous === activeRange ? null : previous)
      setQuoteResult({ key: rangeKey, message: 'Added to prompt context', error: false })
    } catch (cause) {
      setQuoteResult({ key: rangeKey, message: cause instanceof Error ? cause.message : 'Context unavailable', error: true })
    } finally { setQuoting(false) }
  }

  return <section className="changes-inspector" role="region" aria-label="Changes inspector">
    {!data && <div className="inspector-empty">
      {recorded?.error ? <><p role="alert">{recorded.error}</p><button type="button" disabled={refreshing} onClick={() => setAttempt(value => value + 1)}>Retry</button></> : <p role="status">Loading recorded result&hellip;</p>}
    </div>}
    {data && <div className="inspector-layout">
      <aside className="inspector-sidebar" aria-label="Changed files">
        <h3>{review ? 'Referenced files' : 'Files'} <span>{data.files.length}</span></h3>
        {data.files.map(entry => {
          const { name, folder } = fileName(entry.displayPath)
          return <button key={entry.id} type="button" className="inspector-file" aria-pressed={entry.id === file?.id} title={entry.displayPath} onClick={() => chooseFile(entry)}>
            <span><strong>{name}</strong>{folder && <small>{folder}</small>}</span><Counts file={entry} />
          </button>
        })}
        {!data.files.length && <p>No file locations recorded.</p>}
      </aside>
      <main className="inspector-reader">
        {file && <label className="inspector-file-picker">File<select aria-label="Changed file" value={file.id} onChange={event => {
          const entry = data.files.find(value => value.id === event.target.value)
          if (entry) chooseFile(entry)
        }}>{data.files.map(entry => <option key={entry.id} value={entry.id}>{entry.displayPath}</option>)}</select></label>}
        <header className="inspector-file-heading">
          <div className="inspector-path"><strong title={file?.displayPath}>{path?.name || (review ? 'Review' : 'Changes')}</strong>{path?.folder && <small>{path.folder}</small>}</div>
          {file && <Counts file={file} />}
          <PreviewOptions label="Changes options">
            <button type="button" disabled={refreshing} onClick={() => setAttempt(value => value + 1)}><Icon name="refresh" size={14} />Refresh recorded result</button>
            {current?.partial && <button type="button" onClick={() => setGoto(true)}>Go to line&hellip;</button>}
            {file && <label className="inspector-wrap"><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />Wrap long lines</label>}
            {patch?.previousPath && <p>Moved from {patch.previousPath}</p>}
            {patch?.kind && <p>{patch.kind}</p>}
          </PreviewOptions>
        </header>
        {file && (!review || patch) && <div className="inspector-file-views">
          <div role="group" aria-label="File view">
            <button type="button" aria-pressed={mode === 'diff'} onClick={() => {
              setGoto(false); setView({ ...choice, fileKey: file.key, mode: 'diff', patchId: activePatchId })
            }}>Recorded diff</button>
            <button type="button" aria-pressed={mode === 'current'} onClick={() => {
              if (mode === 'current') return
              const line = activeRange && patch?.rows[activeRow]?.next
              if (line) openLine(file, line)
              else setView({ ...choice, fileKey: file.key, mode: 'current', patchId: activePatchId, request: ++nextRequest.current, focusLine: false })
            }}>Current file</button>
          </div>
          {mode === 'diff' && file.patches.length > 1 && <label className="inspector-patch-picker"><span>Patch</span><select aria-label="Recorded patch" value={activePatchId} onChange={event => {
            setView({ ...choice, fileKey: file.key, mode: 'diff', patchId: event.target.value }); setRange(null); setQuoteResult(undefined)
          }}>{file.patches.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1} / {file.patches.length}</option>)}</select></label>}
        </div>}
        {refreshing && <p className="inspector-notice" role="status">Refreshing recorded result&hellip;</p>}
        {recorded.error && <p className="inspector-notice" role="alert">{recorded.error}</p>}
        {data.status === 'inProgress' && <p className="inspector-notice" role="status">Operation in progress.</p>}
        {data.status === 'failed' && <p className="inspector-notice" role="status">The recorded operation failed.</p>}
        {goto && file && mode === 'current' && <form className="inspector-goto" onSubmit={event => {
          event.preventDefault()
          const line = gotoInput.current?.valueAsNumber
          if (line) openLine(file, line)
        }}><label>Line <input ref={gotoInput} type="number" min={1} max={current?.totalLines} step={1} defaultValue={currentLine} required /></label>
          <button type="submit">Go to line</button>
          <button type="button" onClick={() => { setGoto(false); body.current?.focus() }}>Cancel</button>
        </form>}
        <div className={`inspector-body${wrap ? ' inspector-wrap-lines' : ''}`} ref={body}
          tabIndex={selectable ? -1 : 0} aria-label={mode === 'diff' ? 'Recorded diff' : 'Current file preview'}
          onScroll={event => {
            if (!pending) positions.current.set(savedKey, {
              top: event.currentTarget.scrollTop,
              left: wrap ? positions.current.get(savedKey)?.left || 0 : event.currentTarget.scrollLeft,
            })
          }}>
          {data.filesTruncated && <p className="inspector-notice">The recorded result contains additional files.</p>}
          {review && <>
            {data.reviewSummary && <p>{data.reviewSummary}</p>}
            {!!data.findings.length && <details className="inspector-review">
              <summary>{data.findings.some(item => item.source === 'structured') ? 'Findings' : 'File references'} <small>{data.findings.length}</small></summary>
              {data.findings.map(item => {
                const entry = data.files.find(value => value.id === item.fileId)
                const title = item.priority != null ? item.title.replace(/^\[P[0-3]\]\s*/, '') : item.title
                return <div className="inspector-finding" key={item.id}>
                  {entry ? <button type="button" onClick={() => openLine(entry, item.line || 1, item.end || item.line || 1)}>{item.priority != null && <small>P{item.priority}</small>}{title}</button> : <strong>{title}</strong>}
                  {item.path && <small>{entry?.displayPath || item.path}{item.line ? `:${item.line}` : ''}</small>}
                  {item.body && <p>{item.body}</p>}
                </div>
              })}
            </details>}
            <details className="inspector-review" open={!data.structuredReview && !data.findings.length}><summary>Recorded review text</summary><pre>{data.review || 'No review text was recorded.'}</pre>{data.reviewTruncated && <p>Recorded review preview shortened.</p>}</details>
          </>}
          {file && mode === 'diff' && <>
            {patch?.truncated && <p className="inspector-notice">Recorded diff shortened. Totals cover displayed lines.</p>}
            {patch?.binary ? <p>Binary change. A text diff is unavailable.</p> : !selectable ? <p>No diff was recorded for this file. Switch to Current file to inspect it.</p>
              : <div className="inspector-code">{patch?.rows.map((row, index) => <button key={index} type="button"
                className={`inspector-diff-row inspector-select-row ${row.type}`} data-row={index}
                tabIndex={index === activeRow ? 0 : -1} aria-pressed={index >= selectedFrom && index <= selectedTo}
                aria-label={`Diff row ${index + 1}${row.old != null ? `, old line ${row.old}` : ''}${row.next != null ? `, new line ${row.next}` : ''}: ${row.text || 'blank'}`}
                onClick={event => selectRow(index, event.shiftKey)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && row.next && !event.shiftKey) { event.preventDefault(); openLine(file, row.next); return }
                  if (event.key === 'Escape') { setRange(null); return }
                  if (!patch || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const last = patch.rows.length - 1
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, index + (event.key === 'ArrowUp' ? -1 : 1)))
                  if (event.shiftKey) selectRow(next, true, index)
                  else setCursor({ key: rangeKey, index: next })
                  body.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus()
                }}>
                <span aria-hidden="true" className="inspector-line">{row.old}</span>
                <span aria-hidden="true" className="inspector-line">{row.next}</span>
                <code>{row.text || ' '}</code>
              </button>)}</div>}
          </>}
          {file && mode === 'current' && <>
            {pending && <p role="status">Reading current file&hellip;</p>}
            {liveError && <p role="alert">{liveError}</p>}
            {current && current.status !== 'ready' && <p className="inspector-notice" role="status">{current.message}</p>}
            {current?.status === 'ready' && <>
              <p className="inspector-notice">Live file{current.partial && ` · Lines ${current.start}–${(current.start || 1) + (current.lines?.length || 0) - 1} of ${current.totalLines}`}</p>
              <div className="inspector-code">{current.lines?.map(row => <div key={row.number} className="inspector-current-row" data-current-line={row.number === current.line || undefined}
                data-finding-range={row.number >= currentLine && row.number <= currentEnd || undefined} tabIndex={-1}>
                <span className="inspector-line">{row.number}</span><code>{row.text || ' '}{row.truncated && <em> · line shortened</em>}</code>
              </div>)}</div>
            </>}
          </>}
          {!file && !review && <p>No file locations recorded.</p>}
        </div>
        <div className="inspector-selection" hidden={!selectable || (!activeRange && !feedback)}>
          <span role="status">{activeRange ? (selectedFrom === selectedTo ? `Row ${selectedFrom + 1} selected` : `Rows ${selectedFrom + 1}–${selectedTo + 1} selected`) : feedback?.message}</span>
          {activeRange && <button ref={quoteButton} type="button" disabled={quoting} onClick={() => void quote()}>{quoting ? 'Adding…' : 'Quote in chat'}</button>}
          {feedback?.error && <span role="alert">{feedback.message}</span>}
        </div>
      </main>
    </div>}
  </section>
}
