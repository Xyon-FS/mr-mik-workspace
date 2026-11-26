import { Children, createContext, memo, useContext, useMemo, useState } from 'react'
import type { ComponentProps, ContextType, ReactNode } from 'react'
import { Block, Streamdown, defaultComponents, defaultRemarkPlugins, useIsCodeFenceIncomplete } from 'streamdown'
import { defaultUrlTransform } from 'react-markdown'
import type { BlockProps, Components } from 'streamdown'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import 'katex/dist/katex.min.css'
import { GraphicalImage } from './GraphicalAssets'
import ChatRichBlock from './ChatRichBlock'
import ChatOutputActions from './ChatOutputActions'
import { ZoomImage } from '../components/ImagePreview'
import AnchoredMenu from './AnchoredMenu'
import './chat-prose.css'
import { fileCitations } from './fileCitations'
import { standaloneHtml } from '../../desktop/service/chat-html-output.mjs'
import { visualizeReference } from '../../desktop/service/chat-visualize.mjs'
import { api } from './client'
import InlineHtml from './InlineHtml'
import { Icon } from './Icons'
import { isDevelopmentFile, splitFileLink } from '../../desktop/service/development-files.mjs'
import { codeFence } from './previewDownloads'
import MermaidDiagram from './MermaidDiagram'
import { skillMentions } from '../../desktop/service/skill-mentions.mjs'
import type { ComposerContext } from '../../desktop/service/graphical-composer.mjs'

function skillText(children: ReactNode, names?: string[]) {
  if (!names?.length) return children
  return Children.map(children, child => {
    if (typeof child !== 'string') return child
    const tokens = skillMentions(child).filter(token => names.includes(token.name))
    if (!tokens.length) return child
    const pieces: ReactNode[] = []; let end = 0
    for (const token of tokens) { pieces.push(child.slice(end, token.start), <strong className="chat-skill-mention" key={token.start}>{child.slice(token.start, token.end)}</strong>); end = token.end }
    pieces.push(child.slice(end)); return pieces
  })
}

