import path from 'node:path';
import { lstat, realpath, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { saveJson, within } from './util.mjs';

const relative = value => typeof value === 'string' && !!value && !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => !part || part.startsWith('.') || /^(auth|credentials|tokens?)\./i.test(part));

// Registered pages only. No directory discovery, model calls or document writes.
export class CardContentSync {
  constructor({ repo, stateDir, registry, projects, changed = () => {}, onError = () => {}, interval = 2000, settle = 800 }) {
    Object.assign(this, { repo, registry, projects, changed, onError, interval, settle });
    this.file = path.join(stateDir, 'card-content-revisions.json');
    this.records = new Map(); this.pending = new Map(); this.closed = false; this.initialized = false;
  }
  async start() {
    try { const saved = JSON.parse(await readFile(this.file, 'utf8')); if (saved.version === 1) this.records = new Map(saved.entries); }
    catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
    await this.scan();
    this.initialized = true;
    this.timer = setInterval(() => { void this.scan().catch(error => this.onError(error)); }, this.interval); this.timer.unref?.();
    return this;
  }
  key(cardId, page) { return JSON.stringify([cardId, page]); }
  state(cardId, page) { return this.records.get(this.key(cardId, page)) || null; }
  scan() {
    if (this.closed || this.paused) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.refresh().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async pause() {
    this.paused = (this.paused || 0) + 1;
    try { await this.scanning; } catch (error) { this.resume(); throw error; }
  }
  resume() { this.paused = Math.max(0, (this.paused || 0) - 1); this.pending.clear(); }
  async sample(card, page, previous) {
    if (!relative(card.folder) || !relative(page) || !/\.(html|md)$/i.test(page)) return { status: 'invalid' };
    const base = path.join(this.repo, 'workspace');
    let file = base;
    for (const part of [...card.folder.split(/[\\/]/), ...page.split(/[\\/]/)]) {
      file = path.join(file, part);
      const info = await lstat(file);
      if (info.isSymbolicLink()) return { status: 'invalid' };
    }
    if (!within(await realpath(base), await realpath(file)) || !within(await realpath(this.repo), await realpath(base)) || (await lstat(base)).isSymbolicLink()) return { status: 'invalid' };
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || !info.size || info.size > 2 * 1024 * 1024) return { status: 'invalid' };
      const stamp = `${card.folder}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
      if (previous?.stamp === stamp) return previous;
      const bytes = Buffer.alloc(info.size + 1), result = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (result.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) return { status: 'writing' };
      const content = bytes.subarray(0, result.bytesRead);
      if (/\.html$/i.test(page) && !/<html[\s>]/i.test(content.toString('utf8'))) return { status: 'invalid', stamp };
      return { status: 'ready', stamp, revision: createHash('sha256').update(content).digest('hex') };
    } finally { await handle.close(); }
  }
  async refresh() {
    const registry = await this.registry(), seen = new Set(), updates = [];
    let dirty = false;
    for (const card of registry.entities || []) for (const step of card.steps || []) {
      if (this.closed) return;
      const key = this.key(card.id, step.path); seen.add(key);
      const previous = this.records.get(key);
      let next;
      try { next = await this.sample(card, step.path, previous); }
      catch (error) { next = { status: error.code === 'ENOENT' ? 'missing' : 'unavailable' }; }
      if (next.status === 'writing') continue;
      if (previous && next.status === previous.status && next.revision === previous.revision) {
        this.pending.delete(key);
        if (next.stamp !== previous.stamp) { this.records.set(key, next); dirty = true; }
        continue;
      }
      if (previous || this.initialized && next.status === 'ready') {
        const candidate = this.pending.get(key), signature = JSON.stringify(next);
        if (!candidate || candidate.signature !== signature) { this.pending.set(key, { signature, since: Date.now() }); continue; }
        if (Date.now() - candidate.since < this.settle) continue;
      }
      this.pending.delete(key); this.records.set(key, next); dirty = true;
      if (previous || this.initialized) updates.push({ cardId: card.id, folder: card.folder, page: step.path, path: `workspace/${card.folder}/${step.path}`.replaceAll('\\', '/'), ...next });
    }
    for (const key of this.records.keys()) if (!seen.has(key)) { this.records.delete(key); this.pending.delete(key); dirty = true; }
    for (const key of this.pending.keys()) if (!seen.has(key)) this.pending.delete(key);
    if (updates.some(value => value.status === 'ready')) await this.projects.editWorkspace(current => {
      for (const update of updates.filter(value => value.status === 'ready')) {
        const card = current.entities.find(value => value.id === update.cardId && value.folder === update.folder && value.steps?.some(step => step.path === update.page));
        if (card) card.updated = new Date().toISOString().slice(0, 10);
      }
    });
    if (dirty) await saveJson(this.file, { version: 1, entries: [...this.records] });
    if (updates.length && !this.closed) this.changed(updates);
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.scanning; }
}
