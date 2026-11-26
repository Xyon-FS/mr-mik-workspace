export const codexPermissionModes = ['native', 'full-access', 'ask', 'auto-review', 'bypass'];

export function codexPermissionMode(value, bypass = false) {
  if (value == null) return bypass ? 'bypass' : 'ask';
  // Retain recorded legacy boundaries. Already-saved ask/auto-review choices
  // have no reliable legacy provenance and must not be silently widened.
  if (!codexPermissionModes.includes(value)) throw new Error('Invalid Codex permission mode.');
  return value;
}
