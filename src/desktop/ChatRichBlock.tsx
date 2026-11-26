import { IntermediateOutputContext } from './intermediateOutputContext'
import { useContext, Children, isValidElement, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './client'
import { usePreviewViewport } from './previewMemory'
import { downloadPreview, tableCsv } from './previewDownloads'
import { Icon } from './Icons'
import StructuredData from './StructuredData'
import { useChatPreviewPin, focusChatPreviewSource } from './useChatPreviewPin'
import './chat-minimal.css'
import InlineHtml from './InlineHtml'
import AnchoredMenu from './AnchoredMenu'
import DiagramViewport from './DiagramViewport'
import SvgDocument from './SvgDocument'
import { parseStructuredData } from './parseStructuredData'

function codeSource(node: ReactNode): { text: string; language: string } {
  const child = Children.toArray(node)[0]
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return { text: '', language: '' }
  if (typeof child.props.children === 'string') return { text: child.props.children.replace(/\n$/, ''), language: child.props.className?.replace('language-', '') || 'text' }
  return codeSource(child.props.children)
}

function nodeText(node: ReactNode): string { return Children.toArray(node).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? nodeText(child.props.children) : '').join('') }
function tableCells(node: ReactNode): string[][] { return Children.toArray(node).flatMap(child => !isValidElement<{ children?: ReactNode }>(child) ? [] : child.type === 'tr' ? [Children.toArray(child.props.children).map(cell => nodeText(cell))] : tableCells(child.props.children)) }
function fingerprint(value: string) { let hash = 2166136261; for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619); return (hash >>> 0).toString(16) }
export default function ChatRichBlock({ kind, children, source: origin, expandable = true, structured = true, input = false }: { kind: 'code' | 'table'; children: ReactNode; source?: { sessionId: string; itemId: string }; expandable?: boolean; structured?: boolean; input?: boolean }) {
  const intermediate = useContext(IntermediateOutputContext)
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [menuOpen, setMenuOpen] = useState(false), [showHtmlSource, setShowHtmlSource] = useState(false), [htmlReset, setHtmlReset] = useState(0)
  const menu = useRef<HTMLSpanElement>(null)
  useChatPreviewPin(menuOpen, menu)
  const [wrap, setWrap] = useState(false)
  const [svgPreview, setSvgPreview] = useState(true)
  const [view, setView] = useState<'data' | 'code'>('data')
  const source = kind === 'code' ? codeSource(children) : null
  const sourceText = source?.text || '', sourceLanguage = source?.language || ''
  const originalTable = useMemo(() => kind === 'table' ? tableCells(children) : null, [kind, children])
  const data = !structured ? null : originalTable?.length && originalTable.length <= 1000 && originalTable[0].length <= 100 && JSON.stringify(originalTable).length <= 200000 ? { kind: 'table' as const, cells: originalTable } : parseStructuredData(sourceText, sourceLanguage)
  const label = kind === 'table' ? 'Table' : source?.language === 'mermaid' ? 'Diagram' : source?.language || 'Code'
  const identity = `${origin?.sessionId || ''}:${origin?.itemId || ''}:${kind}:${fingerprint(nodeText(children))}`
  const content = usePreviewViewport(`inline:${identity}`)
  const cells = () => originalTable?.length ? originalTable : [...(content.current?.querySelectorAll('tr') || [])].map(row => [...row.querySelectorAll('th,td')].map(cell => cell.textContent || ''))
  const copy = () => {
    const value = source?.text ?? cells().map(row => row.join('\t')).join('\n')
    void navigator.clipboard.writeText(value).then(() => setNotice('Copied'), () => setNotice('Copy unavailable'))
  }
  const download = () => {
    const svg = source?.language === 'mermaid' ? content.current?.querySelector('[data-streamdown="mermaid"] svg') : null
    if (svg) downloadPreview(new XMLSerializer().serializeToString(svg), 'diagram.svg', 'image/svg+xml')
    else if (source) downloadPreview(source.text, source.language === 'mermaid' ? 'diagram.mmd' : `code.${({ typescript: 'ts', javascript: 'js', python: 'py', html: 'html', json: 'json', svg: 'svg', csv: 'csv', tsv: 'tsv', css: 'css', bash: 'sh' } as Record<string, string>)[source.language] || 'txt'}`)
    else downloadPreview(tableCsv(cells()), 'table.csv', 'text/csv;charset=utf-8')
  }
  const open = (bundle = false) => { setError(''); setNotice(''); if (origin) void api(`/sessions/${origin.sessionId}/previewblock`, { kind, bundle, itemId: origin.itemId, ...(source ? { text: source.text, language: source.language } : { cells: cells() }) }).then(() => setNotice('Opened in Workspace'), cause => setError(cause.message)) }
  const interactive = !input && source && /^(html|htm)$/i.test(source.language) && /<(?:html|body|input|button|div|section|main|article|h[1-6]|p|table|ul|ol|img|form|svg|canvas)\b/i.test(source.text)
  const controls = <><button type="button" aria-label={`Copy ${kind}`} title={`Copy ${kind}`} onClick={copy}><Icon name="files" size={15} /></button>{!input && !intermediate && origin && <button type="button" className="chat-rich-open" aria-label={`Open ${kind} in Workspace`} title="Open in Workspace" onClick={() => open()}><Icon name="external" size={14} /><span>Open</span></button>}{!input && (!intermediate || source?.language !== 'mermaid') && <span ref={menu}><AnchoredMenu label="Output options" placement="below" menuOwner="rich-output" onOpenChange={setMenuOpen}>{close => <div className="conversation-actions" onClick={event => { if ((event.target as HTMLElement).closest('button')) { close(); focusChatPreviewSource(menu.current?.querySelector('button') || null) } }}>
    {!intermediate && <button type="button" aria-label={`Download ${kind}`} onClick={download}><Icon name="download" size={14} />Download</button>}
    {source && source.language !== 'mermaid' && <button type="button" aria-label="Wrap code lines" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>Wrap code lines</button>}
    {data && <><button type="button" aria-pressed={view === 'data'} onClick={() => setView('data')}>Data</button><button type="button" aria-pressed={view === 'code'} onClick={() => setView('code')}>{kind === 'table' ? 'Original table' : 'Code'}</button></>}
    {structured && source?.language === 'svg' && <><button type="button" aria-pressed={svgPreview} onClick={() => setSvgPreview(true)}>SVG preview</button><button type="button" aria-pressed={!svgPreview} onClick={() => setSvgPreview(false)}>SVG source</button></>}
    {interactive && origin && <><button type="button" aria-label="View HTML source" aria-pressed={showHtmlSource} onClick={() => setShowHtmlSource(value => !value)}>View HTML source</button><button type="button" onClick={() => setHtmlReset(value => value + 1)}>Reset HTML preview</button>{!intermediate && <button type="button" onClick={() => open(true)}>Include local assets</button>}</>}
  </div>}</AnchoredMenu></span>}</>
  const lines = source?.text ? source.text.split('\n').length : 0
  const caption = interactive ? 'HTML preview' : source?.language === 'svg' ? 'SVG' : label
  const metadata = interactive ? 'Interactive document' : data?.kind === 'table' ? `${data.cells.length - 1} rows · ${data.cells[0].length} columns` : data?.kind === 'json' ? '' : source && lines ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : ''
  return <div onPointerDownCapture={event => event.currentTarget.closest('.graphical-messages')?.dispatchEvent(new CustomEvent('graphical-content-interaction', { detail: { held: true } }))} className={`chat-rich-block ${kind === 'code' ? 'graphical-code' : 'chat-rich-table'}${wrap ? ' is-wrapped' : ''}${data?.kind === 'table' && view === 'data' ? ' chat-rich-table' : ''}`}><header><span className="chat-rich-caption" title={metadata}><strong>{caption}</strong>{!interactive && <small>{metadata}</small>}</span><div>{notice && <span className="chat-inline-feedback" role="status" title={notice}>{notice === 'Copied' ? 'Copied' : notice === 'Opened in Workspace' ? 'Opened' : notice}</span>}{controls}</div></header>{error && <p className="chat-preview-error" role="alert">{error}</p>}{interactive && origin ? <><div hidden={showHtmlSource}><InlineHtml key={htmlReset} source={origin} text={source.text} language={source.language} /></div>{showHtmlSource && <div ref={content} className="chat-rich-content">{children}</div>}</> : <div ref={content} className="chat-rich-content" tabIndex={0} role="region" aria-label={kind === 'table' || data?.kind === 'table' && view === 'data' ? 'Scrollable table' : data && view === 'data' ? 'Structured JSON' : source?.language === 'mermaid' ? 'Scrollable diagram' : 'Scrollable code'}>{structured && source && (source.language === 'mermaid' || source.language === 'svg' && svgPreview) && (origin || !expandable) ? <DiagramViewport identity={`inline:${identity}`} inline={expandable}>{source.language === 'svg' ? <SvgDocument text={source.text} /> : children}</DiagramViewport> : structured && source?.language === 'svg' && svgPreview ? <SvgDocument text={source.text} /> : data && view === 'data' ? <StructuredData data={data} /> : children}</div>}</div>
}
