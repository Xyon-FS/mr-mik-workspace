import { CodexModelPicker } from './model-picker.mjs';

// Ink's bordered dialogs retain their frame in the xterm screen projection.
const dialogLines = screen => screen.split('\n').map(line => line.replace(/^\s*[│┃] ?/, '').replace(/\s*[│┃]\s*$/, '').trimEnd());
export const emptyClaudePrompt = (screen, cursor) => {
  const prompt = dialogLines(screen).findLast(line => /^\s*❯/.test(line));
  if (prompt == null) return false;
  if (/^\s*❯\s*$/.test(prompt)) return true;
  // Native ghost hints are visible text, but leave the cursor at the start of
  // the composer. Never treat an actual typed draft as a hint.
  const marker = cursor?.line?.indexOf('❯');
  return marker >= 0 && cursor.x === marker + 2 && dialogLines(cursor.line)[0] === prompt && /^\s*❯\s+Try ["“].+["”]\s*$/.test(prompt);
};
const modelNotice = screen => {
  const lines = dialogLines(screen).slice(-70);
  const index = lines.findLastIndex(line => /(?:Set model to|Switched (?:model )?to|Model changed to|Kept model as)/i.test(line));
  return index < 0 ? null : { index, text: lines[index].trim() };
};
const effortNotice = screen => {
  const pattern = /(?:effort[^\n]{0,60}\b(low|medium|high|xhigh|max)\b|\b(low|medium|high|xhigh|max)\b[^\n]{0,30}effort)/i;
  const latest = dialogLines(screen).slice(-70).map(line => pattern.exec(line)).filter(Boolean).at(-1);
  return (latest?.[1] || latest?.[2])?.toLowerCase();
};
function modelDialog(screen) {
  const lines = dialogLines(screen).slice(-150);
  const start = lines.findLastIndex(line => /^\s*(?:Select|Choose) (?:a )?model\s*$/i.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /\benter\b/i.test(line) && /enter\s+(?:to\s+)?(?:confirm|select|set as default)/i.test(lines.slice(index, index + 3).join(' ').replace(/\s+/g, ' ')) && /\besc(?:ape)?\b/i.test(lines.slice(index, index + 3).join(' ')));
  // Narrow full-screen terminals wrap descriptions into many lines. Require
  // the same explicit header/footer and unique rows, without a 30-line cap.
  if (end < 0 || end - start > 120) return null;
  const footer = lines.slice(end, end + 3).join(' ').replace(/\s+/g, ' ');
  const sessionOnly = /\bs\s+(?:to\s+)?(?:use\s+)?(?:for\s+)?(?:this\s+)?session(?:\s+only)?\b/i.test(footer);
  // Recent Claude menus persist Enter as the default for other chats. Never
  // confirm one unless its explicit session-only shortcut is available.
  if (/set as default/i.test(footer) && !sessionOnly) return null;
  const body = lines.slice(start + 1, end);
  const numbered = body.some(line => /^\s*[❯›>]?\s*[1-9]\d?\.\s+/.test(line));
  const rows = body.map(line => numbered
    ? /^\s*([❯›>])?\s*([1-9]\d?)\.\s+(.+)$/.exec(line)
    : /^\s*([❯›>])?\s*()((?:Default|Sonnet|Opus|Haiku|claude-[a-z0-9.-]+)\b[^\r\n]*)/i.exec(line)).filter(Boolean);
  const options = rows.map((match, index) => {
    const [title, ...description] = match[3].trim().split(/\s{2,}/);
    return { key: match[2] || String(index + 1), label: title.replace(/\s*[✔✓]\s*$/, '').trim(), ...(description.length ? { description: description.join(' ') } : {}), slug: match[2] || String(index + 1), current: /\b(?:current|selected)\b|[✔✓]/i.test(title), active: !!match[1] };
  });
  if (options.some(item => !item.label || item.label.length > 200)) return null;
  return options.length > 1 && options.filter(item => item.active).length === 1 && new Set(options.map(item => item.key)).size === options.length ? { options, confirmKey: sessionOnly ? 's' : '\r' } : null;
}
export function parseClaudeModelPicker(screen) { return modelDialog(screen)?.options || null; }

