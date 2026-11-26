import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { readJson, saveJson } from './util.mjs';
import { validateClaudeContext } from './claude-composer.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
export class ClaudeChatQueue {
  constructor(runtime) {
    this.runtime = runtime; this.queue = []; this.receipts = []; this.paused = false; this.notice = ''; this.busy = false; this.dispatching = false;
    this.file = path.join(runtime.stateDir, `claude-queue-${runtime.session.id}.json`);
    this.writes = Promise.resolve();
  }
  settings() {
    const s = this.runtime.session;
    return { nativeId: s.nativeId, cwd: s.cwd, account: s.accountProfileId || null, model: s.graphicalModel || '', effort: s.effort || null, permissions: s.claudePermissionMode };
  }
  get pending() { return this.queue.length > 0 || this.busy || this.dispatching; }
  snapshot() {
    return { queue: this.queue.map(item => ({ id: item.id, text: item.text, paths: item.attachments.map(file => file.path), context: structuredClone(item.context), state: item.state, settings: { model: item.settings.model, mode: item.settings.permissions } })), queuePaused: this.paused, queueNotice: this.notice, queueBusy: this.busy || this.dispatching };
  }
  async restore() {
    const info = await lstat(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 3_000_000) throw new Error('Saved Claude queue is unavailable or too large.');
    const saved = await readJson(this.file, null);
    if (!saved || saved.nativeId !== this.runtime.session.nativeId || saved.repo !== this.runtime.stateDir || !Array.isArray(saved.queue) || saved.queue.length > 20 || !Array.isArray(saved.receipts) || saved.receipts.length > 1000 || !saved.receipts.every(uuid)) throw new Error('Saved Claude queue does not match this conversation.');
    const ids = new Set();
    this.queue = saved.queue.map(item => {
      if (!item || !uuid(item.id) || ids.has(item.id) || !saved.receipts.includes(item.id) || typeof item.text !== 'string' || item.text.length > 64000 || !['queued', 'sending', 'uncertain'].includes(item.state) || !Array.isArray(item.attachments) || item.attachments.length > 20 || item.attachments.some(file => !file || !['file', 'folder', 'image'].includes(file.kind) || !path.isAbsolute(file.path || '') || !path.isAbsolute(file.resolvedPath || '')) || !item.settings || JSON.stringify(item.settings).length > 20000) throw new Error('Invalid saved Claude queue entry.');
      ids.add(item.id);
      return { ...item, context: validateClaudeContext(item.context), state: item.state === 'queued' ? 'queued' : 'uncertain' };
    });
    this.receipts = saved.receipts;
    this.runtime.steering.restore(saved.steering);
    if (this.queue.length) { this.paused = true; this.notice = 'Restored paused. Review messages before resuming. Uncertain entries are never resent.'; }
  }
  save() {
    const value = structuredClone({ version: 1, nativeId: this.runtime.session.nativeId, repo: this.runtime.stateDir, queue: this.queue, receipts: this.receipts, steering: this.runtime.steering.save() });
    if (Buffer.byteLength(JSON.stringify(value, null, 2)) > 2_990_000) return Promise.reject(new Error('Claude queue and guidance state exceeds its storage limit. Remove pending entries first.'));
    const write = this.writes.catch(() => {}).then(() => saveJson(this.file, value)); this.writes = write; return write;
  }
  validate(text, attachments, context) {
    if (typeof text !== 'string' || text.length > 64000 || /^\s*\//.test(text) || !text.trim() && !attachments.length && !context.length) throw new Error('Enter a message or select context. Use CLI for slash commands.');
  }
  async enqueue(text, requestId) {
    const r = this.runtime;
    if (!uuid(requestId)) throw new Error('A queue request identity is required.');
    if (this.receipts.includes(requestId)) { await this.writes; return { queued: true, alreadyRecorded: true }; }
    if (this.busy || this.dispatching || r.steering.busy || !r.initialized || r.closed || r.configuring || r.submitting || r.attachmentUpdating || r.messageActionBusy || r.usageRefreshing || r.protocol.state.uncertain || ['running', 'uncertain'].includes(r.protocol.state.compaction?.status) || this.queue.length >= 20 || this.receipts.length >= 1000) throw new Error('Finish the current operation or resolve the queue limit before adding a message.');
    const attachments = structuredClone(r.attachmentDetails), context = structuredClone(r.composer.items), draft = r.draft, revision = r.draftRevision, settings = this.settings();
    this.validate(text, attachments, context); this.busy = true; r.changed();
    try {
      // Same validation as direct send; binary image data is never persisted.
      const prepared = await r.composer.input(text, attachments, context);
      if (r.closed || JSON.stringify(settings) !== JSON.stringify(this.settings())) throw new Error('Claude changed before queueing. Your draft is preserved.');
      const entry = { id: requestId, text, attachments, context: prepared.context, settings, state: 'queued' };
      this.queue.push(entry); this.receipts.push(requestId);
      try { await this.save(); } catch (error) { this.queue.pop(); this.receipts.pop(); throw error; }
      if (r.draft === draft && r.draftRevision === revision) r.draft = '';
      r.composer.consumed(context);
      const consumed = new Set(attachments.map(item => item.path));
      r.attachmentDetails = r.attachmentDetails.filter(item => !consumed.has(item.path)); r.attachments = r.attachmentDetails.map(item => item.path);
      return { queued: true };
    } finally { this.busy = false; r.changed(); }
  }
  async edit(id, text) {
    const entry = this.queue.find(item => item.id === id);
    if (this.busy || this.dispatching || !entry || entry.state !== 'queued') throw new Error('Only an unsent queued message can be edited.');
    this.validate(text, entry.attachments, entry.context);
    this.busy = true;
    const previous = entry.text; entry.text = text;
    try { await this.save(); return { edited: true }; } catch (error) { entry.text = previous; throw error; }
    finally { this.busy = false; this.runtime.changed(); }
  }
  async cancel(id) {
    const entry = this.queue.find(item => item.id === id);
    if (this.busy || this.dispatching || !entry || entry.state === 'sending') throw new Error('Wait for dispatch to finish before removing this entry.');
    this.busy = true; const previous = [...this.queue]; this.queue = this.queue.filter(item => item !== entry);
    try { await this.save(); return { cancelled: true }; } catch (error) { this.queue = previous; throw error; }
    finally { this.busy = false; this.runtime.changed(); }
  }
  pause(paused) {
    if (typeof paused !== 'boolean') throw new Error('Choose pause or resume.');
    if (!paused && (this.queue.some(item => item.state !== 'queued') || this.runtime.protocol.state.uncertain)) throw new Error('Review uncertain delivery and dismiss its queue entry before resuming. It will never be resent.');
    this.paused = paused; this.notice = paused ? 'Queue paused.' : ''; this.runtime.changed(); return { paused };
  }
  observe(before, next) {
    const turn = next.turns.at(-1), old = before.turns.at(-1);
    if (this.queue.length && (next.uncertain || ['disconnected', 'closed', 'error'].includes(next.status) || turn?.completedAt && !old?.completedAt && turn.status !== 'completed')) {
      this.paused = true; this.notice = 'Queue paused after an interruption, error or disconnect. Review before resuming.';
    }
  }
  schedule() {
    if (this.timer || !this.queue.length || this.paused || this.runtime.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this.active = this.drain(); void this.active.catch(error => { this.paused = true; this.notice = error.message; this.runtime.changed(); }); }, 0);
    this.timer.unref?.();
  }
  async drain() {
    const r = this.runtime;
    if (this.paused || this.busy || this.dispatching || !this.queue.length || !r.idle() || r.draft.trim() || r.attachments.length || r.composer.items.length || r.protocol.state.requests.length || r.session.stopping || r.session.toolUpdating || r.session.switchingInterface) return;
    const entry = this.queue[0];
    if (entry.state !== 'queued' || JSON.stringify(entry.settings) !== JSON.stringify(this.settings())) { this.paused = true; this.notice = 'Settings changed. Remove and re-add unsent messages using the current settings.'; r.changed(); return; }
    this.dispatching = true; r.changed(); let reserved = false;
    try {
      await r.verifyIdentity?.();
      const prepared = await r.composer.input(entry.text, entry.attachments, entry.context);
      if (this.paused || r.closed || r.draft.trim() || r.attachments.length || r.composer.items.length) return;
      entry.state = 'sending'; await this.save(); reserved = true;
      // Reserve durably before any wire send. Recheck after the filesystem await.
      if (this.paused || r.closed || r.protocol.state.status !== 'ready' || r.protocol.state.uncertain || r.protocol.state.requests.length || r.attachmentUpdating || r.configuring || r.messageActionBusy || r.usageRefreshing || r.submitting || r.draft.trim() || r.attachments.length || r.composer.items.length || r.session.toolUpdating || r.session.stopping || r.session.switchingInterface || JSON.stringify(entry.settings) !== JSON.stringify(this.settings())) {
        entry.state = 'queued'; await this.save(); return;
      }
      r.protocol.submit(entry.text, { content: prepared.blocks, attachments: prepared.attachments, composerContext: prepared.context });
      this.queue = this.queue.filter(item => item !== entry); await this.save();
    } catch (error) {
      this.paused = true; this.notice = reserved ? 'Delivery uncertain. Inspect the conversation; this entry will never be resent.' : error.message;
      entry.state = reserved ? 'uncertain' : 'queued';
      if (!this.queue.includes(entry)) this.queue.unshift(entry);
      await this.save();
    } finally { this.dispatching = false; r.changed(); }
  }
  async close() { clearTimeout(this.timer); this.timer = null; await this.active; await this.writes; }
}
