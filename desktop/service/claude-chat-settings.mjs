export const claudeEffortNames = ['low', 'medium', 'high', 'xhigh', 'max'];
export const claudePermissionChoices = [
  { value: 'default', label: 'Ask', description: 'Use native permission rules and ask when needed.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Accept edits within native working directories; other native rules still apply.' },
  { value: 'plan', label: 'Plan', description: 'Explore and plan using Claude’s native Plan restrictions.' },
  { value: 'dontAsk', label: 'Deny unapproved actions', description: 'Deny actions that would require approval.' },
];
export const knownClaudePermissionModes = [...claudePermissionChoices.map(item => item.value), 'auto', 'bypassPermissions'];
export function claudePermissionOptions(allowBypass) {
  return [...claudePermissionChoices, ...(allowBypass ? [{ value: 'bypassPermissions', label: 'Bypass permissions', description: 'Available because bypass was explicitly enabled for this chat at launch.' }] : [])];
}
export function claudeModelChoices(initialization) {
  const models = initialization?.models;
  return Array.isArray(models) ? models.filter(item => typeof item.value === 'string' && typeof item.displayName === 'string').slice(0, 100).map(item => ({
    value: item.value, label: item.displayName,
    efforts: item.supportsEffort === true && Array.isArray(item.supportedEffortLevels) ? [...new Set(item.supportedEffortLevels.filter(level => claudeEffortNames.includes(level)))] : [],
  })) : [];
}
