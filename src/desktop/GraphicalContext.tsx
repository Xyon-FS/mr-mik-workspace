import type { ReactNode } from 'react'

export default function GraphicalContext({ used, capacity, children }: { used?: number | null; capacity?: number | null; children?: ReactNode }) {
  const percent = used != null && capacity ? Math.round(used / capacity * 100) : null
  const bounded = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  return <section className="graphical-usage graphical-menu-section" aria-label="Context">
    <header className="graphical-info-heading"><strong>Context</strong><span className="graphical-context-value">{percent == null ? 'Not measured yet' : `${percent}%`}</span></header>
    {percent == null ? <div className="graphical-context-meter" aria-hidden="true" /> : <div className="graphical-context-meter" role="meter" aria-label="Reported context usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bounded}><span style={{ width: `${bounded}%` }} /></div>}
    <p className="graphical-info-note" title="Native context estimate; excludes your unsent draft">{used != null && capacity ? `${used.toLocaleString()} / ${capacity.toLocaleString()} tokens` : 'Waiting for native context usage.'}</p>
    <div className="graphical-context-summary">{children}</div>
  </section>
}
