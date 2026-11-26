import path from 'node:path';
import { readJson, saveJson } from './util.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const mid = message => message.info?.id || message.id;
export function nativeTokenUsage(data, models = []) {
  const tokens = data?.info?.tokens;
  const model = data?.info?.model;
  const assistants = data?.messages?.filter(message => (message.info?.role || message.type) === 'assistant') || [];
  const last = assistants.at(-1), latest = last?.info?.tokens || last?.tokens;
  const fields = ['input', 'output'];
  const total = latest && [latest.input, latest.output, latest.cache?.read, latest.cache?.write].every(value => finite(value) !== null) ? latest.input + latest.output + latest.cache.read + latest.cache.write : null;
  const nativeModel = models.find(row => row.providerID === model?.providerID && row.modelID === (model?.id || model?.modelID));
  return { tokens: tokens ? { ...Object.fromEntries(fields.map(key => [key, finite(tokens[key])])), cacheRead: finite(tokens.cache?.read), cacheWrite: finite(tokens.cache?.write) } : null,
    context: total !== null && finite(nativeModel?.contextWindow) > 0 ? { used: total, window: nativeModel.contextWindow, source: 'last native response estimate' } : null,
    agent: typeof data?.info?.agent === 'string' ? data.info.agent.slice(0, 160) : null,
    model: model && { providerID: String(model.providerID || '').slice(0, 192), modelID: String(model.id || model.modelID || '').slice(0, 192), variant: String(model.variant || 'default').slice(0, 64) },
    quota: null };
}

export function compactionOutcome(data, operation, family) {
  const fresh = data.messages.filter(message => !operation.before.includes(mid(message)));
  if (family === 2) {
    const message = fresh.find(message => message.type === 'compaction');
    return message?.status === 'completed' ? 'completed' : message?.status === 'failed' ? 'failed' : null;
  }
  const start = fresh.findIndex(message => message.parts?.some(part => part.type === 'compaction'));
  if (start < 0) return null;
  const summary = fresh.slice(start + 1).find(message => message.info?.role === 'assistant' && message.info.summary === true);
  return summary?.info.error ? 'failed' : summary?.info.time?.completed ? 'completed' : null;
}

export class NativeControls {
  constructor(sessions, picker, history) { Object.assign(this, { sessions, picker, history }); this.busy = new Set(); }
  file(source) { return path.join(this.sessions.stateDir, `native-controls-${source.id}.json`); }
  assertSource(source, launchId) {
    if (source.agent !== 'opencode' || source.chatInterface === 'chat' || source.status !== 'running' || !source.process || !source.openCodeLaunchId || source.openCodeLaunchId !== launchId || source.stopping || source.toolUpdating) throw new Error('The OpenCode terminal changed. Reopen its native controls.');
  }
  async stored(source) {
    const saved = await readJson(this.file(source), null);
    return saved?.nativeId === source.nativeId ? saved : { nativeId: source.nativeId, operation: null, requests: [] };
  }
  async inspect(source, launchId) {
    this.assertSource(source, launchId);
    const process = source.process, nativeId = source.nativeId;
    const receipt = await this.stored(source);
    if (source.activity !== 'idle') return { launchId, operation: receipt.operation ? { requestId: receipt.operation.requestId, status: 'running' } : null, busy: true };
    const controls = await this.picker.command(source.id, 'controls');
    const catalog = await this.picker.command(source.id, 'catalog');
    const data = source.hasConversation ? await this.history.read(this.history.store(source), nativeId) : null;
    this.assertSource(source, launchId);
    if (source.process !== process || source.nativeId !== nativeId || source.activity !== 'idle') throw new Error('The native conversation changed during inspection.');
    if (data && receipt.operation && ['reserved', 'running', 'uncertain'].includes(receipt.operation.status)) {
      const status = compactionOutcome(data, receipt.operation, source.openCodeFamily);
      if (status) { receipt.operation.status = status; await saveJson(this.file(source), receipt); }
    }
    const operation = receipt.operation && { requestId: receipt.operation.requestId, status: ['reserved', 'running'].includes(receipt.operation.status) ? 'uncertain' : receipt.operation.status };
    return { launchId, usage: nativeTokenUsage(data, catalog.models), operation, busy: false,
      agentAvailable: controls.commands?.some(row => row.id === 'agent.list' && row.enabled),
      compactAvailable: !!data && controls.commands?.some(row => row.id === 'session.compact' && row.enabled),
      permissions: 'Permissions follow the selected native agent and native approval dialogs. A separate permission-mode selector is unavailable in this adapter.' };
  }
  async act(source, request) {
    this.assertSource(source, request.launchId);
    if (this.busy.has(source.id)) throw new Error('Wait for the current native control.');
    this.busy.add(source.id);
    source.nativeControlBusy = true;
    try {
      if (request.action === 'inspect') return await this.inspect(source, request.launchId);
      if (!['agent', 'compact', 'dismiss'].includes(request.action)) throw new Error('Unsupported native control.');
      if (source.activity !== 'idle' || source.contextPreparing) throw new Error('Finish native work and dialogs before changing controls.');
      const process = source.process, inputAt = source.lastInputAt, nativeId = source.nativeId;
      const unchanged = () => { this.assertSource(source, request.launchId); if (source.process !== process || source.lastInputAt !== inputAt || source.nativeId !== nativeId || source.activity !== 'idle') throw new Error('The native prompt changed. Reopen controls.'); };
      const receipt = await this.stored(source); unchanged();
      if (request.action === 'dismiss') { receipt.operation = null; await saveJson(this.file(source), receipt); return { dismissed: true }; }
      if (request.action === 'compact') {
        if (!/^[a-f0-9-]{36}$/i.test(request.requestId || '')) throw new Error('A compaction request identity is required.');
        if (receipt.requests.includes(request.requestId)) return { accepted: true, repeated: true };
        if (receipt.operation && ['reserved', 'running', 'uncertain'].includes(receipt.operation.status)) throw new Error('Inspect or clear the previous compaction status first. Nothing will be repeated automatically.');
      }
      await this.picker.command(source.id, 'prepare'); unchanged();
      if (request.action === 'agent') { await this.picker.command(source.id, 'agent'); return { opened: true }; }
      if (!source.hasConversation) throw new Error('There is no native conversation to compact.');
      const data = await this.history.read(this.history.store(source), nativeId); unchanged();
      if (!data || data.messages.length > 50000) throw new Error('Native compaction boundary cannot be inspected.');
      receipt.operation = { requestId: request.requestId, status: 'reserved', before: data.messages.map(mid), launchId: request.launchId };
      receipt.requests = [...receipt.requests, request.requestId].slice(-50);
      await saveJson(this.file(source), receipt); unchanged();
      // Reserve before dispatch. A timeout never retries; only inspect is read-only.
      try { await this.picker.command(source.id, 'compact'); receipt.operation.status = 'running'; }
      catch (error) { receipt.operation.status = 'uncertain'; throw error; }
      finally { await saveJson(this.file(source), receipt); }
      return { accepted: true };
    } finally { this.busy.delete(source.id); source.nativeControlBusy = false; }
  }
}
