import ChatMarkdown from './ChatMarkdown'
import { api, reportError } from './client'
import ChatRichBlock from './ChatRichBlock'
import { codeFence } from './previewDownloads'
import type { Preview } from './types'
import DiagramViewport from './DiagramViewport'
import SvgDocument from './SvgDocument'
import InteractiveDocument from './InteractiveDocument'

export default function RichPreview({ file }: { file: Preview }) {
  if (file.interactiveUrl) return <InteractiveDocument file={file} />
  const content = file.language === 'svg' ? <SvgDocument text={file.text || ''} /> : file.blockKind === 'table' ? <ChatRichBlock expandable={false} kind="table"><table><thead><tr>{file.cells?.[0]?.map((value, index) => <th key={index}>{value}</th>)}</tr></thead><tbody>{file.cells?.slice(1).map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody></table></ChatRichBlock> : <ChatMarkdown workspacePreview sessionId={file.source?.sessionId || ''} itemId={file.language === 'markdown' ? file.source?.itemId : undefined} query="" openLocal={(href, destination) => { if (file.source) void api(`/sessions/${file.source.sessionId}/chat`, { action: 'open-file', href, destination }).catch(reportError) }} text={file.language === 'markdown' ? file.text || '' : codeFence(file.text || '', file.language)} />
  return <section className="workspace-rich-preview" aria-label={file.name}>{file.language === 'svg' ? <DiagramViewport identity={file.identity || file.path}>{content}</DiagramViewport> : content}</section>
}
