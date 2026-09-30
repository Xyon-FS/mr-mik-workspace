import DarkSelect from './DarkSelect'
import type { ReasoningEffort } from './types'

const labels: Record<ReasoningEffort, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
export default function ReasoningSelect({ label, value, efforts, disabled, onChange, compact = false }: { label: string; value: ReasoningEffort; efforts?: ReasoningEffort[]; disabled?: boolean; onChange: (value: ReasoningEffort) => void; compact?: boolean }) {
  const options = (efforts || []).map(value => ({ value, label: labels[value] || value }))
  if (!options.some(item => item.value === value)) options.unshift({ value, label: `${labels[value] || value}${efforts ? ' · unavailable for this model' : ' · loading…'}` })
  return <DarkSelect label={label} value={value} options={options.map(item => ({ ...item, disabled: !efforts?.includes(item.value) }))} disabled={disabled || !efforts?.length} onChange={value => onChange(value as ReasoningEffort)} compact={compact} />
}
