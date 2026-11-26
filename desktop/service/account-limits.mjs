import { readClaudeAccountLimits, readCodexAccountLimits } from './account-limit-probes.mjs';

export class AccountLimitsReader {
  constructor({ context, codex = readCodexAccountLimits, claude = readClaudeAccountLimits, now = () => Date.now(), ttl = 30000 } = {}) {
    Object.assign(this, { context, codex, claude, now, ttl }); this.cache = new Map(); this.pending = new Map(); this.controllers = new Set(); this.epoch = 0;
  }
  async read(agent, profileId) {
    if (!['codex', 'claude'].includes(agent)) throw new Error('Unsupported account provider.');
    if (this.closed) return { windows: [], note: 'Account inspection is shutting down.' };
    const epoch = this.epoch;
    let context;
    try { context = await this.context(agent, profileId || 'system'); if (!context) throw new Error(); }
    catch { return { windows: [], note: 'Account unavailable. Check its sign-in and finish any pending account action.' }; }
    if (this.closed) return { windows: [], note: 'Account inspection is shutting down.' };
    if (epoch !== this.epoch) return { windows: [], note: 'Account changed. Read its limits again.' };
    const key = `${agent}:${profileId || 'system'}:${context.directory || context.privateHome}:${context.identityKey || ''}:${epoch}`;
    const previous = this.cache.get(key);
    if (previous && this.now() - previous.checkedAt < previous.ttl) return structuredClone(previous.value);
    if (this.pending.has(key)) return this.pending.get(key);
    const controller = new AbortController(); this.controllers.add(controller);
    const task = (async () => {
      let value, ttl = this.ttl;
      try {
        const report = await this[agent](context, { signal: controller.signal });
        value = { windows: report.windows || [], note: report.note || (report.windows?.length ? 'Reported by the selected native account.' : 'Subscription limits were not reported by this native account.'), updatedAt: this.now(), stale: false };
        if (!value.windows.length) ttl = 5000;
      } catch {
        ttl = 10000;
        value = previous?.value.windows?.length ? { ...previous.value, stale: true, note: 'Native refresh failed. Showing this account’s last reported limits.' } : { windows: [], note: 'Native account limits could not be read. Verify sign-in or try again shortly.' };
      }
      if (epoch !== this.epoch) return { windows: [], note: 'Account changed. Read its limits again.' };
      if (!this.closed) { this.cache.set(key, { value, checkedAt: this.now(), ttl }); if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value); }
      return structuredClone(value);
    })();
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); this.controllers.delete(controller); }
  }
  invalidate() { this.epoch++; this.cache.clear(); for (const controller of this.controllers) controller.abort(); }
  async close() { this.closed = true; for (const controller of this.controllers) controller.abort(); await Promise.allSettled(this.pending.values()); this.cache.clear(); }
}

// A service supplies the independent reader. The fallback supports existing
// embedded callers with an already-connected runtime, without launching work.
export async function accountLimits(sessions, agent, profileId, reader) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('Unsupported account provider.');
  if (reader) return reader.read(agent, profileId);
  const candidates = [...sessions.items.values()].filter(session => session.agent === agent && session.chatInterface === 'chat' && (agent === 'codex' ? profileId && session.accountProfileId === profileId : (session.accountProfileId || 'system') === (profileId || 'system')));
  const runtime = candidates.map(session => session.graphical).find(runtime => runtime?.snapshot().connected);
  if (!runtime) return { windows: [], note: 'Native account inspection is unavailable in this service.' };
  const state = runtime.snapshot();
  let note = '';
  if (state.working || state.configuring || state.uncertain || state.usageRefreshing || state.advanced?.operationBusy) note = 'Last reported limits. Refresh after the current action finishes.';
  else {
    try { if (agent === 'codex') await runtime.advanced.refreshLimits(); else await runtime.refreshUsage(); }
    catch { note = 'Native limits could not be refreshed. Showing the last reported values.'; }
  }
  const latest = runtime.snapshot();
  const windows = agent === 'claude' ? latest.usage?.plan?.available ? latest.usage.plan.windows : [] : (latest.advanced?.limits || []).flatMap(bucket => [bucket.primary, bucket.secondary].filter(Boolean).map(window => ({
    label: `${bucket.label} · ${window.minutes == null ? 'Usage window' : window.minutes >= 60 ? `${window.minutes / 60}h window` : `${window.minutes}m window`}`,
    percent: window.usedPercent, resetsAt: window.resetsAt == null ? null : new Date(window.resetsAt * 1000).toISOString(),
  })));
  return { windows: windows || [], note: note || (windows?.length ? 'Reported by the native account connection.' : 'Subscription limits are unavailable from this native connection.') };
}
