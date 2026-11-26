import { projectChatItem } from './codex-chat-items.mjs';

const clip = value => String(value ?? '').slice(0, 8000);
const active = operation => operation && ['starting', 'running', 'uncertain'].includes(operation.status);

// Explicit operations on the managed thread only. Never retries model work.
export class CodexChatOperations {
  constructor(runtime) { this.runtime = runtime; this.operation = null; this.agentCache = new Map(); }
  get busy() { return !!this.inflight || !!active(this.operation); }
  observeAgent(message) {
    const p = message.params || {}, id = p.threadId || p.thread?.id;
    if (!this.agentIds().has(id)) return;
    const status = message.method === 'thread/status/changed' ? p.status : message.method === 'thread/started' ? p.thread?.status : null;
    if (!status?.type) return;
    const cached = this.agentCache.get(id)?.metadata;
    this.cacheAgent(id, { status, agentNickname: p.thread?.agentNickname || cached?.name, agentRole: p.thread?.agentRole || cached?.role });
    this.runtime.changed();
  }
  observe(method, p) {
    if (method === 'thread/settings/updated') { this.settings = p.threadSettings; this.settingsObserved?.(p.threadSettings); }
    const op = this.operation;
    if (!active(op)) return;
    if (method === 'turn/started' && !op.before.includes(p.turn.id)) {
      op.turnId ||= p.turn.id; op.status = 'running'; op.message = op.kind === 'compact' ? 'Compacting context…' : 'Reviewing changes…';
    }
    if (method === 'turn/completed' && p.turn.id === op.turnId) {
      op.status = p.turn.status; op.message = p.turn.status === 'completed' ? `${op.kind === 'compact' ? 'Context compaction' : 'Review'} completed.` : `${op.kind === 'compact' ? 'Compaction' : 'Review'} ${p.turn.status}.`;
    }
  }
  target(value) {
    if (value?.type === 'uncommittedChanges') return { type: value.type };
    if (value?.type === 'baseBranch' && typeof value.branch === 'string' && value.branch.trim() && value.branch.length <= 200 && !/[\r\n\0]/.test(value.branch)) return { type: value.type, branch: value.branch.trim() };
    if (value?.type === 'commit' && typeof value.sha === 'string' && /^[a-f0-9]{7,64}$/i.test(value.sha)) return { type: value.type, sha: value.sha };
    throw new Error('Choose working changes, a base branch, or a commit hash to review.');
  }
  async start(kind, target) {
    const r = this.runtime;
    await r.verifyIdentity?.();
    if (!['compact', 'review'].includes(kind)) throw new Error('Unknown chat operation.');
    const reviewTarget = kind === 'review' ? this.target(target) : null;
    if (!r.ready()) throw new Error('Finish work and send or clear your draft and attachments first.');
    if (r.sandboxRequired() && (['notConfigured', 'updateRequired'].includes(r.sandbox.status) || r.sandbox.restartRequired)) throw new Error('Prepare the sandbox before starting this operation.');
    const op = this.operation = { kind, status: 'starting', turnId: null, before: [...r.turns.keys()], message: 'Preparing operation…' };
    this.inflight = true; r.changed();
    let submitted = false;
    try {
      // Ordinary turns carry these overrides, but native review/compact do not.
      // Scope the same choices to this thread, leaving native global config alone.
      const model = r.model || r.effective?.model, effort = r.session.effort || null;
      if (!model) throw new Error('Choose an available model first.');
      let timer;
      const confirmed = new Promise((resolve, reject) => {
        this.settingsObserved = settings => { if (settings?.model === model && (!effort || settings.effort === effort)) resolve(); };
        this.settingsObserved(this.settings);
        timer = setTimeout(() => reject(new Error('Codex did not confirm the selected model and reasoning. No operation was started.')), 5000);
      });
      try { await Promise.all([confirmed, r.rpc('thread/settings/update', { threadId: r.threadId, model, effort })]); }
      finally { clearTimeout(timer); this.settingsObserved = null; }
      if (r.closed || r.turnId || r.nativeActive || r.requests.size || r.permissions.busy || r.permissions.uncertain) throw new Error('The chat changed before starting the operation.');
      op.message = kind === 'compact' ? 'Waiting for context compaction…' : 'Waiting for review…';
      op.submittedAt = Date.now();
      submitted = true;
      const result = await r.rpc(kind === 'compact' ? 'thread/compact/start' : 'review/start', { threadId: r.threadId, ...(reviewTarget ? { target: reviewTarget, delivery: 'inline' } : {}) });
      if (kind === 'review') {
        if (result.reviewThreadId !== r.threadId || !result.turn?.id || !['inProgress', 'completed', 'interrupted', 'failed'].includes(result.turn.status) || op.before.includes(result.turn.id) || op.turnId && op.turnId !== result.turn.id) throw new Error('Codex did not confirm a review in this conversation.');
        op.turnId ||= result.turn.id;
        if (active(op) && !r.finishedTurns.has(result.turn.id)) {
          r.rememberTurn(result.turn, true);
          if (result.turn.status === 'inProgress') { r.turnId = result.turn.id; r.nativeActive = true; op.status = 'running'; }
          else { op.status = result.turn.status; op.message = `Review ${result.turn.status}.`; }
        }
      }
      return { accepted: true, operation: this.snapshot() };
    } catch (error) {
      if (active(op)) { op.status = submitted && !error.nativeRejected ? 'uncertain' : 'failed'; op.message = op.status === 'uncertain' ? 'Operation outcome unconfirmed. Check status before starting other work; nothing will be resent.' : clip(error.message); }
      throw error;
    } finally { this.inflight = false; r.changed(); }
  }
  async check() {
    const r = this.runtime;
    if (!this.busy) return this.snapshot();
    if (this.inflight) throw new Error('Wait for Codex to acknowledge the operation before checking its status.');
    const op = this.operation, version = r.nativeStateVersion;
    const result = await r.rpc('thread/read', { threadId: r.threadId, includeTurns: false });
    if (result.thread?.id !== r.threadId) throw new Error('Codex did not confirm this conversation.');
    if (op !== this.operation || version !== r.nativeStateVersion) return this.snapshot();
    const status = result.thread.status?.type;
    if (status === 'idle' && this.busy && (op.status === 'uncertain' || op.turnId || Date.now() - op.submittedAt > 5000)) {
      // Idle proves that work is no longer running, not that it succeeded.
      this.operation.status = 'unconfirmed'; this.operation.message = 'Codex is idle. The operation outcome could not be confirmed; inspect the conversation. Nothing was resent.';
      r.turnId = null; r.nativeActive = false;
    }
    r.changed(); return this.snapshot();
  }
  snapshot() { if (!this.operation) return null; const { before, ...value } = this.operation; void before; return { ...value }; }
  dismiss() { if (this.busy) throw new Error('Wait for the operation outcome first.'); this.operation = null; this.runtime.changed(); return { dismissed: true }; }
  save() { return this.busy ? { kind: this.operation.kind } : null; }
  restore(value) { if (['review', 'compact'].includes(value?.kind)) this.operation = { kind: value.kind, status: 'uncertain', turnId: null, before: [...this.runtime.turns.keys()], message: 'An operation was pending before reconnect. Check status; nothing has been resent.' }; }
  agentIds() {
    return new Set([...this.runtime.items.values(), ...this.runtime.historyItems.values()].flatMap(item => item.agents?.map(agent => agent.id) || []));
  }
  agents() {
    const rows = new Map();
    for (const item of [...this.runtime.historyItems.values(), ...this.runtime.items.values()]) for (const agent of item.agents || []) rows.set(agent.id, { id: agent.id, name: `Agent ${agent.id.slice(0, 8)}`, task: item.tool === 'spawnAgent' ? item.text.slice(0, 4000) : rows.get(agent.id)?.task || '', status: agent.status, message: agent.message, stamp: `${item.id}:${agent.status}:${agent.message}` });
    return [...rows.values()].slice(-40).map(({ stamp, ...agent }) => ({ ...agent, ...(this.agentCache.get(agent.id)?.stamp === stamp ? this.agentCache.get(agent.id).metadata : {}) }));
  }
  get agentsBusy() { return this.agents().some(agent => !['idle', 'completed', 'stopped', 'interrupted', 'shutdown', 'failed', 'errored', 'notFound', 'unavailable'].includes(agent.status)); }
  agentStamp(id) {
    const latest = [...this.runtime.historyItems.values(), ...this.runtime.items.values()].filter(item => item.agents?.some(agent => agent.id === id)).at(-1);
    const agent = latest?.agents.find(agent => agent.id === id);
    return agent ? `${latest.id}:${agent.status}:${agent.message}` : null;
  }
  cacheAgent(id, thread, observedStamp) {
    const latest = [...this.runtime.historyItems.values(), ...this.runtime.items.values()].filter(item => item.agents?.some(agent => agent.id === id)).at(-1);
    const agent = latest?.agents.find(agent => agent.id === id); if (!agent) return;
    if (observedStamp !== undefined && observedStamp !== this.agentStamp(id)) return;
    this.agentCache.set(id, { stamp: `${latest.id}:${agent.status}:${agent.message}`, metadata: { name: clip(thread.agentNickname || `Agent ${id.slice(0, 8)}`).slice(0, 120), role: clip(thread.agentRole).slice(0, 120), status: clip(thread.status?.type || 'unknown') } });
    if (this.agentCache.size > 40) this.agentCache.delete(this.agentCache.keys().next().value);
  }
  async refreshAgentStatuses() {
    await Promise.allSettled(this.agents().map(async agent => {
      const stamp = this.agentStamp(agent.id);
      try { const { thread } = await this.runtime.rpc('thread/read', { threadId: agent.id, includeTurns: false }, 2000); if (thread?.id === agent.id) this.cacheAgent(agent.id, thread, stamp); } catch { /* Unknown child state must not authorize a restart. */ }
    }));
  }
  async readAgent(id) {
    const r = this.runtime;
    if (typeof id !== 'string' || !this.agentIds().has(id) || id === r.threadId) throw new Error('Choose an agent referenced by this conversation.');
    const stamp = this.agentStamp(id);
    const { thread } = await r.rpc('thread/read', { threadId: id, includeTurns: false });
    if (!thread || thread.id !== id) throw new Error('This agent conversation is unavailable.');
    this.cacheAgent(id, thread, stamp);
    let entries;
    if (thread.historyMode === 'paginated') {
      const page = await r.rpc('thread/items/list', { threadId: id, limit: 50, sortDirection: 'desc' });
      entries = [...(page.data || [])].reverse();
    } else {
      const result = await r.rpc('thread/read', { threadId: id, includeTurns: true });
      entries = (result.thread?.turns || []).slice(-10).flatMap(turn => (turn.items || []).map(item => ({ item, turnId: turn.id }))).slice(-50);
    }
    const items = entries.map(entry => { const { fullDetails, ...item } = projectChatItem(entry.item || entry, {}, entry); void fullDetails; return item; });
    return { id, name: clip(thread.agentNickname || 'Agent'), role: clip(thread.agentRole), status: clip(thread.status?.type || 'unknown'), items, limited: true };
  }
}
