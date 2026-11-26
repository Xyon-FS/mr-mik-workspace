import { useEffect, useId, useRef, useState } from 'react'
import type { MermaidConfig } from '@streamdown/mermaid'
import MermaidError from './MermaidError'

const config: MermaidConfig = {
  securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true, theme: 'base', htmlLabels: false,
  themeVariables: {
    darkMode: true, background: '#171b27', primaryColor: '#253d65', primaryTextColor: '#f0f5ff',
    primaryBorderColor: '#83a9ee', secondaryColor: '#235346', tertiaryColor: '#583758',
    lineColor: '#b2c7eb', textColor: '#e7eefb', edgeLabelBackground: '#29354d',
    clusterBkg: '#24304a', clusterBorder: '#829bc7', actorBkg: '#274d61',
    noteBkgColor: '#5c4520', noteTextColor: '#fff1ce',
  },
}
const loadRenderer = () => import('@streamdown/mermaid').then(({ mermaid }) => mermaid.getMermaid(config))
let renderer: ReturnType<typeof loadRenderer> | undefined

export default function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId(), root = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<{ chart: string; svg?: string; error?: string }>()
  useEffect(() => {
    const element = root.current
    if (!element) return
    let active = true
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void (renderer ??= loadRenderer()).then(mermaid => mermaid.render(`mr-mik-diagram-${id.replace(/[^\w-]/g, '')}`, chart))
        .then(({ svg }) => { if (active) setResult({ chart, svg }) },
          cause => { if (active) setResult({ chart, error: cause instanceof Error ? cause.message : String(cause) }) })
    }, { rootMargin: '100px' })
    observer.observe(element)
    return () => { active = false; observer.disconnect() }
  }, [chart, id])
  const current = result?.chart === chart ? result : undefined
  return <div ref={root} data-streamdown="mermaid-block">
    {current?.svg ? <div role="img" aria-label="Mermaid diagram" data-streamdown="mermaid" dangerouslySetInnerHTML={{ __html: current.svg }} /> :
      current?.error ? <MermaidError chart={chart} error={current.error} /> : <p className="mermaid-loading" role="status">Loading diagram…</p>}
  </div>
}
