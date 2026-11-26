import { skillMentions } from './skill-mentions.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const count = value => Number.isFinite(value) && value >= 0 ? value : null;
const shorten = value => String(value ?? '').slice(0, 8000);
const input = (text, paths) => [{ type: 'text', text: text + (paths.length ? '\n\nAttached paths:\n' + paths.map(file => JSON.stringify(file)).join('\n') : '') }, ...paths.filter(file => /\.(png|jpe?g|webp|gif|bmp)$/i.test(file)).map(file => ({ type: 'localImage', path: file }))];
export const graphicalInput = input;

export class CodexChatAdvanced {
  constructor(runtime) {
    this.runtime = runtime; this.modes = []; this.modeIntent = null; this.modeEffective = null; this.modeError = '';
    this.queue = []; this.receipts = []; this.paused = false; this.dispatching = null; this.busy = false; this.steering = false;
    this.usage = null; this.limits = null; this.supportsSteer = true; this.queueNotice = '';
  }
  async discover() {
    try {
      const result = await this.runtime.rpc('collaborationMode/list', {}, 5000);
      this.modes = (result.data || []).filter(mode => ['plan', 'default'].includes(mode.mode)).map(mode => ({ mode: mode.mode, label: mode.mode === 'plan' ? 'Plan' : 'Build' }));
      // The default is also included explicitly in the next native turn payload.
      // Saved/observed Plan selections take precedence when restoring a chat.
      if (!this.modeIntent && !this.modeEffective && this.modes.some(mode => mode.mode === 'default')) this.modeIntent = 'default';
    }
    catch { this.modeError = 'This runtime does not expose collaboration modes.'; }
    this.runtime.changed();
  }
  settings() { const r = this.runtime; return { account: r.session.accountProfileId || null, model: r.model || r.effective?.model || null, effort: r.session.effort || null, permissions: r.session.codexPermissions || 'ask', mode: this.modeIntent || this.modeEffective }; }
  payload() {
    const selected = this.modeIntent;
    if (!selected) return {};
    const settings = this.settings();
    if (!settings.model || !this.modes.some(mode => mode.mode === selected)) throw new Error('Choose an available collaboration mode and model before sending.');
    return { collaborationMode: { mode: selected, settings: { model: settings.model, reasoning_effort: settings.effort, developer_instructions: null } } };
  }
  async selectMode(mode) {
    const r = this.runtime;
    if (!r.idle() || this.queue.length || !this.modes.some(value => value.mode === mode)) throw new Error('Finish work and clear the queue before choosing an available mode.');
    this.busy = true; this.modeError = ''; r.changed();
    try {
      const model = r.model || r.effective?.model;
      if (!model) throw new Error('Choose a model before changing mode.');
      await r.rpc('thread/settings/update', { threadId: r.threadId, collaborationMode: { mode, settings: { model, reasoning_effort: r.session.effort || null, developer_instructions: null } } });
      this.modeIntent = mode; this.modeEffective = mode;
    } catch (error) { this.modeError = error.message; throw error; }
    finally { this.busy = false; r.changed(); }
  }
  observe(method, p) {
    if (method === 'thread/settings/updated' && ['plan', 'default'].includes(p.threadSettings?.collaborationMode?.mode)) this.modeEffective = p.threadSettings.collaborationMode.mode;
    if (method === 'thread/tokenUsage/updated') {
      const native = p.tokenUsage || {}, project = value => value ? Object.fromEntries(['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'].map(key => [key, count(value[key])])) : null;
      this.usage = { last: project(native.last), total: project(native.total), capacity: count(native.modelContextWindow), model: this.runtime.model || this.runtime.effective?.model || null };
    }
    if (method === 'account/rateLimits/updated') this.readLimits(p);
  }
  readLimits(result) {
    const source = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length ? Object.entries(result.rateLimitsByLimitId) : result.rateLimits ? [['codex', result.rateLimits]] : [];
    const window = value => value ? { usedPercent: count(value.usedPercent), minutes: count(value.windowDurationMins), resetsAt: count(value.resetsAt) } : null;
    this.limits = source.map(([id, value]) => ({ id, label: shorten(value.limitName || id), primary: window(value.primary), secondary: window(value.secondary) }));
  }
  async refreshLimits() { this.readLimits(await this.runtime.rpc('account/rateLimits/read', {})); this.runtime.changed(); return { available: !!this.limits?.length }; }
  validate(text, paths, hasContext = false) {
    if (typeof text !== 'string' || text.length > 64000 || !text.trim() && !paths.length && !hasContext) throw new Error('Enter a message or attach a file.');
    if (/^\s*\//.test(text)) throw new Error('Use CLI mode for native slash commands.');
  }
  enqueue(text, requestId) {
    const r = this.runtime;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) throw new Error('A queue request identity is required.');
    if (this.receipts.includes(requestId)) return { queued: true, alreadyRecorded: true };
    if (r.closed || !r.initialized || r.capabilitiesPending || r.uncertain || r.operations.busy || r.permissions.busy || r.permissions.uncertain || this.busy || this.steering || r.sandbox.settingUp || this.queue.length >= 20) throw new Error('Resolve the current connection/request or queue limit before adding a message.');
    const paths = [...r.attachments]; this.validate(text, paths);
    this.queue.push({ id: randomUUID(), requestId, text, paths, settings: this.settings(), state: 'queued', createdAt: Date.now() });
    this.receipts.push(requestId); this.receipts = this.receipts.slice(-100);
    if (r.draft === text) r.draft = ''; r.attachments = r.attachments.filter(file => !paths.includes(file)); r.changed();
    this.schedule(); return { queued: true };
  }
  edit(id, text) {
    const entry = this.queue.find(value => value.id === id);
    if (!entry || entry.state !== 'queued' || entry.id === this.dispatching) throw new Error('Only an unsent queued message can be edited.');
    this.validate(text, entry.paths); entry.text = text; this.runtime.changed(); return { edited: true };
  }
  cancel(id) {
    const entry = this.queue.find(value => value.id === id);
    if (!entry || entry.state !== 'queued' || entry.id === this.dispatching) throw new Error('This message may already be delivered. Check delivery before changing it.');
    this.queue = this.queue.filter(value => value.id !== id); this.runtime.changed(); return { cancelled: true };
  }
  pause(paused) {
    if (typeof paused !== 'boolean') throw new Error('Choose pause or resume.');
    if (!paused && (this.runtime.uncertain || this.queue.some(value => value.state !== 'queued'))) throw new Error('Check uncertain delivery before resuming the queue.');
    this.paused = paused; this.queueNotice = paused ? 'Queue paused.' : ''; this.runtime.changed(); if (!paused) this.schedule(); return { paused };
  }
  schedule() {
    // The microtask rechecks ownership/state; completion notifications never resend.
    queueMicrotask(() => { void this.drain().catch(error => { this.paused = true; this.runtime.reportError(error); this.runtime.changed(); }); });
  }
  async drain() {
    const r = this.runtime;
    if (this.paused || this.dispatching || !this.queue.length || !r.idle()) return;
    const entry = this.queue[0];
    if (entry.state !== 'queued' || JSON.stringify(entry.settings) !== JSON.stringify(this.settings())) { this.paused = true; this.queueNotice = 'Saved settings differ. Remove and re-add unsent messages with the current settings.'; r.changed(); return; }
    this.dispatching = entry.id; entry.state = 'sending'; r.changed();
    try { await r.submit(entry.text, { queuedId: entry.id, paths: entry.paths }); this.queue = this.queue.filter(value => value.id !== entry.id); }
    catch (error) { this.paused = true; this.queueNotice = 'Queue paused after a delivery error. Check delivery before continuing.'; entry.state = r.uncertain ? 'uncertain' : 'queued'; throw error; }
    finally { this.dispatching = null; r.changed(); if (!this.paused) this.schedule(); }
  }
  completed(status) {
    if (status !== 'completed' && this.queue.length) { this.paused = true; this.queueNotice = `Queue paused after ${status}.`; }
    else if (status === 'completed') this.schedule();
  }
  confirmed(queueId) {
    if (queueId) { this.queue = this.queue.filter(entry => entry.id !== queueId); this.paused = true; this.queueNotice = 'Delivery confirmed. Review the remaining queue before resuming.'; }
  }
  async steer(text, expectedTurnId) {
    if (this.runtime.verifyIdentity) await this.runtime.verifyIdentity();
    const r = this.runtime, paths = [...r.attachments], context = [...r.composer.items]; this.validate(text, paths, !!context.length);
    if (!this.supportsSteer || !r.turnId || expectedTurnId !== r.turnId || r.interrupting || r.submitting || r.closed || r.uncertain || r.operations.busy || r.permissions.busy || r.permissions.uncertain || r.requests.size || this.steering || this.busy) throw new Error('The active turn changed or is waiting. Refresh before sending guidance.');
    const revision = r.draftRevision, draft = r.draft;
    this.steering = true; r.changed();
    try {
      const nativeInput = context.length || skillMentions(text).length ? await r.composer.input(text, paths, context) : input(text, paths);
      if (r.turnId !== expectedTurnId || r.interrupting || r.requests.size || r.closed) throw Object.assign(new Error('The active turn changed while preparing context. Nothing was sent.'), { nativeRejected: true });
      r.submission = { kind: 'steer', turnId: expectedTurnId, at: Date.now(), text: nativeInput[0].text, knownItems: [...r.items.keys()] };
      const result = await r.rpc('turn/steer', { threadId: r.threadId, expectedTurnId, input: nativeInput, clientUserMessageId: randomUUID() });
      if (result.turnId !== expectedTurnId) throw Object.assign(new Error('Codex did not confirm guidance for the expected turn. Nothing was resent.'), { uncertain: true });
      if (revision === r.draftRevision && r.draft === draft) r.draft = '';
      r.attachments = r.attachments.filter(file => !paths.includes(file)); r.composer.consumed(context); return { steered: true, turnId: expectedTurnId };
    } catch (error) { r.uncertain = !error.nativeRejected; r.reportError(error); if (r.uncertain) this.paused = true; else await r.refreshActiveTurn().catch(() => {}); throw error; }
    finally { this.steering = false; r.changed(); }
  }
  save() { const uncertain = this.runtime.uncertain || this.queue.some(entry => entry.state !== 'queued'); return { operation: this.runtime.operations.save(), modeIntent: this.modeIntent || this.modeEffective, queue: this.queue, receipts: this.receipts, uncertain, submission: uncertain ? this.runtime.submission : null }; }
  restore(saved) {
    this.runtime.operations.restore(saved?.operation);
    if (this.modes.some(mode => mode.mode === saved?.modeIntent)) this.modeIntent = saved.modeIntent;
    const identity = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(value);
    const ids = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length <= 200).slice(-1000) : [];
    this.receipts = Array.isArray(saved?.receipts) ? saved.receipts.filter(identity).slice(-100) : [];
    this.queue = Array.isArray(saved?.queue) ? saved.queue.filter(entry => entry && identity(entry.id) && identity(entry.requestId) && typeof entry.text === 'string' && entry.text.length <= 64000 && Array.isArray(entry.paths) && entry.paths.length <= 100 && entry.paths.every(file => typeof file === 'string' && path.isAbsolute(file)) && entry.settings && ['account', 'model', 'effort', 'permissions', 'mode'].every(key => entry.settings[key] == null || typeof entry.settings[key] === 'string' && entry.settings[key].length <= 200) && ['queued', 'sending', 'uncertain'].includes(entry.state)).slice(0, 20).map(entry => ({ id: entry.id, requestId: entry.requestId, text: entry.text, paths: entry.paths, settings: Object.fromEntries(['account', 'model', 'effort', 'permissions', 'mode'].map(key => [key, entry.settings[key] ?? null])), createdAt: count(entry.createdAt), state: entry.state === 'queued' ? 'queued' : 'uncertain' })) : [];
    if (this.queue.length) { this.paused = true; this.queueNotice = 'Restored paused. Review messages before resuming.'; }
    const submission = saved?.submission;
    if (saved?.uncertain && submission && typeof submission.text === 'string' && submission.text.length <= 1000000 && Number.isFinite(submission.at)) {
      this.runtime.uncertain = true;
      this.runtime.submission = { text: submission.text, at: submission.at, kind: submission.kind === 'steer' ? 'steer' : 'send', turnId: typeof submission.turnId === 'string' ? submission.turnId.slice(0, 200) : null, queueId: identity(submission.queueId) ? submission.queueId : null, knownTurns: ids(submission.knownTurns), knownItems: ids(submission.knownItems) };
    }
  }
  snapshot() { return { operation: this.runtime.operations.snapshot(), operationBusy: this.runtime.operations.busy, modes: this.modes, mode: this.modeIntent || this.modeEffective, modeEffective: this.modeEffective, modeError: this.modeError, configuring: this.busy || this.runtime.operations.busy, steering: this.steering, supportsSteer: this.supportsSteer, usage: this.usage, limits: this.limits, queue: this.queue, queuePaused: this.paused, queueNotice: this.queueNotice }; }
}