function highlight(children: ReactNode, query: string) {
  if (!query.trim()) return children
  return Children.map(children, child => {
    if (typeof child !== 'string') return child
    const pieces: ReactNode[] = []; let start = 0, position = child.toLowerCase().indexOf(query.toLowerCase())
    while (position >= 0) { pieces.push(child.slice(start, position), <mark key={position}>{child.slice(position, position + query.length)}</mark>); start = position + query.length; position = child.toLowerCase().indexOf(query.toLowerCase(), start) }
    pieces.push(child.slice(start)); return pieces
  })
}
const localLink = (url: string) => /^file:/i.test(url) || /^[a-z]:[\\/]/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('#') && !url.startsWith('//')
const plugins = { code, math }
const controls = { code: false, table: false, image: false }
const codeTheme: ['github-dark', 'github-dark'] = ['github-dark', 'github-dark']
const SearchQuery = createContext('')
const VisualizeSource = createContext<{ sessionId: string; itemId: string } | null>(null)
function VisualizeBlock(props: BlockProps) {
  const source = useContext(VisualizeSource)
  const reference = source && visualizeReference(props.content)
  return source && reference ? <VisualizePreview source={source} reference={reference} /> : <Block {...props} />
}
function VisualizePreview({ source, reference }: { source: NonNullable<ContextType<typeof VisualizeSource>>; reference: NonNullable<ReturnType<typeof visualizeReference>> }) {
  const [error, setError] = useState('')
  const name = reference.title || reference.path.split(/[\\/]/).pop() || 'HTML preview'
  return <section className={`chat-rich-block${reference.wide ? ' chat-visualize-wide' : ''}`} aria-label={name}>
    <header><span className="chat-rich-caption"><strong>{name}</strong></span><div>
      <button type="button" className="chat-rich-open" onClick={() => {
        setError('')
        void api(`/sessions/${source.sessionId}/previewblock`, { kind: 'visualize', itemId: source.itemId, visualizePath: reference.path }).catch(cause => setError(cause.message))
      }}><Icon name="external" size={14} />Open in Workspace</button>
    </div></header>
    {error && <p role="alert" className="chat-preview-error">{error}</p>}
    <InlineHtml source={source} visualizePath={reference.path} />
  </section>
}
function Highlight({ children }: { children: ReactNode }) {
  return highlight(children, useContext(SearchQuery))
}
function ChatCode({ origin, streaming, ...props }: ComponentProps<typeof defaultComponents.code> & { origin: 'input' | 'output'; streaming: boolean }) {
  const query = useContext(SearchQuery)
  const incomplete = useIsCodeFenceIncomplete()
  if (!props['data-block' as keyof typeof props]) return <code>{highlight(props.children, query)}</code>
  if (/\blanguage-mermaid\b/.test(props.className || '') && typeof props.children === 'string') {
    return origin === 'input' || streaming && incomplete ? <pre><code>{highlight(props.children, query)}</code></pre> : <MermaidDiagram chart={props.children} />
  }
  return query.trim() ? <pre><code>{highlight(props.children, query)}</code></pre> : <defaultComponents.code {...props} />
}
// Keep raw HTML disabled, as in the previous renderer. Local files continue to
// go through the session's scoped file/media routes rather than browser URLs.
const rehypePlugins: [] = []
const remarkPlugins = [...Object.values(defaultRemarkPlugins), fileCitations]
function ChatMarkdown({ text, query, openLocal, sessionId, itemId, streaming = false, workspacePreview = false, skillContext, origin = 'output' }: { text: string; query: string; openLocal: (href: string, destination?: 'ide') => void; sessionId: string; itemId?: string; streaming?: boolean; workspacePreview?: boolean; skillContext?: ComposerContext[]; origin?: 'input' | 'output' }) {
  const skillNames = useMemo(() => skillContext?.filter(item => item.type === 'skill').map(item => item.name), [skillContext])
  const html = !streaming && !workspacePreview ? standaloneHtml(text) : null
  // Escape invocation dollars for Markdown only: multiple skills must not be
  // misread as a pair of inline-math delimiters. Native/copy text is unchanged.
  const mentionTokens = skillNames?.length ? skillMentions(text).filter(token => skillNames.includes(token.name)) : []
  let escaped = text
  for (const token of [...mentionTokens].reverse()) escaped = escaped.slice(0, token.start) + '\\' + escaped.slice(token.start)
  const renderedText = html ? codeFence(html, 'html') : escaped
  const components = useMemo<Components>(() => ({
    a: ({ href, children, title, className }) => {
      const label = <Highlight>{children}</Highlight>
      if (!href) return <span>{label}</span>
      const local = localLink(href), { file } = splitFileLink(href)
      return <span className="chat-output-link">
        {local && itemId && isDevelopmentFile(file) ? <AnchoredMenu label={`Open ${file.split(/[\\/]/).pop()}`} title={title} placement="below" className={`chat-code-file ${className || ''}`} triggerContent={label}>{close => <div className="conversation-actions">
          <button type="button" onClick={() => { close(); openLocal(href) }}>Preview in Workspace</button>
          <button type="button" onClick={() => { close(); openLocal(href, 'ide') }}>Open in IDE</button>
        </div>}</AnchoredMenu> : <a href={href} title={title} className={className} target={local ? undefined : '_blank'} rel="noreferrer" onClick={event => { if (local) { event.preventDefault(); openLocal(href) } }}>{label}</a>}
        {origin === 'output' && !className?.includes('chat-file-citation') && itemId && !streaming && local && /\.(md|markdown|html?|pdf|png|jpe?g|gif|webp|svg|txt|csv|json)$/i.test(file) && <ChatOutputActions compact sessionId={sessionId} reference={{ itemId, href }} />}
      </span>
    },
    img: ({ src, alt }) => typeof src === 'string' && localLink(src) ? <GraphicalImage input={origin === 'input'} inline id={sessionId} itemId={itemId || 'markdown'} href={src} label={alt} /> : <ZoomImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
    p: ({ children }) => <p><Highlight>{skillText(children, skillNames)}</Highlight></p>, li: ({ children }) => <li><Highlight>{skillText(children, skillNames)}</Highlight></li>,
    strong: ({ children }) => <strong><Highlight>{children}</Highlight></strong>, em: ({ children }) => <em><Highlight>{children}</Highlight></em>,
    h1: ({ children }) => <h1><Highlight>{children}</Highlight></h1>, h2: ({ children }) => <h2><Highlight>{children}</Highlight></h2>, h3: ({ children }) => <h3><Highlight>{children}</Highlight></h3>,
    td: ({ children }) => <td><Highlight>{children}</Highlight></td>, th: ({ children }) => <th><Highlight>{children}</Highlight></th>,
    code: props => <ChatCode {...props} origin={origin} streaming={streaming} />,
    pre: ({ children }) => <ChatRichBlock input={origin === 'input'} structured={!streaming && origin === 'output'} expandable={!workspacePreview} kind="code" source={itemId && !streaming ? { sessionId, itemId } : undefined}><defaultComponents.pre>{children}</defaultComponents.pre></ChatRichBlock>,
    table: ({ children }) => <ChatRichBlock input={origin === 'input'} structured={!streaming && origin === 'output'} expandable={!workspacePreview} kind="table" source={itemId && !streaming ? { sessionId, itemId } : undefined}><table>{children}</table></ChatRichBlock>,
  }), [openLocal, sessionId, itemId, streaming, workspacePreview, skillNames, origin])
  const visualize = itemId && origin === 'output' && !streaming && !workspacePreview && text.includes('\uE200visualize\uE202') ? { sessionId, itemId } : null
  return <VisualizeSource.Provider value={visualize}><SearchQuery.Provider value={query}><Streamdown className="chat-prose" mode="streaming" isAnimating={streaming} parseIncompleteMarkdown={streaming} BlockComponent={visualize ? VisualizeBlock : Block} skipHtml remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} plugins={plugins} shikiTheme={codeTheme} controls={controls} lineNumbers={false} components={components} urlTransform={url => localLink(url) ? url : defaultUrlTransform(url)}>{renderedText}</Streamdown></SearchQuery.Provider></VisualizeSource.Provider>
}

// A streamed item changes every update; completed visible neighbors do not.
// Compare all props normally, including action callbacks and search queries.
export default memo(ChatMarkdown)
