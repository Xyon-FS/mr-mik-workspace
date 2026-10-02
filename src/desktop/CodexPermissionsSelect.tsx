import DarkSelect from './DarkSelect'
import type { CodexPermissions } from './types'
import { codexPermissionsOptions } from './codexPermissions'

export default function CodexPermissionsSelect({ value, onChange, disabled = false }: { value: CodexPermissions; onChange: (value: CodexPermissions) => void; disabled?: boolean }) {
  return <DarkSelect label="Codex permissions" value={value} options={codexPermissionsOptions} disabled={disabled} onChange={value => onChange(value as CodexPermissions)} />
}