export class ClaudeModelPicker extends CodexModelPicker {
  async screen(id) { return (await this.sessions.read(id, 150)).screen; }
  async requireEmptyPrompt(id, session) {
    const deadline = Date.now() + 1500;
    do {
      if (session.activity !== 'idle') break;
      const state = await this.sessions.read(id, 150);
      if (emptyClaudePrompt(state.screen, state.cursor)) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    } while (Date.now() < deadline);
    throw new Error('Wait for an idle, empty Claude prompt. Otherwise use /model directly in the terminal.');
  }
  session(id) {
    const session = this.sessions.get(id);
    if (session.nativeControlBusy) throw new Error('Wait for the native permission control to finish.');
    if (session.agent !== 'claude' || session.status !== 'running' || !session.process) throw new Error('Open a running Claude chat to change its model.');
    return session;
  }
  async open(id) {
    if (this.busy.has(id)) throw new Error('Model picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), process = session.process;
      const screen = await this.screen(id);
      let options = parseClaudeModelPicker(screen);
      if (!options) {
        await this.requireEmptyPrompt(id, session);
        if (session.process !== process) throw new Error('Claude restarted while preparing the picker. Open it again.');
        this.sessions.input(id, '/model');
        const ready = await this.until(id, value => dialogLines(value).some(line => /^\s*❯\s*\/model\s*$/.test(line)) ? true : null, 1500);
        if (!ready || session.process !== process) throw new Error('Claude did not accept /model. Continue in the terminal.');
        this.sessions.input(id, '\r');
        options = await this.until(id, parseClaudeModelPicker);
      }
      if (!options || session.process !== process) throw new Error('This Claude picker layout is not recognized. Select the model in the native terminal; the chat is not restarted.');
      const dialog = modelDialog(await this.screen(id));
      if (!dialog || JSON.stringify(dialog.options) !== JSON.stringify(options)) throw new Error('Claude picker changed. Reopen it or use the terminal.');
      this.openMenus.set(id, { process, options, confirmKey: dialog.confirmKey });
      return { options };
    } finally { this.busy.delete(id); }
  }
  async choose(id, slug) {
    if (this.busy.has(id)) throw new Error('Model picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), menu = this.openMenus.get(id);
      const dialog = modelDialog(await this.screen(id)), options = dialog?.options;
      if (!menu || menu.process !== session.process || !options || dialog.confirmKey !== menu.confirmKey || options.some((item, index) => item.label !== menu.options[index]?.label) || options.length !== menu.options.length) throw new Error('Claude picker changed. Reopen it or use the terminal.');
      const index = options.findIndex(item => item.slug === slug), active = options.findIndex(item => item.active);
      if (index < 0) throw new Error('Choose an option from the current Claude picker.');
      this.openMenus.delete(id);
      for (let step = 0; step < Math.abs(index - active); step++) this.sessions.input(id, index > active ? '\x1b[B' : '\x1b[A');
      // Verify the highlighted entry before accepting it; never guess from an old screen.
      const selected = await this.until(id, value => {
        const current = modelDialog(value), rows = current?.options;
        return current?.confirmKey === dialog.confirmKey && rows?.length === options.length && rows.every((row, index) => row.label === options[index].label && row.key === options[index].key) && rows.find(item => item.active)?.slug === slug ? true : null;
      });
      if (!selected || session.process !== menu.process) throw new Error('Claude did not highlight the expected option. Finish in the terminal.');
      const previousNotice = modelNotice(await this.screen(id));
      this.sessions.input(id, dialog.confirmKey);
      const confirmed = await this.until(id, value => {
        if (parseClaudeModelPicker(value)) return null;
        const notice = modelNotice(value);
        // The full-screen TUI leaves confirmation above a large blank area.
        // Read that notice, but do not reuse an unchanged prior selection.
        return notice && (options[index].current || !previousNotice || notice.index !== previousNotice.index || notice.text !== previousNotice.text) ? true : null;
      });
      if (!confirmed) throw new Error('Selection sent; check the native Claude confirmation before continuing.');
      session.cliModelLabel = options[index].label;
      this.sessions.changed?.(session);
      await this.sessions.persist?.();
      return { confirmed: true };
    } finally { this.busy.delete(id); }
  }
  async cancel(id) {
    const menu = this.openMenus.get(id); this.openMenus.delete(id);
    if (menu && this.session(id).process === menu.process && parseClaudeModelPicker(await this.screen(id))) this.sessions.input(id, '\x1b');
    return { cancelled: true };
  }
}

