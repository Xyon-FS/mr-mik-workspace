import { CodexModelPicker } from './model-picker.mjs';

export function parseClaudeModelPicker(screen) {
  const lines = screen.split('\n').slice(-45);
  const start = lines.findLastIndex(line => /^\s*(?:Select|Choose) (?:a )?model\s*$/i.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /(?:enter to (?:confirm|select)|enter (?:confirm|select)).*(?:esc|escape)/i.test(line));
  if (end < 0 || end - start > 30) return null;
  const options = lines.slice(start + 1, end).map(line => /^\s*([❯›>])?\s*([1-9])\.\s+((?:Default|Sonnet|Opus|Haiku|claude-[a-z0-9.-]+)[^\r\n]*)/i.exec(line)).filter(Boolean).map(match => ({ key: match[2], label: match[3].trim(), slug: match[2], current: /\b(?:current|selected)\b/i.test(match[3]), active: !!match[1] }));
  return options.length > 1 && options.filter(item => item.active).length === 1 && new Set(options.map(item => item.key)).size === options.length ? options : null;
}

export class ClaudeModelPicker extends CodexModelPicker {
  session(id) {
    const session = this.sessions.get(id);
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
        const prompt = screen.split('\n').slice(-15).filter(line => /^\s*❯/.test(line)).at(-1) || '';
        if (session.activity !== 'idle' || !/^\s*❯\s*$/.test(prompt)) throw new Error('Wait for an idle, empty Claude prompt. Otherwise use /model directly in the terminal.');
        this.sessions.input(id, '/model');
        const ready = await this.until(id, value => /^\s*❯\s*\/model\s*$/m.test(value) ? true : null, 1500);
        if (!ready || session.process !== process) throw new Error('Claude did not accept /model. Continue in the terminal.');
        this.sessions.input(id, '\r');
        options = await this.until(id, parseClaudeModelPicker);
      }
      if (!options || session.process !== process) throw new Error('This Claude picker layout is not recognized. Select the model in the native terminal; the chat is not restarted.');
      this.openMenus.set(id, { process, options });
      return { options };
    } finally { this.busy.delete(id); }
  }
  async choose(id, slug) {
    if (this.busy.has(id)) throw new Error('Model picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), menu = this.openMenus.get(id);
      const options = parseClaudeModelPicker(await this.screen(id));
      if (!menu || menu.process !== session.process || !options || options.some((item, index) => item.label !== menu.options[index]?.label) || options.length !== menu.options.length) throw new Error('Claude picker changed. Reopen it or use the terminal.');
      const index = options.findIndex(item => item.slug === slug), active = options.findIndex(item => item.active);
      if (index < 0) throw new Error('Choose an option from the current Claude picker.');
      this.openMenus.delete(id);
      for (let step = 0; step < Math.abs(index - active); step++) this.sessions.input(id, index > active ? '\x1b[B' : '\x1b[A');
      // Verify the highlighted entry before accepting it; never guess from an old screen.
      const selected = await this.until(id, value => {
        const rows = parseClaudeModelPicker(value);
        return rows?.find(item => item.active)?.slug === slug ? true : null;
      });
      if (!selected || session.process !== menu.process) throw new Error('Claude did not highlight the expected option. Finish in the terminal.');
      this.sessions.input(id, '\r');
      const confirmed = await this.until(id, value => !parseClaudeModelPicker(value) && /(?:Set model to|Switched (?:model )?to|Model changed to)/i.test(value.split('\n').slice(-15).join('\n')) ? true : null);
      if (!confirmed) throw new Error('Selection sent; check the native Claude confirmation before continuing.');
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
  const lines = screen.split('\n').slice(-35);
  const start = lines.findLastIndex(line => /^\s*(?:Select |Adjust )?(?:reasoning )?effort(?: level)?\s*$/i.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /s\s+(?:for )?(?:this )?session(?: only)?/i.test(line) && /esc|escape/i.test(line));
  if (end < 0) return null;
  const body = lines.slice(start + 1, end);
  const track = body.find(line => line.includes('▲') && /─/.test(line));
  const labels = body.find(line => /^\s*low\s+medium(?:\s+high)?(?:\s+xhigh)?(?:\s+max)?(?:\s+ultracode)?\s*$/i.test(line));
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
        const prompt = (await this.screen(id)).split('\n').slice(-15).filter(line => /^\s*❯/.test(line)).at(-1) || '';
        if (session.activity !== 'idle' || !/^\s*❯\s*$/.test(prompt)) throw new Error('Wait for an idle, empty Claude prompt.');
        this.sessions.input(id, '/effort');
        if (!await this.until(id, screen => /^\s*❯\s*\/effort\s*$/m.test(screen) ? true : null, 1500) || session.process !== process) throw new Error('Claude did not accept /effort. Continue in the terminal.');
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
      if (!await this.until(id, screen => parseClaudeEffortPicker(screen)?.find(item => item.active)?.slug === effort ? true : null) || session.process !== menu.process) throw new Error('Claude did not highlight the selected effort. Continue in the terminal.');
      this.openMenus.delete(id); this.sessions.input(id, 's');
      const confirmed = await this.until(id, screen => !parseClaudeEffortPicker(screen) && new RegExp(`(?:effort[^\\n]{0,60}\\b${effort}\\b|\\b${effort}\\b[^\\n]{0,30}effort)`, 'i').test(screen.split('\n').slice(-12).join('\n')) ? true : null);
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
