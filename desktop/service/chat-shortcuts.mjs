export const defaultChatShortcuts = Object.freeze({ new: 'Ctrl+Shift+T', search: 'Ctrl+Shift+P', history: 'Ctrl+Shift+H', sidebar: 'Ctrl+B' });
export function shortcutError(value, current, key) {
  if (typeof value !== 'string' || value.length > 64) return 'Invalid shortcut.';
  if (!/^(Ctrl|Alt|Meta)\+/.test(value)) return 'Use Ctrl, Alt or Meta with another key.';
  const parts = value.split('+'), last = parts.pop(), modifiers = ['Ctrl', 'Meta', 'Alt', 'Shift'].filter(part => parts.includes(part));
  if (!last || !/^[A-Za-z0-9]+$/.test(last) || parts.join('+') !== modifiers.join('+') || ['Control', 'Shift', 'Alt', 'Meta'].includes(last)) return 'Choose a valid key combination.';
  if (Object.entries(current).some(([id, chord]) => id !== key && chord === value)) return 'This shortcut is already assigned.';
  if (['Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+Shift+W', 'Ctrl+F', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Alt+F4'].includes(value) || /^Alt\+[1-9]$/.test(value)) return 'This shortcut is reserved for existing chat or editing controls.';
  return '';
}
export function validateChatShortcuts(value) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== 4 || Object.keys(defaultChatShortcuts).some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail('Supply all four chat shortcuts.');
  const result = {};
  for (const key of Object.keys(defaultChatShortcuts)) { const error = shortcutError(value[key], value, key); if (error) fail(error); result[key] = value[key]; }
  return result;
}
