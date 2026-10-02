import { createHash } from 'node:crypto';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

// Private, invocation-local fingerprints. Neither definitions nor credentials
// are exposed in chat metadata or copied into portable archives.
export function mcpSnapshot(scan, agent) {
  if (scan.public.problems.length) throw new Error('MCP configuration cannot be read safely.');
  return Object.fromEntries([...scan.raw].filter(([, entry]) => entry.data.client === agent && entry.data.name !== 'mrmak_workspace').map(([id, entry]) => {
    const { enabled, disabled, ...definition } = entry.config;
    void enabled; void disabled;
    return [id, { name: entry.data.name, enabled: entry.data.enabled, plugin: !!entry.data.plugin, definition: hash([definition, entry.headers, entry.cwd, entry.command, entry.env, entry.data.readiness === 'approval']) }];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

export function changedMcps(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(id => {
    const a = before[id], b = after[id];
    if (!a?.enabled && !b?.enabled) return false;
    return a?.enabled !== b?.enabled || a?.definition !== b?.definition;
  });
}

// Require the cursor to be in the current empty composer, never an old prompt
// found in scrollback. Unrecognised layouts remain manual, not guessed.
export function emptyNativePrompt(session) {
  const terminal = session.terminal, buffer = terminal?.buffer.active;
  if (!buffer || buffer.type !== 'normal') return false;
  const row = buffer.baseY + buffer.cursorY;
  const text = buffer.getLine(row)?.translateToString(true) || '';
  const pattern = session.agent === 'codex' ? /^\s*›\s*(?:Ask Codex to do anything|Ask for follow-up|Ask a follow-up)?\s*$/ : /^\s*❯\s*$/;
  if (!pattern.test(text)) return false;
  // Wrapped/multiline drafts cannot be classified from one empty line.
  const next = buffer.getLine(row + 1);
  if (next?.isWrapped || buffer.getLine(row)?.isWrapped) return false;
  for (let index = row + 1; index < Math.min(buffer.length, row + 6); index++) {
    const line = buffer.getLine(index)?.translateToString(true).trim() || '';
    if (/^(?:[─━═]+|GPT-|gpt-|\? for shortcuts|.*context left)/.test(line)) break;
    if (line) return false;
  }
  return true;
}

export class ToolRefresh {
  constructor(sessions, { snapshot, ready, live, restart, delay = 1200 }) {
    Object.assign(this, { sessions, snapshot, ready, live, restart, delay });
    this.baselines = new Map(); this.pending = new Map(); this.busy = new Set(); this.closed = false;
    this.timer = setInterval(() => void this.poll(), delay); this.timer.unref();
  }
  async capture(session) {
    if (!['codex', 'claude', 'opencode'].includes(session.agent)) return null;
    try { return await this.snapshot(session); } catch { return null; }
  }
  launched(session, baseline) {
    this.baselines.set(session.id, baseline); this.pending.delete(session.id);
    session.toolRefresh = null; this.sessions.changed(session);
  }
  state(session, status, reason, automatic = false) {
    session.toolRefresh = { status, reason, automatic };
    this.sessions.changed(session);
  }
  // Wrap the shared editors, so UI, Bridge and coordinator writes follow the
  // same path. Hub Bridge switches deliberately do not use this scheduler.
  wrap(editor, method, accepts) {
    const original = editor[method].bind(editor);
    editor[method] = async (...args) => {
      const result = await original(...args);
      if (accepts(...args)) {
        await this.scan();
        return { ...result, applies: 'Configuration saved. Affected open chats update when safe; check their configuration update status.' };
      }
      return result;
    };
  }
  async scan() {
    if (this.closed) return;
    for (const session of this.sessions.items.values()) {
      if (!session.open || !session.process || !['codex', 'claude', 'opencode'].includes(session.agent) || this.busy.has(session.id)) continue;
      try {
        const desired = await this.snapshot(session), baseline = this.baselines.get(session.id);
        if (!baseline) { this.pending.set(session.id, { desired, automatic: false }); this.state(session, 'pending', 'Live configuration is unknown. Apply manually from an idle, empty prompt.'); continue; }
        const changes = changedMcps(baseline, desired);
        if (!changes.length) { this.pending.delete(session.id); if (session.toolRefresh && session.toolRefresh.status !== 'applied') { session.toolRefresh = null; this.sessions.changed(session); } continue; }
        // A second settings write supersedes the target, not the launch baseline.
        const automatic = session.activity === 'idle';
        this.pending.set(session.id, { desired, changes, automatic });
        this.state(session, 'pending', automatic ? 'Chat configuration changed. Waiting for an idle, empty prompt.' : 'Chat configuration changed during a request. Apply after it finishes.', automatic);
      } catch { this.pending.set(session.id, { automatic: false }); this.state(session, 'failed', 'Chat configuration could not be read safely. Repair it, then retry.'); }
    }
  }
  async poll() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try { for (const [id, job] of [...this.pending]) {
      if (!this.sessions.items.get(id)?.open) { this.pending.delete(id); this.baselines.delete(id); continue; }
      if (job.automatic && this.pending.get(id) === job && !this.busy.has(id)) await this.apply(id, false);
    } }
    finally { this.polling = false; }
  }
  async apply(id, manual = true) {
    const session = this.sessions.get(id), job = this.pending.get(id);
    if (this.closed || !job || this.busy.has(id)) return { applied: false };
    if (!session.open || !session.process) { this.pending.delete(id); return { applied: false }; }
    if (session.activity !== 'idle' || session.stopping || session.toolUpdating) return { applied: false, pending: true };
    this.busy.add(id);
    let completed = false;
    const proc = session.process, inputAt = session.lastInputAt;
    try {
      if (!await this.ready(session) || session.process !== proc || session.lastInputAt !== inputAt || session.activity !== 'idle') {
        job.automatic = false;
        this.state(session, 'pending', 'Finish the current request, clear the draft and close native menus before applying.');
        return { applied: false, pending: true };
      }
      const desired = await this.snapshot(session), baseline = this.baselines.get(id);
      const changes = baseline ? changedMcps(baseline, desired) : null;
      if (changes?.length === 0) { this.pending.delete(id); session.toolRefresh = null; this.sessions.changed(session); return { applied: false }; }
      if (this.closed || !session.open || session.process !== proc || session.lastInputAt !== inputAt || session.activity !== 'idle') return { applied: false, pending: true };
      this.state(session, 'applying', 'Applying native tools and skills to this conversation.');
      const liveChanges = changes?.map(key => ({ before: baseline[key], after: desired[key] }));
      const livePossible = session.agent === 'opencode' && session.liveMcpAvailable !== false && liveChanges?.length <= 32 && liveChanges?.every(({ before, after }) => before && !before.kind && !after?.kind && !before.plugin && !after?.plugin && (!after || before.definition === after.definition));
      if (livePossible) {
        await this.live(session, liveChanges.map(({ before, after }) => ({ name: before.name, enabled: !!after?.enabled })));
        this.baselines.set(id, desired);
      } else {
        if (!session.nativeId || !session.hasConversation) {
          job.automatic = false; this.state(session, 'pending', 'No saved native conversation ID yet. Submit your first message or reconnect it before applying.');
          return { applied: false, pending: true };
        }
        await this.restart(session, { process: proc, inputAt });
      }
      this.pending.delete(id); this.state(session, 'applied', livePossible ? 'MCP connections updated without restarting.' : 'CLI resumed the same conversation with current native configuration. Native permissions still apply.');
      // Catch writes made during an asynchronous refresh without losing them.
      completed = true;
      return { applied: true, mode: livePossible ? 'live' : 'resume' };
    } catch (error) {
      job.automatic = false;
      this.state(session, 'failed', 'Update was not confirmed. Inspect the terminal and retry manually; no automatic retry loop.');
      if (manual) throw error;
      return { applied: false, failed: true };
    } finally { this.busy.delete(id); if (completed) await this.scan(); }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
