import type { MermaidErrorComponentProps } from 'streamdown'

export default function MermaidError({ chart, error }: Pick<MermaidErrorComponentProps, 'chart' | 'error'>) {
  const line = /(?:parse error on line|line)\s+(\d+)/i.exec(error)?.[1]
  // Sequence diagrams treat literal semicolons as statement delimiters. Explain
  // the likely cause, but never rewrite generated source or invent a diagram.
  const semicolon = /^\s*sequenceDiagram\b/.test(chart) && /^[^\n]*:[^\n]*;/m.test(chart)
  return <section className="chat-mermaid-error" role="region" aria-label="Diagram error">
    <strong>Diagram could not be rendered{line ? ` · line ${line}` : ''}</strong>
    <p>{semicolon ? <>In sequence-diagram labels, use <code>#59;</code> for a literal semicolon and <code>&lt;br/&gt;</code> for a line break.</> : 'Check the Mermaid syntax. The original source is available below.'}</p>
    <details><summary>Diagram source</summary><pre tabIndex={0}><code>{chart}</code></pre></details>
    <details><summary>Technical details</summary><pre tabIndex={0}>{error}</pre></details>
  </section>
}
