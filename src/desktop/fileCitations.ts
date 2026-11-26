// Transform native public file-source directives after Markdown parsing, so code
// examples and fenced blocks remain literal. File access stays session-scoped.
type Node = { type: string; value?: string; children?: Node[]; url?: string; title?: string; data?: Record<string, unknown> }
export function fileCitations() {
  return (tree: Node) => {
    const visit = (parent: Node) => {
      if (!parent.children || ['code', 'inlineCode', 'link', 'image', 'html'].includes(parent.type)) return
      parent.children = parent.children.flatMap(node => {
        if (node.type !== 'text' || !node.value) { visit(node); return [node] }
        const text = node.value, parts: Node[] = []; let end = 0
        const directive = /:{1,2}codex-file-citation\{([^{}\r\n]{1,8192})\}/g
        for (const match of text.matchAll(directive)) {
          const attribute = /(?:^|\s)path\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/.exec(match[1])
          const path = (attribute?.[1] ?? attribute?.[2] ?? '').replace(/\\([\\"'])/g, '$1')
          if (!path || [...path].some(character => character.charCodeAt(0) < 32) || /^(?![a-z]:[\\/]|file:)[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('\\\\')) continue
          const name = path.replace(/^file:\/{2,3}/i, '').split(/[\\/]/).pop() || path
          if (match.index! > end) parts.push({type:'text',value:text.slice(end,match.index)})
          parts.push({type:'link',url:path,title:path,children:[{type:'text',value:name}],data:{hProperties:{className:['chat-file-citation']}}})
          end = match.index! + match[0].length
        }
        if (!end) return [node]
        if (end < text.length) parts.push({type:'text',value:text.slice(end)})
        return parts
      })
    }
    visit(tree)
  }
}
