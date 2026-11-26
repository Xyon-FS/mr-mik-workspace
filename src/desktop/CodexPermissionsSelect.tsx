import DarkSelect from './DarkSelect'
import type { CodexPermissions } from './types'
import { codexPermissionsOptions } from './codexPermissions'

export default function CodexPermissionsSelect({ value, onChange, disabled = false, compact = false, icon = 'projects', appearance }: { value: CodexPermissions; onChange: (value: CodexPermissions) => void; disabled?: boolean; compact?: boolean; icon?: string; appearance?: 'workspace' }) {
  return <DarkSelect appearance={appearance} variant={compact ? 'permissions' : undefined} label="Codex permissions" compact={compact} icon={icon} placeholder={value === 'native' ? 'Choose permissions' : undefined} value={value} options={codexPermissionsOptions} disabled={disabled} onChange={value => onChange(value as CodexPermissions)} />
}
