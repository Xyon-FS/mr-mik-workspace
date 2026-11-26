import { validateClaudeContext } from './claude-composer.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const active = status => ['sending', 'accepted'].includes(status);
export class ClaudeChatSteering {
  constructor(runtime) { this.runtime = runtime; this.receipts = []; this.cancelled = []; this.operation = null; this.busy = false; this.timeoutMs = 30000; }
  get available() {
    // The native version is returned by initialize, without launching a model.
    const match = /^2\.1\.(\d+)(?:\D|$)/.exec(this.runtime.protocol?.initialization?.claude_code_version || '');
    return !!match && Number(match[1]) >= 311;
  }
  save() { return { receipts: this.receipts, cancelled: this.cancelled, operation: this.operation }; }
  restore(saved) {
    if (!saved) return;
    if (!Array.isArray(saved.receipts) || saved.receipts.length > 1000 || !saved.receipts.every(uuid)) throw new Error('Invalid saved Claude guidance receipts.');
    const op = saved.operation;
    if (op && (!uuid(op.requestId) || !uuid(op.turnId) || !saved.receipts.includes(op.requestId) || typeof op.text !== 'string' || op.text.length > 64000 || !['sending', 'accepted', 'completed', 'failed', 'uncertain', 'cancelled', 'reviewed'].includes(op.status))) throw new Error('Invalid saved Claude guidance operation.');
    this.receipts = saved.receipts;
    if (saved.cancelled != null && (!Array.isArray(saved.cancelled) || saved.cancelled.length > 1000 || !saved.cancelled.every(id => uuid(id) && saved.receipts.includes(id)))) throw new Error('Invalid cancelled Claude guidance receipts.');
    this.cancelled = saved.cancelled || [];
    this.operation = op ? { ...op, context: validateClaudeContext(op.context), status: active(op.status) ? 'uncertain' : op.status } : null;
    if (this.operation?.status === 'uncertain') this.runtime.protocol.state.uncertain = true;
  }
  snapshot() { return { supportsSteer: this.available, steering: this.busy, guidance: this.operation ? { requestId: this.operation.requestId, status: this.operation.status } : null }; }
  assertReady(expectedTurnId) {
    const r = this.runtime;
    if (!this.available || r.closed || !r.initialized || r.protocol.state.status !== 'running' || r.protocol.state.uncertain || r.protocol.state.turns.at(-1)?.id !== expectedTurnId || r.protocol.state.turns.at(-1)?.kind || r.protocol.state.requests.length || r.configuring || r.submitting || r.attachmentUpdating || r.messageActionBusy || r.usageRefreshing || r.pending.busy || r.pending.dispatching || r.session.stopping || r.session.toolUpdating || r.session.switchingInterface) throw new Error('The active Claude turn changed or is waiting. Refresh before sending guidance. Nothing was resent.');
  }
  async steer(text, expectedTurnId, requestId) {
    const r = this.runtime;
    if (!uuid(requestId)) throw new Error('A guidance request identity is required.');
    if (this.receipts.includes(requestId)) {
      const status = this.cancelled.includes(requestId) ? 'cancelled' : this.operation?.requestId === requestId ? this.operation.status : 'recorded';
      return { steered: !['cancelled', 'sending', 'uncertain'].includes(status), alreadyRecorded: true, status };
    }
    if (this.busy || this.receipts.length >= 1000) throw new Error('Finish the guidance operation or start another conversation after the receipt limit.');
    this.assertReady(expectedTurnId);
    const selected = structuredClone(r.attachmentDetails), context = structuredClone(r.composer.items), draft = r.draft, revision = r.draftRevision;
    r.pending.validate(text, selected, context);
    this.busy = true; r.changed(); let reserved = false, sent = false;
    const previous = this.operation;
    try {
      await r.verifyIdentity?.();
      const prepared = await r.composer.input(text, selected, context);
      this.assertReady(expectedTurnId);
      this.operation = { requestId, turnId: expectedTurnId, text, attachments: selected, context, status: 'sending' };
      this.receipts.push(requestId);
      try { await r.pending.save(); reserved = true; }
      catch (error) { this.operation = previous; this.receipts.pop(); throw error; }
      this.assertReady(expectedTurnId);
      const confirmation = new Promise((resolve, reject) => { this.confirm = { resolve, reject }; });
      // Install the rejection handler before the synchronous fixture/native write.
      confirmation.catch(() => {});
      this.timer = setTimeout(() => r.protocol.protocolFailure('Claude guidance receipt timed out. Delivery is uncertain; nothing was resent.'), this.timeoutMs);
      sent = true;
      r.protocol.steer(text, { expectedTurnId, id: requestId, content: prepared.blocks, attachments: prepared.attachments, composerContext: prepared.context });
      await confirmation;
      if (r.draft === draft && r.draftRevision === revision) r.draft = '';
      r.composer.consumed(context);
      const consumed = new Set(selected.map(item => item.path));
      r.attachmentDetails = r.attachmentDetails.filter(item => !consumed.has(item.path)); r.attachments = r.attachmentDetails.map(item => item.path);
      await r.pending.save();
      return { steered: true, requestId, turnId: expectedTurnId };
    } catch (error) {
      if (reserved) {
        this.operation.status = sent ? 'uncertain' : 'cancelled';
        if (!sent) this.cancelled.push(requestId);
        if (sent) { r.pending.paused = true; r.protocol.protocolFailure('Claude guidance delivery is uncertain. Inspect the conversation before continuing.'); }
        await r.pending.save();
      }
      throw error;
    } finally { clearTimeout(this.timer); this.confirm = null; this.busy = false; r.changed(); }
  }
  observeFrame(message) {
    const op = this.operation;
    if (!op || !active(op.status)) return;
    const ids = message.user_message_uuids || [message.user_message_uuid];
    const started = message.type === 'command_lifecycle' && message.command_uuid === op.requestId && ['started', 'completed'].includes(message.state);
    const replay = message.type === 'user' && message.isReplay === true && message.uuid === op.requestId;
    const result = message.type === 'result' && ids.includes(op.requestId);
    if (started || replay || result) {
      op.status = result ? message.is_error || message.subtype !== 'success' ? 'failed' : 'completed' : 'accepted';
      clearTimeout(this.timer); this.confirm?.resolve();
      if (result) void this.runtime.pending.save().catch(() => {
        op.status = 'uncertain'; this.runtime.protocol.protocolFailure('Claude could not save the guidance result. Inspect delivery before continuing.');
      });
    } else if (message.type === 'command_lifecycle' && message.command_uuid === op.requestId && ['refused', 'cancelled'].includes(message.state)) {
      op.status = 'uncertain'; clearTimeout(this.timer); this.confirm?.reject(new Error('Claude cancelled or refused guidance. Inspect delivery; nothing was resent.'));
      this.runtime.pending.paused = true; this.runtime.protocol.protocolFailure('Claude cancelled or refused guidance. Inspect delivery before continuing.');
    }
  }
  observeState(next) {
    if (this.operation && active(this.operation.status) && (next.uncertain || ['disconnected', 'error', 'closed'].includes(next.status))) {
      this.operation.status = 'uncertain'; clearTimeout(this.timer); this.confirm?.reject(new Error('Claude disconnected during guidance. Nothing was resent.'));
    }
  }
  async acknowledge() { if (this.operation?.status === 'uncertain') { this.operation.status = 'reviewed'; try { await this.runtime.pending.save(); } catch (error) { this.operation.status = 'uncertain'; throw error; } } }
  async close() { clearTimeout(this.timer); if (this.operation?.status === 'uncertain') await this.runtime.pending.save(); }
}
