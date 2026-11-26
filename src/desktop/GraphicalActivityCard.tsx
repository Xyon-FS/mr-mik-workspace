import { IntermediateOutputContext } from './intermediateOutputContext'
import { useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { AgentActivity } from './GraphicalOperations'
import type { GraphicalItem } from './GraphicalTimeline'
import GraphicalToolResults from './GraphicalToolResults'
import { InspectResultButton } from './ChangesInspector'
import './graphical-steps.css'
import { diffLines } from './graphicalDiff'
import { Icon } from './Icons'
import { commandLabel, isFailedActivity } from './graphicalActivityState'

export type ActivityItem = GraphicalItem
type Props = { sessionId: string; item: ActivityItem; markdown: (text: string) => ReactNode; output: () => Promise<string>; file: (index: number) => ReactNode }

function RecordedCode({ text, label, shortened }: { text: string; label: string; shortened?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null), [error, setError] = useState('')
  return <div className="graphical-step-code"><header><span>{label}</span><button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(text); setError('') }, () => setError('Copy unavailable. Select the text to copy it.')) }}>{copied === text ? 'Copied' : 'Copy'}</button></header><pre tabIndex={0}><code>{label === 'Diff' ? diffLines(text).map(({ line, kind }, index) => <span key={index} className={kind}>{index > 0 ? '\n' : ''}{line}</span>) : text}</code></pre>{shortened && <p className="graphical-output-note">Structured preview shortened.</p>}{error && <p role="alert">{error}</p>}</div>
}
function Output({ item, output }: Pick<Props, 'item' | 'output'>) {
  const intermediate = useContext(IntermediateOutputContext)
  const [loaded, setLoaded] = useState<{source: string; status: string; text: string} | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const full = loaded?.source === item.details && loaded.status === item.status ? loaded.text : null
  return <>{(full ?? item.details) && <RecordedCode text={full ?? item.details} label={item.type === 'fileChange' ? 'Diff' : 'Output'} />}{item.detailsTruncated && <p className="graphical-output-note">{full == null ? 'Output preview shortened.' : 'Recorded output snapshot loaded.'} <button type="button" disabled={loading} onClick={() => { setLoading(true); setError(''); const source = item.details; void output().then(text => setLoaded({source,status: item.status,text}), cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false)) }}>{loading ? 'Loading…' : 'Load full output'}</button>{full != null && !intermediate && <a download="tool-output.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(full)}`}>Save output</a>}</p>}{error && <p role="alert">{error}</p>}</>
}
function Step({ item, label, children, expose = false }: { item: ActivityItem; label: string; children?: ReactNode; expose?: boolean }) {
  // Keep the same DOM/component tree when a running tool gains resources. Only
  // seed disclosure on mount: subsequent results must respect the user's choice.
  const [opened, setOpened] = useState(expose)
  const failed = isFailedActivity(item)
  const status = item.type === 'commandExecution' ? undefined : item.status === 'completed' ? 'Completed' : ({ inProgress: 'In progress', failed: 'Failed', declined: 'Declined', interrupted: 'Cancelled', cancelled: 'Cancelled', canceled: 'Cancelled' } as Record<string, string>)[item.status]
  return <details open={opened} onToggle={event => { if (event.target === event.currentTarget) setOpened(event.currentTarget.open) }} className={`graphical-activity graphical-step${expose ? ' graphical-result-activity' : ''}${failed ? ' failed' : ''}`} data-step-type={item.type}><summary><span>{label}</span>{status && <small>{status}</small>}{item.durationMs != null && <small>{(item.durationMs / 1000).toFixed(1)}s</small>}{item.exitCode != null && <small>Exit {item.exitCode}</small>}</summary>{item.presentation?.error && <p className="graphical-step-error" role="note">{item.presentation.error}</p>}{children}</details>
}
function CommandStep({ item, output }: Props) {
  const label = commandLabel(item)
  return <Step item={item} label={label}>{item.presentation?.cwd && <p className="graphical-step-path">{item.presentation.cwd}</p>}{item.text && <RecordedCode text={item.text} label="Command" />}{item.presentation?.actions?.filter(action => action.type !== 'unknown').map((action,index) => <p className="graphical-step-path" key={index}>{({ read: 'Read file', listFiles: 'List files', search: 'Search files' } as Record<string,string>)[action.type] || action.type}{action.path && <> · <code>{action.path}</code></>}{action.query && <> · {action.query}</>}</p>)}<Output item={item} output={output} /></Step>
}
function ToolStep({ sessionId, item, markdown, output }: Props) {
  const structured = item.presentation?.structured
  const textOutput = item.presentation?.resultText ?? item.details
  return <Step item={item} expose={!!item.resources?.length} label={[item.server, item.presentation?.label || item.tool || 'Tool activity'].filter(Boolean).join(' · ')}>{item.text && markdown(item.text)}{item.presentation?.arguments && <details className="graphical-step-inspect"><summary>Arguments</summary><RecordedCode text={item.presentation.arguments} label="Arguments" shortened={item.presentation.argumentsTruncated} /></details>}{!!item.resources?.length && <GraphicalToolResults sessionId={sessionId} itemId={item.id} resources={item.resources} />}{textOutput && <Output item={structured ? { ...item, details: textOutput, detailsTruncated: item.presentation?.resultTextTruncated === true } : item} output={async () => { const recorded = await output(); return structured && item.presentation?.resultTextLength != null ? recorded.slice(0, item.presentation.resultTextLength) : recorded }} />}{structured && <details className="graphical-step-inspect"><summary>Structured result</summary><RecordedCode text={structured} label="Result" shortened={item.presentation?.structuredTruncated} /></details>}</Step>
}
function WebStep({ item, output }: Props) {
  const web = item.presentation?.web
  return <Step item={item} label={web?.action === 'openPage' ? 'Opened page' : web?.action === 'findInPage' ? 'Find in page' : 'Web search'}>{web?.queries.map((query,index) => <p key={index} className="graphical-step-query">{query}</p>)}{web?.url && <p className="graphical-step-path">{/^https?:\/\//i.test(web.url) ? <a href={web.url} target="_blank" rel="noreferrer">{web.url}</a> : web.url}</p>}{web?.pattern && <RecordedCode label="Find" text={web.pattern} />}{item.text && <p>{item.text}</p>}<Output item={item} output={output} />{item.presentation?.structured && <details className="graphical-step-inspect"><summary>Recorded search results</summary><RecordedCode label="Results" text={item.presentation.structured} shortened={item.presentation.structuredTruncated} /></details>}</Step>
}
function FileStep({ sessionId, item, file, output }: Props) {
  const intermediate = useContext(IntermediateOutputContext)
  const names: Record<string,string> = { add: 'Created', update: 'Modified', delete: 'Deleted' }
  return <Step item={item} expose={!!item.changes?.length} label="File changes">{!intermediate && <InspectResultButton sessionId={sessionId} itemId={item.id} />}{item.changes?.map((change,index) => <details key={`${index}:${change.path}`} className="graphical-file-change"><summary><span>{change.previousPath ? 'Moved' : names[change.kind] || change.kind}</span><code className="graphical-step-file-path" title={change.path}>{intermediate ? change.path.replace(/\\/g, '/').split('/').slice(-2).join('/') : change.path}</code></summary>{change.previousPath && <p className="graphical-step-path">From {change.previousPath}</p>}{!intermediate && file(index)}{change.diff && <div className="graphical-step-diff"><RecordedCode label="Diff" text={change.diff} /></div>}{change.diffTruncated && <p>Diff preview shortened.</p>}</details>)}{!item.changes?.length && <Output item={item} output={output} />}{!!item.changes?.length && item.detailsTruncated && <details><summary>Complete patch output</summary><Output item={item} output={output} /></details>}</Step>
}
function PlanStep({ item, markdown }: Props) {
  return <section className="graphical-plan" aria-label="Agent plan"><strong>Plan{item.plan?.length ? ` · ${item.plan.filter(step => step.status === 'completed').length}/${item.plan.length}` : ''}</strong>{item.text && markdown(item.text)}{!!item.plan?.length && <ol>{item.plan.map((step,index) => <li key={index} data-state={step.status}><span className="graphical-plan-status" aria-label={step.status === 'completed' ? 'Completed' : step.status === 'inProgress' ? 'In progress' : 'Pending'}>{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◉' : '○'}</span><span className="graphical-plan-text">{step.step}</span></li>)}</ol>}</section>
}
function ReviewStep({ item, sessionId, markdown }: Props) {
  const intermediate = useContext(IntermediateOutputContext)
  const [copyStatus, setCopyStatus] = useState('')
  let findings: { title: string; body: string; path: string; line?: number }[] = []
  let findingsCount = 0
  let description = item.text
  try {
    const review = JSON.parse(item.text)
    if (Array.isArray(review.findings)) findingsCount = review.findings.length
    if (Array.isArray(review.findings)) findings = review.findings.slice(0, 50).filter((value: unknown) => value && typeof value === 'object').map((value: { title?: unknown; body?: unknown; code_location?: { absolute_file_path?: unknown; line_range?: { start?: unknown } } }) => ({ title: typeof value.title === 'string' ? value.title : 'Recorded finding', body: typeof value.body === 'string' ? value.body : '', path: typeof value.code_location?.absolute_file_path === 'string' ? value.code_location.absolute_file_path : '', line: typeof value.code_location?.line_range?.start === 'number' ? value.code_location.line_range.start : undefined }))
    if (typeof review.overall_explanation === 'string') description = review.overall_explanation
    else if (Array.isArray(review.findings)) description = `${review.findings.length} ${review.findings.length === 1 ? 'finding' : 'findings'} recorded.`
  } catch { /* Native review text is also supported. */ }
  return <section className="graphical-review-result" aria-label="Review results"><header><strong>Review results</strong>{intermediate && <button type="button" className="graphical-step-copy" aria-label="Copy review" title="Copy review" onClick={() => void navigator.clipboard.writeText(item.text).then(() => setCopyStatus('Copied'), () => setCopyStatus('Copy unavailable'))}><Icon name="files" size={14} /></button>}</header>{description && markdown(description)}{intermediate ? findings.length > 0 && <details className="graphical-review-findings"><summary>Findings</summary><ol>{findings.map((finding, index) => <li key={index}><strong>{finding.title}</strong>{finding.path && <code title={finding.path}>{finding.path.replace(/\\/g, '/').split('/').slice(-2).join('/')}{finding.line != null ? `:${finding.line}` : ''}</code>}{finding.body && markdown(finding.body)}</li>)}</ol>{findingsCount > findings.length && <p className="graphical-output-note">Showing {findings.length} of {findingsCount} findings. Copy review includes the complete record.</p>}</details> : <InspectResultButton sessionId={sessionId} itemId={item.id} review />}{copyStatus && <small role="status">{copyStatus}</small>}</section>
}
function OtherStep({ item, markdown, output, sessionId }: Props) {
  const label = ({ imageGeneration: item.status === 'failed' ? 'Image generation failed' : item.status === 'inProgress' ? 'Creating image' : 'Generated image', imageView: 'Viewed image', enteredReviewMode: 'Review', contextCompaction: 'Context condensed', collabToolCall: 'Agent activity', collabAgentToolCall: 'Agent activity', subAgentActivity: 'Agent activity', hookPrompt: 'Hook context', sleep: 'Waiting' } as Record<string,string>)[item.type] || `Activity · ${item.type}`
  return <Step item={item} label={label}>{item.text && (item.type === 'hookPrompt' || item.type === 'enteredReviewMode' ? markdown(item.text) : label.startsWith('Activity · ') ? <RecordedCode text={item.text} label="Recorded text" /> : <p>{item.text}</p>)}{item.presentation?.note && <p>{item.presentation.note}</p>}{item.path && <p className="graphical-step-path">{item.path}</p>}{!!item.resources?.length && <GraphicalToolResults sessionId={sessionId} itemId={item.id} resources={item.resources} />}<Output item={item} output={output} />{!item.text && !item.details && !item.path && !item.presentation?.note && !item.resources?.length && <p className="graphical-output-note">No additional displayable details were recorded.</p>}</Step>
}
const renderers: Record<string,(props: Props) => ReactNode> = { commandExecution: CommandStep, mcpToolCall: ToolStep, dynamicToolCall: ToolStep, functionCallOutput: ToolStep, webSearch: WebStep, fileChange: FileStep, plan: PlanStep, exitedReviewMode: ReviewStep }
export default function GraphicalActivityCard(props: Props) {
  const { item, markdown, sessionId } = props
  if (item.type === 'reasoning') return (item.text || item.details) ? <div className="graphical-thought-summary">{markdown(item.text || item.details)}</div> : null
  if (item.type === 'collabAgentToolCall' && item.agents?.length) return <AgentActivity sessionId={sessionId} item={item} />
  const Renderer = renderers[item.type] || OtherStep
  return <Renderer {...props} />
}
