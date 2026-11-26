import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, writeFile, unlink } from 'node:fs/promises';
import { graphicalInput } from './codex-chat-advanced.mjs';
import { skillMentions, mentionedSkills } from './skill-mentions.mjs';
import { recordedQuoteSuffix } from './chat-input-presentation.mjs';

const safe = value => typeof value === 'string' && !!value && value.length <= 8192 && !/[\x00-\x1f]/.test(value);
export class GraphicalComposer {
  constructor(runtime) { this.runtime = runtime; this.items = []; }
  editBrowser(id, text) {
    this.assertEditable?.(); const item = this.items.find(item => item.id === id && item.type === 'quote' && item.sourceUrl);
    if (!item || typeof text !== 'string' || !text.trim() || text.length > 8000 || this.items.filter(value => value.id !== id && value.type === 'quote').reduce((size, value) => size + value.text.length, text.length) > 16000) throw new Error('Choose a shorter browser note.');
    item.id = randomUUID(); item.text = text; this.changed(); return { edited: true };
  }
  addBrowser(value) {
    this.assertEditable?.();
    const url = new URL(value.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid browser source.');
    const text = `Browser selection: ${value.title || 'Page'}\n${url.href}\n${value.text}`;
    if (text.length > 8000 || this.items.length >= 20 || this.items.filter(item => item.type === 'quote').reduce((size, item) => size + item.text.length, text.length) > 16000) throw new Error('Remove some selected context before adding this browser selection.');
    this.items.push({ id: randomUUID(), type: 'quote', itemId: `browser:${randomUUID()}`, role: 'user', text, sourceUrl: url.href }); this.changed(); return { added: true };
  }
  restore(items) {
    this.items = Array.isArray(items) ? items.filter(item => item && safe(item.id) && (item.type === 'quote' && safe(item.itemId) && typeof item.text === 'string' && item.text.length <= 8000 && ['user', 'assistant'].includes(item.role) || item.type === 'skill' && safe(item.name) && safe(item.path) && path.isAbsolute(item.path))).slice(0, 20).map(item => { const { sourceUrl, ...value } = item; return typeof sourceUrl === 'string' && /^https?:\/\//i.test(sourceUrl) ? { ...value, sourceUrl } : value; }) : [];
  }
  async skills() {
    const result = await this.runtime.rpc('skills/list', { cwds: [this.runtime.session.cwd], forceReload: true });
    const entries = Array.isArray(result.data) ? result.data : [];
    if (!entries.length) throw new Error('This runtime did not return a skill catalog.');
    const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const same = value => typeof value === 'string' && key(value) === key(this.runtime.session.cwd);
    const scoped = entries.filter(entry => same(entry.cwd));
    if (!scoped.length) throw new Error('No skill catalog was returned for this chat folder.');
    return { skills: scoped.flatMap(entry => entry.skills || []).filter(skill => skill.enabled !== false && safe(skill.name) && safe(skill.path) && path.isAbsolute(skill.path)).slice(0, 200).map(skill => ({ name: skill.name, path: skill.path, description: String(skill.description || '').slice(0, 500) })), warnings: scoped.flatMap(entry => entry.errors || []).length ? 'Some skills could not be loaded. Check Tools for configuration errors.' : '' };
  }
  async add(value) {
    if (this.items.length >= 20) throw new Error('Remove a context item before adding another (20 item limit).');
    let item;
    if (value?.type === 'quote') {
      const source = this.runtime.items.get(value.itemId) || this.runtime.historyItems.get(value.itemId);
      if (!source || !['agentMessage', 'userMessage'].includes(source.type)) throw new Error('Load the source message before quoting it.');
      const text = value.text ?? source.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 8000 || this.items.filter(item => item.type === 'quote').reduce((size, item) => size + item.text.length, text.length) > 16000) throw new Error('Quote a shorter selection (8,000 characters per quote, 16,000 total).');
      item = { id: randomUUID(), type: 'quote', itemId: source.id, role: source.type === 'userMessage' ? 'user' : 'assistant', text };
    } else if (value?.type === 'skill') {
      const skill = (await this.skills()).skills.find(skill => skill.path === value.path && skill.name === value.name);
      if (!skill) throw new Error('This skill is unavailable or disabled. Refresh the skill list.');
      item = { id: randomUUID(), type: 'skill', name: skill.name, path: skill.path };
    } else throw new Error('Choose a quote or an available skill.');
    if (!this.items.some(previous => item.type === 'skill' ? previous.type === 'skill' && previous.path === item.path : previous.type === 'quote' && previous.itemId === item.itemId && previous.text === item.text)) this.items.push(item);
    this.changed(); return { added: true };
  }
  remove(id) { this.items = this.items.filter(item => item.id !== id); this.changed(); return { removed: true }; }
  detach(file) { this.runtime.attachments = this.runtime.attachments.filter(value => value !== file); this.changed(); return { removed: true }; }
  changed() { this.runtime.draftRevision++; this.runtime.changed(); }
  consumed(items) { const ids = new Set(items.map(item => item.id)); this.items = this.items.filter(item => !ids.has(item.id)); }
  async input(text, paths, items) {
    try {
      const selected = items.filter(item => item.type === 'skill');
      if (selected.length || skillMentions(text).length) {
        const available = (await this.skills()).skills;
        if (selected.some(item => !available.some(skill => skill.path === item.path && skill.name === item.name))) throw new Error('A selected skill is no longer available. Remove it or refresh Skills. Nothing was sent.');
        for (const skill of mentionedSkills(text, available)) if (!selected.some(item => item.path === skill.path)) selected.push(skill);
      }
      const quotes = items.filter(item => item.type === 'quote');
      const prompt = text + recordedQuoteSuffix(quotes);
      const input = graphicalInput(prompt, paths);
      if (input[0].text.length > 64000) throw new Error('Prompt and context exceed 64,000 characters. Remove a quote or shorten the message.');
      return [...input, ...selected.map(item => ({ type: 'skill', name: item.name, path: item.path }))];
    } catch (error) { throw Object.assign(error, { nativeRejected: true }); }
  }
  async paste(stateDir, id, text) {
    if (typeof text !== 'string' || !text.length || text.length > 256000 || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Paste text must be smaller than 256,000 characters and 1 MB.');
    if (!/^[a-f0-9-]{36}$/i.test(id) || this.runtime.attachments.length >= 100) throw new Error('Remove an attachment before adding pasted text.');
    let folder = await realpath(stateDir);
    for (const name of ['chat-inputs', id]) {
      folder = path.join(folder, name);
      await mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw new Error('The private paste folder cannot be linked to another location.');
    }
    const file = path.join(folder, `Pasted-text-${randomUUID()}.txt`);
    await writeFile(file, text, { flag: 'wx', mode: 0o600 });
    if (this.runtime.closed || this.runtime.attachments.length >= 100) { await unlink(file); throw new Error('Reconnect the chat or remove an attachment before pasting.'); }
    this.runtime.attachments.push(file); this.runtime.previewPaths.add(file); this.changed();
    return { path: file, characters: text.length, submitted: false };
  }
}
