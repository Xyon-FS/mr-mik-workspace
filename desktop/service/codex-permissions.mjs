export const codexPermissionModes = ['native', 'full-access', 'bypass'];

export function codexPermissionMode(value, bypass = false) {
  if (value == null) return bypass ? 'bypass' : 'native';
  if (!codexPermissionModes.includes(value)) throw new Error('Invalid Codex permission mode.');
  return value;
}
