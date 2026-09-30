const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const recent = screen => screen.split('\n').slice(-45);

export function parseModelPicker(screen) {
  const lines = recent(screen);
  const start = lines.findLastIndex(line => /^\s*Select Model and Effort\s*$/.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /enter select\s*·\s*esc back/i.test(line));
  if (end < 0 || end - start > 24) return null;
  const options = lines.slice(start + 1, end).map(line => /^\s*[›>]?\s*([1-9])\.\s+(GPT-[\d.]+(?:-[A-Za-z]+)?)(?:\s+\((current|default)\))?/i.exec(line)).filter(Boolean).map(match => ({ key: match[1], label: match[2], slug: match[2].toLowerCase(), current: match[3] === 'current' }));
  if (options.length < 2 || new Set(options.map(item => item.key)).size !== options.length || new Set(options.map(item => item.slug)).size !== options.length) return null;
  return options;
}

export function parseReasoningPicker(screen, model) {
  const lines = recent(screen);
  const start = lines.findLastIndex(line => line.trim() === `Select Reasoning Level for ${model}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /enter default\s*·\s*s session\s*·\s*esc back/i.test(line));
  if (end < 0 || end - start > 15) return null;
  const options = lines.slice(start + 1, end).map(line => /^\s*([›>])?\s*([1-9])\.\s+(None|Minimal|Low|Medium|High|Extra high|Max|Ultra)(?:\s+\((current|default)\))?/i.exec(line)).filter(Boolean).map(match => ({ key: match[2], label: match[3], active: !!match[1], current: match[4] === 'current', default: match[4] === 'default' }));
  return options.length ? options : null;
}

export class CodexModelPicker {
  constructor(sessions) { this.sessions = sessions; this.openMenus = new Map(); this.busy = new Set(); }
  async screen(id) { return (await this.sessions.read(id, 70)).screen; }
  async until(id, parse, timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = parse(await this.screen(id));
      if (result) return result;
      await wait(80);
    }
    return null;
  }
  session(id) {
    const session = this.sessions.get(id);
    if (session.agent !== 'codex' || session.status !== 'running' || !session.process) throw new Error('Open a running Codex chat to change its model.');
    return session;
  }
  async open(id) {
    if (this.busy.has(id)) throw new Error('Model picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), process = session.process;
      let screen = await this.screen(id);
      let options = parseModelPicker(screen);
      if (!options) {
        const composer = recent(screen).filter(line => /^\s*›/.test(line)).at(-1) || '';
        if (session.activity !== 'idle' || !/^\s*›\s*(?:Ask Codex to do anything|Ask for follow-up|Ask a follow-up)?\s*$/.test(composer)) throw new Error('Wait for an idle Codex prompt with no draft message, then try again.');
        this.sessions.input(id, '/model');
        const ready = await this.until(id, value => recent(value).some(line => /^\s*›\s*\/model\s*$/.test(line)) ? true : null, 1500);
        if (!ready || session.process !== process) throw new Error('Codex did not open the /model command. Use the terminal picker directly.');
        this.sessions.input(id, '\r');
        options = await this.until(id, parseModelPicker);
      }
      if (!options || session.process !== process) throw new Error('Could not recognize this Codex model picker. Use the picker in the terminal.');
      this.openMenus.set(id, { process, options });
      return { options };
    } finally { this.busy.delete(id); }
  }
  async choose(id, slug) {
    if (this.busy.has(id)) throw new Error('Model picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), menu = this.openMenus.get(id);
      if (!menu || session.process !== menu.process) throw new Error('Open the model menu again.');
      const options = parseModelPicker(await this.screen(id));
      const target = options?.find(item => item.slug === slug);
      if (!target || options.length !== menu.options.length || options.some((item, index) => item.slug !== menu.options[index].slug || item.key !== menu.options[index].key)) throw new Error('The Codex picker changed. Use the terminal picker or reopen the menu.');
      this.openMenus.delete(id);
      this.sessions.input(id, target.key);
      const effort = await this.until(id, value => parseReasoningPicker(value, target.label));
      if (!effort || session.process !== menu.process) throw new Error('Codex did not show the expected reasoning picker. Finish the choice in the terminal.');
      const selected = effort.find(item => item.current) || effort.find(item => item.default);
      if (!selected) throw new Error('Reasoning choices changed. Finish the choice in the terminal.');
      this.sessions.input(id, selected.key);
      const confirmed = await this.until(id, value => recent(value).some(line => line.toLowerCase().includes(`model changed to ${slug} `)) ? true : null);
      if (!confirmed) throw new Error('Selection sent, but Codex did not confirm it. Check the terminal before continuing.');
      const effortValue = { 'Extra high': 'xhigh' }[selected.label] || selected.label.toLowerCase();
      session.effort = effortValue;
      this.sessions.changed?.(session);
      await this.sessions.persist?.();
      return { model: slug, effort: effortValue, confirmed: true };
    } finally { this.busy.delete(id); }
  }
  async cancel(id) {
    const menu = this.openMenus.get(id);
    this.openMenus.delete(id);
    if (menu && this.sessions.get(id).process === menu.process && parseModelPicker(await this.screen(id))) this.sessions.input(id, '\x1b');
    return { cancelled: true };
  }
  async openEffort(id) {
    const { options } = await this.open(id);
    const menu = this.openMenus.get(id), current = options.find(item => item.current);
    if (!current) { await this.cancel(id); throw new Error('The native picker did not identify the current model. Continue in the terminal.'); }
    this.busy.add(id);
    try {
      this.sessions.input(id, current.key);
      const rows = await this.until(id, screen => parseReasoningPicker(screen, current.label));
      if (!rows || this.session(id).process !== menu.process) throw new Error('Reasoning picker not recognized. Continue in the terminal.');
      const options = rows.map(item => ({ ...item, slug: item.label.toLowerCase().replace('extra high', 'xhigh') }));
      this.openMenus.set(id, { ...menu, kind: 'effort', model: current, options }); return { options };
    } finally { this.busy.delete(id); }
  }
  async chooseEffort(id, effort) {
    if (this.busy.has(id)) throw new Error('Picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), menu = this.openMenus.get(id);
      const rows = menu?.kind === 'effort' && parseReasoningPicker(await this.screen(id), menu.model.label);
      const target = menu?.options.find(item => item.slug === effort);
      if (!target || session.process !== menu.process || !rows || rows.length !== menu.options.length || rows.some((row, i) => row.key !== menu.options[i].key || row.label !== menu.options[i].label)) throw new Error('Native reasoning choices changed. Reopen the picker.');
      const from = rows.findIndex(item => item.active), to = rows.findIndex(item => item.key === target.key);
      if (from < 0) throw new Error('Native reasoning highlight not recognized. Continue in the terminal.');
      for (let step = 0; step < Math.abs(to - from); step++) this.sessions.input(id, to > from ? '\x1b[B' : '\x1b[A');
      if (!await this.until(id, screen => parseReasoningPicker(screen, menu.model.label)?.find(item => item.active)?.key === target.key ? true : null) || session.process !== menu.process) throw new Error('Native reasoning highlight changed. Continue in the terminal.');
      this.openMenus.delete(id); this.sessions.input(id, 's');
      const confirmed = await this.until(id, screen => recent(screen).some(line => line.toLowerCase().includes(`model changed to ${menu.model.slug} ${effort}`)) ? true : null);
      if (!confirmed || session.process !== menu.process) throw new Error('Selection sent, but not confirmed. Check the terminal.');
      session.effort = effort; this.sessions.changed?.(session); await this.sessions.persist?.(); return { confirmed: true, effort };
    } finally { this.busy.delete(id); }
  }
  async cancelEffort(id) {
    const menu = this.openMenus.get(id); this.openMenus.delete(id);
    if (menu?.kind === 'effort' && this.session(id).process === menu.process && parseReasoningPicker(await this.screen(id), menu.model.label)) {
      this.sessions.input(id, '\x1b');
      if (await this.until(id, parseModelPicker)) this.sessions.input(id, '\x1b');
    }
    return { cancelled: true };
  }
}
