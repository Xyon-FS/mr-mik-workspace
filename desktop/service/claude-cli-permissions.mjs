import { ClaudeModelPicker, emptyClaudePrompt } from './claude-model-picker.mjs';

export function claudeCliPermissionMode(screen) {
  const footer = screen.split('\n').slice(-12).join('\n');
  const match = /^\s*[⏵⏸▶▸]+\s*(auto mode|manual mode|accept edits|plan mode|bypass permissions)(?: on)?\b/im.exec(footer);
  return match ? { 'auto mode': 'auto', 'manual mode': 'default', 'accept edits': 'acceptEdits', 'plan mode': 'plan', 'bypass permissions': 'bypassPermissions' }[match[1].toLowerCase()] : null;
}

export class ClaudeCliPermissions extends ClaudeModelPicker {
  constructor(sessions, pickers = []) { super(sessions); this.pickers = pickers; }
  async chooseMode(id, mode) {
    if (!['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(mode)) throw new Error('Unsupported Claude CLI permission mode.');
    const session = this.session(id), process = session.process;
    if (session.nativeControlBusy || this.pickers.some(picker => picker.busy.has(id) || picker.openMenus.has(id))) throw new Error('Close the model/reasoning picker before changing permissions.');
    session.nativeControlBusy = true;
    try {
      await this.requireEmptyPrompt(id, session);
      const original = claudeCliPermissionMode(await this.screen(id));
      if (!original) throw new Error('Claude has not reported its permission mode yet. Wait for the native prompt.');
      let current = original;
      for (let step = 0; step < 6; step++) {
        const state = await this.sessions.read(id, 150);
        if (session.process !== process || session.activity !== 'idle' || !emptyClaudePrompt(state.screen, state.cursor)) throw new Error('Claude changed while applying permissions. Inspect the terminal before continuing.');
        if (current === mode) { session.claudePermissionMode = mode; session.bypass = mode === 'bypassPermissions'; this.sessions.changed(session); await this.sessions.persist(); return { permissionMode: mode }; }
        this.sessions.input(id, '\x1b[Z');
        const previous = current;
        current = await this.until(id, screen => { const value = claudeCliPermissionMode(screen); return value && value !== previous ? value : null; });
        if (!current) throw new Error('Claude did not confirm a new permission mode. Inspect the terminal before continuing.');
        if (current === original && current !== mode) throw new Error('This Claude CLI does not offer the selected mode. Its original mode was restored.');
      }
      throw new Error('Claude did not reach the selected mode. Inspect the terminal before continuing.');
    } finally { session.nativeControlBusy = false; }
  }
}