// Fail closed on unfamiliar layouts: never send navigation keys to an unknown prompt.
export function parseClaudeEffortPicker(screen) {
  const lines = dialogLines(screen).slice(-150);
  const start = lines.findLastIndex(line => /^\s*(?:Select |Adjust )?(?:reasoning )?effort(?: level)?\s*$/i.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /\bs(?:\s|$)/i.test(line) && /\bs\s+(?:use )?(?:for )?(?:this )?session(?: only)?\b/i.test(lines.slice(i, i + 3).join(' ').replace(/\s+/g, ' ')) && /esc|escape/i.test(lines.slice(i, i + 3).join(' ')));
  if (end < 0) return null;
  const body = lines.slice(start + 1, end);
  const track = body.find(line => line.includes('▲') && /─/.test(line));
  // Ultracode is a separate Tab toggle beside the current native slider.
  const labels = body.map(line => line.replace(/\s{2,}Tab to toggle\s*$/i, '')).find(line => /^\s*low\s+medium(?:\s+high)?(?:\s+xhigh)?(?:\s+max)?(?:\s+ultracode)?\s*$/i.test(line));
  if (track && labels) {
    const triangle = track.indexOf('▲');
    const rows = [...labels.matchAll(/\b(low|medium|high|xhigh|max|ultracode)\b/gi)].map(match => ({ label: match[1], slug: match[1].toLowerCase(), active: triangle >= match.index - 1 && triangle < match.index + match[1].length + 1 }));
    if (rows.filter(row => row.active).length !== 1 || rows.find(row => row.active)?.slug === 'ultracode') return null;
    return rows.filter(row => row.slug !== 'ultracode').map(row => ({ ...row, current: row.active }));
  }
  const options = lines.slice(start + 1, end).map(line => /^\s*([❯›>])?\s*(?:[1-9]\.\s*)?(Low|Medium|High|Extra high|Xhigh|Max)(?:\s+.*)?$/i.exec(line)).filter(Boolean).map(match => ({ label: match[2], slug: match[2].toLowerCase().replace('extra high', 'xhigh'), active: !!match[1], current: !!match[1] }));
  return options.length > 1 && options.filter(item => item.active).length === 1 && new Set(options.map(item => item.slug)).size === options.length ? options : null;
}
export class ClaudeEffortPicker extends ClaudeModelPicker {
  async openEffort(id) {
    if (this.busy.has(id)) throw new Error('Reasoning picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), process = session.process;
      let options = parseClaudeEffortPicker(await this.screen(id));
      if (!options) {
        await this.requireEmptyPrompt(id, session);
        if (session.process !== process) throw new Error('Claude restarted while preparing the picker. Open it again.');
        this.sessions.input(id, '/effort');
        if (!await this.until(id, screen => dialogLines(screen).some(line => /^\s*❯\s*\/effort\s*$/.test(line)) ? true : null, 1500) || session.process !== process) throw new Error('Claude did not accept /effort. Continue in the terminal.');
        this.sessions.input(id, '\r'); options = await this.until(id, parseClaudeEffortPicker);
      }
      if (!options || session.process !== process) throw new Error('Claude effort slider layout is not recognized. Use its native slider in the terminal; confirm with s for this session only.');
      this.openMenus.set(id, { process, options }); return { options };
    } finally { this.busy.delete(id); }
  }
  async chooseEffort(id, effort) {
    if (this.busy.has(id)) throw new Error('Reasoning picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), menu = this.openMenus.get(id), rows = parseClaudeEffortPicker(await this.screen(id));
      if (!menu || session.process !== menu.process || !rows || rows.length !== menu.options.length || rows.some((row, i) => row.slug !== menu.options[i].slug)) throw new Error('Claude effort choices changed. Continue in the terminal.');
      const target = rows.findIndex(item => item.slug === effort), current = rows.findIndex(item => item.active);
      if (target < 0) throw new Error('Choose a native reasoning option.');
      for (let step = 0; step < Math.abs(target - current); step++) this.sessions.input(id, target > current ? '\x1b[C' : '\x1b[D');
      if (!await this.until(id, screen => { const current = parseClaudeEffortPicker(screen); return current?.length === rows.length && current.every((row, index) => row.slug === rows[index].slug && row.label === rows[index].label) && current.find(item => item.active)?.slug === effort ? true : null; }) || session.process !== menu.process) throw new Error('Claude did not highlight the selected effort. Continue in the terminal.');
      this.openMenus.delete(id); this.sessions.input(id, 's');
      const confirmed = await this.until(id, screen => !parseClaudeEffortPicker(screen) && effortNotice(screen) === effort ? true : null);
      if (!confirmed || session.process !== menu.process) throw new Error('Selection sent, but not confirmed. Check Claude before continuing.');
      session.effort = effort; this.sessions.changed?.(session); await this.sessions.persist?.(); return { confirmed: true, effort };
    } finally { this.busy.delete(id); }
  }
  async cancelEffort(id) {
    const menu = this.openMenus.get(id); this.openMenus.delete(id);
    if (menu && this.session(id).process === menu.process && parseClaudeEffortPicker(await this.screen(id))) this.sessions.input(id, '\x1b');
    return { cancelled: true };
  }
}
