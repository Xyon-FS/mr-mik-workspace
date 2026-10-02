import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexModelPicker } from './model-picker.mjs';
import { replaceControlFile } from './opencode/state-writer.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class OpenCodePicker extends CodexModelPicker {
  visibleLines(id) {
    const terminal = this.session(id).terminal, buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, offset) => ({ row: buffer.baseY + offset, text: buffer.getLine(buffer.baseY + offset)?.translateToString(true) || '' }));
  }
  async screen(id) {
    await new Promise(resolve => this.session(id).terminal.write('', resolve));
    return this.visibleLines(id).map(line => line.text).join('\n');
  }
  session(id) {
    const session = this.sessions.get(id);
    if (session.agent !== 'opencode' || session.status !== 'running' || !session.process || !session.openCodeLaunchId) throw new Error('Open a running OpenCode conversation first.');
    return session;
  }
  async command(id, action, extra = {}) {
    this.requests ||= new Set();
    if (this.requests.has(id)) throw new Error('Wait for the current OpenCode control.');
    this.requests.add(id);
    try {
      const session = this.session(id), process = session.process;
      const launchId = session.openCodeLaunchId;
      const file = path.join(this.sessions.stateDir, 'opencode', `${id}.control`), requestId = randomUUID();
      await writeFile(`${file}.tmp`, JSON.stringify({ ...extra, id: requestId, launchId, action, at: Date.now() }), { mode: 0o600 });
      await replaceControlFile(`${file}.tmp`, file, () => session.process === process && session.openCodeLaunchId === launchId && session.status === 'running');
      const deadline = Date.now() + (action === 'mcp-refresh' ? 30000 : 3000);
      while (Date.now() < deadline && session.process === process) {
        const reply = await readFile(`${file}.reply`, 'utf8').then(JSON.parse).catch(() => null);
        if (reply?.id === requestId && reply.launchId === launchId && session.openCodeLaunchId === launchId) { if (reply.error) throw new Error(reply.error); if (reply.accepted) return reply; }
        await wait(80);
      }
      throw new Error('This OpenCode TUI control is unavailable. Continue in the native terminal; no chat was restarted.');
    } finally { this.requests.delete(id); }
  }
  // Native list rows have the same column as their highlighted row. Read only
  // visible options; never guess IDs or send Enter without a verified highlight.
  rows(id, mode) {
    const terminal = this.session(id).terminal, buffer = terminal.buffer.active;
    const visible = this.visibleLines(id), lines = visible.map(line => line.text);
    const start = lines.findLastIndex(line => /Select model|Select variant/.test(line));
    if (start < 0 || !lines[start].includes(mode === 'model' ? 'Select model' : 'Select variant')) return null;
    const titleX = lines[start].indexOf(mode === 'model' ? 'Select model' : 'Select variant'), titleRow = visible[start].row, foreground = buffer.getLine(titleRow)?.getCell(titleX)?.getFgColor();
    const candidates = [];
    const catalog = this.catalogs?.get(id) || [];
    let groupProvider;
    for (let offset = start + 1; offset < Math.min(lines.length, start + 32); offset++) {
      // The model search input is two rows below its title, not a selectable model.
      if (mode === 'model' && offset === start + 2) continue;
      const row = visible[offset].row, line = lines[offset].slice(Math.max(0, titleX - 2)); if (/ctrl\+|enter/i.test(line)) break;
      if (/esc|No results|Search/i.test(line) || !line.trim()) continue;
      const section = catalog.find(item => item.provider === line.trim());
      if (section) { groupProvider = section.providerID; continue; }
      if (/^(Recent|Favorites)$/.test(line.trim())) { groupProvider = undefined; continue; }
      const x = line.search(/\S/) + Math.max(0, titleX - 2), cell = buffer.getLine(row)?.getCell(x);
      if (!cell) continue;
      const active = cell.isBgRGB() && cell.getBgColor() !== 0 && cell.getBgColor() !== buffer.getLine(titleRow)?.getCell(x)?.getBgColor();
      const current = line.trim().startsWith('●');
      const rawTitle = line.trim().replace(/^●\s*/, '').trim();
      const matches = mode === 'model' ? catalog.filter(item => rawTitle === item.label || rawTitle.startsWith(`${item.label} `)).sort((a, b) => b.label.length - a.label.length) : [];
      const known = matches.find(item => rawTitle.slice(item.label.length).includes(item.provider)) || matches.find(item => item.providerID === groupProvider) || (matches.length === 1 ? matches[0] : null);
      const knownVariant = mode === 'variant' && (rawTitle === 'Default' || catalog.some(item => item.variants?.includes(rawTitle)));
      if (mode === 'variant' && !knownVariant && !/^(?:●\s*)?(?:Default|[a-z][a-z0-9_-]{0,63})$/.test(line.trim())) continue;
      if (!known && !knownVariant && !active && !current && cell.getFgColor() !== foreground) continue;
      const labelX = x + (current ? 2 : 0), labelCell = buffer.getLine(row)?.getCell(labelX);
      let label = '';
      for (let col = labelX; col < terminal.cols; col++) {
        const next = buffer.getLine(row)?.getCell(col), chars = next?.getChars() || ' ';
        if (chars.trim() && (next.getFgColor() !== labelCell.getFgColor() || next.getFgColorMode() !== labelCell.getFgColorMode())) break;
        label += chars;
      }
      label = label.trim().replace(/\s{2,}.*/, '').trim();
      if (known) label = known.label;
      if (!label) continue;
      const rawLabel = line.trim().replace(/^●\s*/, '').replace(/\s{2,}.*/, '').trim();
      const providerSuffix = mode === 'model' && rawLabel.startsWith(`${label} `) ? rawLabel.slice(label.length + 1) : null;
      candidates.push({ row, x: labelX, label, providerSuffix, current, active, ...(known ? { providerID: known.providerID, modelID: known.modelID } : {}) });
    }
    const active = candidates.filter(item => item.active);
    if (active.length !== 1) return null;
    const x = active[0].x;
    const rows = candidates.filter(item => item.x === x);
    if (!rows.length) return null;
    return rows.map(item => ({ ...item, slug: String(item.row), key: String(item.row) }));
  }
  async openMenu(id, mode) {
    if (this.busy.has(id)) throw new Error('OpenCode picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id);
      this.catalogs ||= new Map();
      const reply = await this.command(id, 'catalog');
      if (Array.isArray(reply?.models)) this.catalogs.set(id, reply.models);
      // The native adapter verifies actual busy/dialog/permission state. Local
      // attention also means an unread answer, and may lag after provider errors.
      if (!this.rows(id, mode)) await this.command(id, mode);
      const options = await this.until(id, () => this.rows(id, mode));
      if (!options) throw new Error(mode === 'model' ? 'The native model menu could not be read safely. Retry or use the terminal.' : 'No variant menu was opened. This model may have no variants, or its native menu is unavailable.');
      this.openMenus.set(id, { process: session.process, mode, options });
      return { options };
    } catch (error) { this.openMenus.delete(id); throw error; }
    finally { this.busy.delete(id); }
  }
  async open(id) {
    const session = this.session(id);
    const previous = this.openMenus.get(id);
    if (previous?.nativeOpened && previous.process === session.process && this.rows(id, 'model')) { this.sessions.input(id, '\x1b'); await this.until(id, () => !this.rows(id, 'model') ? true : null); }
    const reply = await this.command(id, 'catalog');
    if (!Array.isArray(reply?.models) || !reply.models.length) throw new Error('No connected native model catalog is available. Connect a provider in OpenCode first.');
    const models = reply.models.filter(item => typeof item.providerID === 'string' && typeof item.modelID === 'string' && typeof item.label === 'string' && !/[\x00-\x1f\x7f]/.test(item.label + item.providerID + item.modelID + item.provider));
    this.catalogs ||= new Map(); this.catalogs.set(id, models);
    const options = models.map(item => ({ key: JSON.stringify([item.providerID, item.modelID]), slug: JSON.stringify([item.providerID, item.modelID]), label: item.label, description: item.provider, current: false }));
    this.openMenus.set(id, { process: session.process, mode: 'model', options, catalog: true });
    return { options };
  }
  openEffort(id) { return this.openMenu(id, 'variant'); }
  async chooseMenu(id, slug, mode) {
    if (this.busy.has(id)) throw new Error('OpenCode picker is already changing.');
    this.busy.add(id);
    try {
      const session = this.session(id), menu = this.openMenus.get(id), rows = this.rows(id, mode);
      if (!menu || menu.mode !== mode || menu.process !== session.process || !rows || JSON.stringify(rows.map(row => [row.slug, row.label])) !== JSON.stringify(menu.options.map(row => [row.slug, row.label]))) throw new Error('Native options changed. Reopen the menu or continue in the terminal.');
      const target = rows.find(row => row.slug === slug), index = rows.findIndex(row => row.slug === slug), active = rows.findIndex(row => row.active);
      if (!target) throw new Error('Choose a visible native option.');
      for (let step = 0; step < Math.abs(index - active); step++) this.sessions.input(id, index > active ? '\x1b[B' : '\x1b[A');
      // OpenCode's Recent list changes the provider suffix colour on highlight.
      // Keep exact row/order and accept only a previously observed provider suffix;
      // confirm another row merely because a provider-qualified label matches.
      const compatibleLabel = (a, b) => a.label === b.label || a.providerSuffix && b.label === `${a.label} ${a.providerSuffix}` || b.providerSuffix && a.label === `${b.label} ${b.providerSuffix}`;
      const selected = await this.until(id, () => {
        const fresh = this.rows(id, mode), highlighted = fresh?.find(row => row.active);
        return highlighted?.slug === target.slug && compatibleLabel(highlighted, target) && fresh.length === rows.length && fresh.every((row, index) => row.slug === rows[index].slug && compatibleLabel(row, rows[index])) ? true : null;
      });
      if (!selected || session.process !== menu.process) throw new Error('Native highlight was not confirmed. Continue in the terminal.');
      this.openMenus.delete(id); this.sessions.input(id, '\r');
      const accepted = await this.until(id, screen => mode === 'model' && this.rows(id, 'variant') || !this.rows(id, mode) && !/Select model|Select variant/.test(screen) ? true : null);
      if (!accepted) throw new Error('Finish the native selection in the terminal, then reopen this menu.');
      return { confirmed: true };
    } finally { this.busy.delete(id); }
  }
  async choose(id, slug) {
    const session = this.session(id), menu = this.openMenus.get(id);
    if (!menu?.catalog || menu.process !== session.process || !menu.options.some(item => item.slug === slug)) throw new Error('Reopen the native model catalog before selecting.');
    const target = this.catalogs.get(id).find(item => JSON.stringify([item.providerID, item.modelID]) === slug);
    if (!target) throw new Error('Native model catalog changed. Reopen it.');
    await this.command(id, 'model');
    this.openMenus.set(id, { ...menu, nativeOpened: true });
    let rows = await this.until(id, () => this.rows(id, 'model'));
    if (!rows) throw new Error('The native model menu could not be read safely. Continue in the terminal.');
    // Input goes only to the verified native model dialog, never to the prompt.
    this.sessions.input(id, target.label);
    await wait(220);
    rows = await this.until(id, () => { const value = this.rows(id, 'model'); return value?.some(item => item.label === target.label && item.providerID === target.providerID && item.modelID === target.modelID) ? value : null; });
    const matches = rows?.filter(item => item.label === target.label && item.providerID === target.providerID && item.modelID === target.modelID) || [];
    if (matches.length !== 1) throw new Error('Native model identity is ambiguous. Continue in the terminal; no model was confirmed.');
    this.openMenus.set(id, { process: session.process, mode: 'model', options: rows });
    const result = await this.chooseMenu(id, matches[0].slug, 'model');
    if (this.rows(id, 'variant')) return { ...result, variantMenu: true };
    return result;
  }
  chooseEffort(id, slug) { return this.chooseMenu(id, slug, 'variant'); }
  async cancel(id) {
    const menu = this.openMenus.get(id); this.openMenus.delete(id);
    if (menu && this.session(id).process === menu.process && this.rows(id, menu.mode)) this.sessions.input(id, '\x1b');
    return { cancelled: true };
  }
  cancelEffort(id) { return this.cancel(id); }
}
