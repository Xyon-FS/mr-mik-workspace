import { skillMentions } from './skill-mentions.mjs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { ClaudeRuntime } from './claude-chat-protocol.mjs';
import { claudeChatTransport } from './claude-chat-transport.mjs';
import { claudeGraphicalCapabilities } from './graphical-capabilities.mjs';
import { readJson, saveJson } from './util.mjs';
import { claudeModelChoices, claudePermissionOptions, knownClaudePermissionModes, claudeEffortNames } from './claude-chat-settings.mjs';
import { inspectClaudeAttachment, validateClaudeAttachments, CLAUDE_OUTPUT_FRAME_CHARS } from './claude-chat-attachments.mjs';
import { ClaudeHistory } from './claude-history.mjs';
import { ClaudeHistorySearch } from './claude-history-search.mjs';
import { claudeDisplayItem } from './claude-history-projection.mjs';
import { ClaudeComposer } from './claude-composer.mjs';
import { modelTokens, contextUsage, planUsage } from './claude-usage.mjs';
import { ClaudeChatQueue } from './claude-chat-queue.mjs';
import { ClaudeChatSteering } from './claude-chat-steering.mjs';
import { projectResultContent } from './chat-result-content.mjs';
import { ClaudeSubagents } from './claude-subagents.mjs';
import { claudeChanges, reviewDraft } from './claude-changes.mjs';

const working = status => ['running', 'waiting', 'stopping'].includes(status);
const status = value => value === 'running' ? 'inProgress' : value;
function boundedTail(items, budget) {
  const result = []; let bytes = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const size = Buffer.byteLength(JSON.stringify(items[index]));
    if (bytes + size > budget) break;
    result.push(items[index]); bytes += size;
  }
  return result.reverse();
}

export class ClaudeChat extends EventEmitter {
  constructor({ session, stateDir, env, bridge, browser, transportFactory, shutdownMs, spawnChild }) {
    super(); Object.assign(this, { session, stateDir, env, bridge, browser, transportFactory, shutdownMs, spawnChild });
    this.runtimeId = randomUUID(); this.revision = 0; this.draft = ''; this.draftRevision = 0;
    this.closed = false; this.initialized = false; this.previewPaths = new Set();
    this.attachments = []; this.attachmentDetails = []; this.submitting = false; this.attachmentUpdating = false;
    this.history = new ClaudeHistory(this);
    this.usage = { tokens: null, context: null, plan: { available: false, windows: [] }, updatedAt: null, error: '' };
    this.composer = new ClaudeComposer(this);
    this.historySearch = new ClaudeHistorySearch(this); this.loadedHistory = new Map(); this.historyMetadata = new Map();
    // Older preview History stored only bypass. Preserve that explicit launch
    // authorization even if an earlier metadata projection defaulted the new bit.
    session.claudeBypassAllowed = session.claudeBypassAllowed === true || session.bypass === true;
    session.claudePermissionMode ??= session.bypass ? 'bypassPermissions' : 'default';
    this.buildPermissionMode = session.claudePermissionMode === 'plan' ? 'default' : session.claudePermissionMode;
    this.file = path.join(stateDir, `claude-chat-${session.id}.json`);
    this.pending = new ClaudeChatQueue(this);
    this.steering = new ClaudeChatSteering(this);
    this.resultAssets = new Map();
    this.subagents = new ClaudeSubagents(this);
  }
  changed() { this.revision++; this.emit('change'); this.pending?.schedule(); }
  ready() { return this.idle() && !this.subagents.hasActive && !this.pending.pending && !this.draft.trim() && !this.attachments.length && !this.composer.items.length; }
  idle() { return this.initialized && !this.closed && this.protocol.state.status === 'ready' && !this.protocol.state.uncertain && !this.identityChecking && !this.configuring && !this.submitting && !this.attachmentUpdating && !this.messageActionBusy && !this.usageRefreshing && !this.pending.busy && !this.pending.dispatching && !this.steering.busy; }
  onExit(callback) { this.on('exit', callback); return { dispose: () => this.off('exit', callback) }; }
  resize() {}
  write() { throw new Error('Use the graphical composer for this chat.'); }
  async start(resumeId, fork = false, boundary) {
    if (fork) throw new Error('Claude graphical branching is not available yet. Use a CLI chat to fork.');
    if (!/^[a-f0-9-]{36}$/i.test(this.session.nativeId || '')) throw new Error('Invalid Claude conversation ID.');
    const info = await lstat(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 12_000_000)) throw new Error('Saved Claude display state is unavailable or too large.');
    const saved = info ? await readJson(this.file, null) : null;
    if (info && !saved) throw new Error('Saved Claude display state is unreadable. The file has been preserved.');
    if (saved && (saved.nativeId !== this.session.nativeId || saved.repo !== this.stateDir)) throw new Error('Saved Claude history belongs to a different conversation or Hub.');
    if (claudePermissionOptions(this.session.claudeBypassAllowed).some(mode => mode.value !== 'plan' && mode.value === saved?.buildPermissionMode) || saved?.buildPermissionMode === 'auto') this.buildPermissionMode = saved.buildPermissionMode;
    const nativePage = resumeId && this.session.hasConversation && (!saved || boundary?.offset > 0) && !boundary?.providerSeed ? await this.history.page() : null;
    if (this.closed) throw new Error('Claude chat closed during startup.');
    this.transport = this.transportFactory ? { factory: this.transportFactory, close: async () => {} } : claudeChatTransport({ session: this.session, env: this.env, bridge: this.bridge, browser: this.browser, resumeId: this.session.hasConversation ? resumeId : null, resumePath: boundary?.file || boundary?.providerSeed?.nativeFile, spawnChild: this.spawnChild, shutdownMs: this.shutdownMs });
    this.protocol = new ClaudeRuntime(this.transport.factory, { timeoutMs: 30000, maxFrameChars: CLAUDE_OUTPUT_FRAME_CHARS });
    this.protocol.observeSubagent = message => this.subagents.observe(message);
    this.protocol.steerObserver = message => this.steering.observeFrame(message);
    this.protocol.toolResult = (item, block, metadata) => {
      item.changes = claudeChanges(item, block, metadata, this.session.cwd);
      if (['Agent', 'Task'].includes(item.tool)) return block.is_error ? 'Subagent failed. See the Subagents panel for recorded activity.' : metadata?.tool_use_result?.isAsync ? 'Subagent started in background.' : 'Subagent result received. See the Subagents panel.';
      return this.toolResult(item, block);
    };
    this.protocol.state.sessionId = this.session.nativeId;
    if (saved && saved.nativeId === this.session.nativeId && saved.repo === this.stateDir) {
      this.subagents.restore(saved.subagents);
      this.hasOlder = !!saved.hasOlder;
      const state = saved.state;
      if (!state || !Array.isArray(state.items) || state.items.length > 2000 || !Array.isArray(state.turns) || state.turns.length > 2000) throw new Error('Invalid saved Claude display state.');
      this.protocol.state.items = state.items;
      for (const item of [...(Array.isArray(saved.historyMetadata) ? saved.historyMetadata.slice(-2000) : []), ...state.items]) if (item?.type === 'userMessage' && typeof item.id === 'string' && (!item.attachments || Array.isArray(item.attachments) && item.attachments.length <= 20)) this.historyMetadata.set(item.id, item);
      this.protocol.state.turns = state.turns;
      this.protocol.state.compaction = state.compaction ? { ...state.compaction, ...(state.compaction.status === 'running' ? { status: 'uncertain' } : {}) } : null;
      this.protocol.state.compactionRequests = Array.isArray(state.compactionRequests) ? state.compactionRequests.slice(-50) : [];
      this.protocol.state.uncertain = !!state.uncertain || working(state.status);
      for (const turn of state.turns) if (turn.completedAt == null) { turn.completedAt = Date.now(); turn.status = 'uncertain'; }
      this.draft = typeof saved.draft === 'string' ? saved.draft.slice(0, 64000) : '';
      this.composer.restore(saved.composerContext);
      this.attachmentDetails = Array.isArray(saved.attachments) ? saved.attachments.filter(item => item && typeof item.path === 'string' && path.isAbsolute(item.path) && item.path.length <= 8192 && typeof item.resolvedPath === 'string' && path.isAbsolute(item.resolvedPath) && ['image', 'file', 'folder'].includes(item.kind)).slice(0, 20) : [];
      this.attachments = this.attachmentDetails.map(item => item.path);
      for (const file of Array.isArray(saved.previewPaths) ? saved.previewPaths.slice(-500) : []) if (typeof file === 'string' && path.isAbsolute(file) && !/[\x00-\x1f]/.test(file)) this.previewPaths.add(file);
    }
    if (nativePage) {
      const observed = new Map(this.protocol.state.items.map(item => [item.id, item]));
      // Preserve original local attachment metadata and observed timing where it
      // matches a native ID; never infer a local path from embedded image bytes.
      const merged = nativePage.items.map(item => observed.get(item.id) || item);
      const nativeIds = new Set(merged.map(item => item.id));
      const pendingTurns = new Set(this.protocol.state.turns.filter(turn => turn.status === 'uncertain').map(turn => turn.id));
      const unsaved = this.protocol.state.items.filter(item => !nativeIds.has(item.id) && pendingTurns.has(item.turnId));
      // A saved delivery may not yet have reached the native file. Keep its
      // latest observed window and uncertainty instead of silently dropping it.
      this.protocol.state.items = [...merged, ...unsaved].slice(-2000);
      const turns = new Map([...nativePage.turns, ...this.protocol.state.turns].map(turn => [turn.id, turn]));
      this.protocol.state.turns = [...turns.values()].filter(turn => this.protocol.state.items.some(item => item.turnId === turn.id));
      this.hasOlder = nativePage.hasOlder;
    }
    if (boundary?.providerSeed) {
      if (claudePermissionOptions(this.session.claudeBypassAllowed).some(mode => mode.value !== 'plan' && mode.value === boundary.providerSeed.buildPermissionMode) || boundary.providerSeed.buildPermissionMode === 'auto') this.buildPermissionMode = boundary.providerSeed.buildPermissionMode;
      this.protocol.state = structuredClone(boundary.providerSeed.state);
      this.protocol.state.sessionId = this.session.nativeId; this.protocol.state.status = 'closed';
      this.draft = boundary.providerSeed.draft;
      this.composer.restore(boundary.providerSeed.composerContext);
      this.attachmentDetails = structuredClone(boundary.providerSeed.attachments);
      this.attachments = this.attachmentDetails.map(item => item.path);
      this.previewPaths = new Set(boundary.providerSeed.previewPaths);
    }
    for (const item of this.attachmentDetails) if (!await lstat(item.path).catch(() => null)) item.unavailable = true;
    await this.pending.restore();
    this.previous = this.protocol.snapshot();
    this.protocol.subscribe(next => {
      const before = this.previous; this.previous = next;
      this.pending.observe(before, next);
      this.steering.observeState(next);
      if (next.usageTokens) this.usage.tokens = next.usageTokens;
      if (next.compaction?.status !== 'running') clearTimeout(this.compactTimer);
      if (knownClaudePermissionModes.includes(next.permissionMode)) {
        this.session.claudePermissionMode = next.permissionMode;
        this.session.bypass = next.permissionMode === 'bypassPermissions';
        if (next.permissionMode !== 'plan') this.buildPermissionMode = next.permissionMode;
      }
      if (!working(before.status) && working(next.status)) this.emit('native', { kind: 'turn-started' });
      if (next.status === 'waiting') this.emit('native', { kind: 'attention' });
      else if (before.status === 'waiting' && working(next.status)) this.emit('native', { kind: 'turn-started' });
      const turn = next.turns.at(-1), old = before.turns.at(-1);
      if (turn?.completedAt && !old?.completedAt) {
        const preview = next.items.filter(item => item.turnId === turn.id && item.type === 'agentMessage').at(-1)?.text.slice(0, 350);
        this.emit('native', { kind: turn.status === 'completed' ? 'turn-completed' : 'turn-interrupted', id: turn.id, preview });
      }
      this.changed();
      if (!this.closingRequested && (['disconnected', 'error'].includes(next.status) || next.status === 'uncertain' && !this.protocol.transport?.isOpen())) {
        this.closed = true;
        queueMicrotask(() => { void this.close().catch(error => { this.protocol.state.error = error.message; this.changed(); }); });
      }
    });
    await this.protocol.connect();
    const mode = this.protocol.initialization?.current_permission_mode;
    this.permissionControlAvailable = knownClaudePermissionModes.includes(mode);
    if (this.permissionControlAvailable) { this.protocol.state.permissionMode = mode; this.session.claudePermissionMode = mode; this.session.bypass = mode === 'bypassPermissions'; if (mode !== 'plan') this.buildPermissionMode = mode; }
    const settings = this.readSettings(true).finally(() => { if (!this.closed) this.changed(); });
    let settingsTimer;
    try { await Promise.race([settings, new Promise(resolve => { settingsTimer = setTimeout(resolve, 100); })]); }
    finally { clearTimeout(settingsTimer); }
    this.initialized = true; this.changed();
    return { conversationId: this.session.nativeId };
  }
  snapshot() {
    const state = this.protocol?.snapshot() || { status: 'disconnected', items: [], turns: [], requests: [], uncertain: false, error: this.startupError || 'Claude has not connected.' };
    const visible = state.items.slice(-100), visibleTurns = new Set(visible.map(item => item.turnId));
    this.historyReferences ||= new Set();
    for (const item of visible) this.historyReferences.add(item.id);
    return { ...state, provider: 'claude', sharedBrowser: !!this.browser?.shared, capabilities: { ...claudeGraphicalCapabilities, browserPanel: !!this.browser?.shared, steer: this.steering.available, effort: !!this.effortControlAvailable && !!this.efforts().length, permissions: !!this.permissionControlAvailable, plan: !!this.permissionControlAvailable }, runtimeId: this.runtimeId, revision: this.revision,
      ...this.pending.snapshot(), ...this.steering.snapshot(), canSteer: this.steering.available && state.status === 'running' && !state.requests.length && !state.turns.at(-1)?.kind && !this.steering.busy, connected: this.initialized && !this.closed, working: working(state.status) || this.submitting, canInterrupt: ['running', 'waiting'].includes(state.status) && !this.steering.busy,
      draft: this.draft, model: this.session.graphicalModel || '', effort: this.session.effort, bypass: this.session.bypass,
      subagents: this.subagents.snapshot(), backgroundWorkPending: this.subagents.hasActive, composerContext: structuredClone(this.composer.items), usage: structuredClone(this.usage), usageRefreshing: !!this.usageRefreshing,
      compaction: this.protocol?.state.compaction || null, compactionAvailable: !!this.protocol?.initialization?.commands?.some(command => command.name === 'compact' && command.builtin === true),
      attachments: [...this.attachments], attachmentDetails: this.attachmentDetails.map(item => ({ ...item })), submitting: this.submitting, attachmentUpdating: this.attachmentUpdating,
      models: this.models(), configuring: !!(this.configuring || this.identityChecking), messageActionBusy: !!this.messageActionBusy,
      efforts: this.efforts(), permissionMode: this.session.claudePermissionMode,
      workMode: this.session.claudePermissionMode === 'plan' ? 'plan' : 'build', buildPermissionMode: this.buildPermissionMode,
      permissionModes: claudePermissionOptions(this.session.claudeBypassAllowed),
      items: visible.map(item => ({ ...this.displayItem(item), status: status(item.status || 'completed') })),
      hasOlder: !!this.hasOlder || state.items.length > 100,
      turns: state.turns.filter(turn => visibleTurns.has(turn.id)).map(turn => ({ ...turn, status: status(turn.status), durationMs: turn.startedAt != null && turn.completedAt != null ? Math.max(0, turn.completedAt - turn.startedAt) : null, timingSource: turn.historical ? 'unavailable' : 'observed' })),
      activeTurnId: working(state.status) ? state.turns.at(-1)?.id : null,
    };
  }
  models() {
    return claudeModelChoices(this.protocol?.initialization);
  }
  async refreshUsage() {
    if (!this.idle()) throw new Error('Wait for an idle Claude connection before refreshing usage. Your draft is preserved.');
    this.usageRefreshing = true; this.changed();
    const errors = [];
    try {
      try { const value = await this.protocol.control({ subtype: 'get_context_usage', detail: 'summary' }); this.usage.context = contextUsage(value); if (!this.usage.context) errors.push('Context estimate unavailable.'); }
      catch { this.usage.context = null; errors.push('Context estimate unavailable in this runtime.'); }
      if (this.closed) throw new Error('Claude disconnected during usage inspection.');
      try { const value = await this.protocol.control({ subtype: 'get_usage', skip_behaviors: true }); this.usage.tokens = modelTokens(value?.session?.model_usage); this.usage.plan = planUsage(value); }
      catch { this.usage.plan = { available: false, windows: [] }; errors.push('Native usage report unavailable in this runtime.'); }
      this.usage.updatedAt = Date.now(); this.usage.error = errors.join(' ');
      return { refreshed: true };
    } finally { this.usageRefreshing = false; this.changed(); }
  }
  async compact(requestId) {
    if (!/^[a-f0-9-]{36}$/i.test(requestId || '')) throw new Error('A compaction request identity is required.');
    const previous = this.protocol.state.compaction;
    if (previous?.requestId === requestId) return { accepted: true, operation: previous };
    if (this.protocol.state.compactionRequests?.includes(requestId)) throw new Error('This compaction request was already handled. Inspect the current status.');
    if (!this.ready() || previous && ['running', 'uncertain'].includes(previous.status)) throw new Error('Finish the turn, clear pending input and resolve any uncertain compaction first.');
    if (!this.snapshot().compactionAvailable) throw new Error('Native Claude compaction is unavailable. Use the CLI.');
    const operation = { requestId, status: 'running', startedAt: Date.now(), nativeId: this.session.nativeId };
    this.protocol.state.compaction = operation;
    this.protocol.state.compactionRequests = [...(this.protocol.state.compactionRequests || []), requestId].slice(-50);
    this.configuring = true; this.changed();
    // No retry: an accepted native slash command can consume model usage.
    try { await this.verifyIdentity?.(); await this.persistState(); if (this.closed) throw new Error('Claude disconnected before compaction.'); this.protocol.submit('/compact', { operation: 'compact' }); }
    catch (error) { if (operation.status === 'running') operation.status = 'uncertain'; throw error; }
    finally { this.configuring = false; this.changed(); }
    clearTimeout(this.compactTimer);
    if (operation.status === 'running') this.compactTimer = setTimeout(() => {
      if (operation.status !== 'running') return;
      operation.status = 'uncertain'; this.protocol.disconnected('Compaction completion is unknown. Reconnect and inspect the native conversation before another attempt.');
    }, this.compactionTimeoutMs || 150000);
    this.changed(); return { accepted: true, operation };
  }
  dismissCompaction() {
    if (!this.idle()) throw new Error('Reconnect and inspect the native conversation before clearing compaction status.');
    if (this.protocol.state.compaction?.status === 'running') throw new Error('Compaction is still running.');
    this.protocol.state.compaction = null; this.changed(); return { dismissed: true };
  }
  efforts(model = this.session.graphicalModel || 'default') { return this.models().find(item => item.value === model)?.efforts || []; }
  async readSettings(optional = false) {
    try {
      const result = await this.protocol.control({ subtype: 'get_settings' });
      const applied = result?.applied?.effort;
      if (!claudeEffortNames.includes(applied)) throw new Error('Claude did not report its applied reasoning effort.');
      this.effortControlAvailable = true; this.session.effort = applied; return applied;
    } catch (error) {
      this.effortControlAvailable = false;
      if (!optional) throw error;
    }
  }
  get items() { return new Map((this.protocol?.state.items || []).map(item => [item.id, this.displayItem(item)])); }
  get historyItems() { return new Map([...this.loadedHistory].map(([id, item]) => [id, this.displayItem(item)])); }
  historyPage(page, anchorId) {
    this.historyReferences ||= new Set();
    for (const item of page.items) this.historyReferences.add(item.id);
    const observed = new Map([...this.historyMetadata, ...this.protocol.state.items.map(item => [item.id, item])]);
    page = { ...page, items: page.items.map(item => ({ ...item, ...(observed.get(item.id) || {}), ...(anchorId === item.id && item.text.startsWith('[Excerpt from native history]') ? { text: item.text } : {}), turnId: item.turnId })) };
    for (const item of page.items) { this.loadedHistory.delete(item.id); this.loadedHistory.set(item.id, item); }
    while (this.loadedHistory.size > 500) this.loadedHistory.delete(this.loadedHistory.keys().next().value);
    return { ...page, runtimeId: this.runtimeId, items: page.items.map(item => this.displayItem(item)), ...(anchorId ? { anchorId } : {}) };
  }
  async older({ beforeId, cursor } = {}) {
    const boundary = cursor || beforeId;
    if (typeof boundary !== 'string' || !boundary || boundary.length > 2000) throw new Error('Choose a valid history boundary.');
    return this.historyPage(await this.history.page({ beforeId: boundary }));
  }
  async ensureHistoryItem(id, force = false) {
    if (!force && (this.items.has(id) || this.historyItems.has(id))) return;
    if (!this.historyReferences?.has(id)) return;
    this.historyPage(await this.history.page({ aroundId: id }), id);
  }
  toolResult(item, block) {
    const content = Array.isArray(block.content) ? block.content.map(part => part?.type === 'image' && part.source?.type === 'base64' ? { type: 'image', data: part.source.data, mimeType: part.source.media_type } : part) : null;
    const projected = content && projectResultContent({ result: { content } });
    if (!projected) return typeof block.content === 'string' ? block.content : 'Unsupported tool result';
    this.resultAssets.delete(item.id); this.resultAssets.set(item.id, projected.assets);
    let bytes = 0;
    for (const [id, assets] of [...this.resultAssets].reverse()) {
      bytes += assets.reduce((size, asset) => size + (asset.data?.length || 0) + Buffer.byteLength(asset.text || ''), 0);
      if (bytes > 32 * 1024 * 1024 || this.resultAssets.size > 150) this.resultAssets.delete(id);
    }
    item.resources = projected.assets.map(({ data, text, path: file, ...asset }) => ({ ...asset, ...(text != null ? { text: text.slice(0, 32000) } : {}), available: data != null || text != null || !!file }));
    return projected.summary.slice(0, 200000);
  }
  displayItem(item) {
    const result = claudeDisplayItem(item);
    if (item.resources) result.resources = item.resources.map((resource, index) => ({ ...resource, available: !!this.resultAssets.get(item.id)?.[index] && resource.available !== false }));
    return result;
  }
  get outputs() { return new Map([...this.loadedHistory.values(), ...this.protocol.state.items].map(item => [item.id, item.text])); }
  async configure(model, effort) {
    if (!this.ready()) throw new Error('Finish the turn and clear your draft before changing settings.');
    if (model === undefined && effort === undefined) throw new Error('Choose a model or reasoning effort.');
    if (model !== undefined && !this.models().some(item => item.value === model)) throw new Error('Choose a model reported by Claude.');
    if (effort !== undefined && (!this.effortControlAvailable || !this.efforts(model).includes(effort))) throw new Error('This reasoning effort is not reported as supported by the selected Claude model.');
    this.configuring = true; this.changed();
    try {
      if (model !== undefined) { await this.protocol.control({ subtype: 'set_model', model }); this.session.graphicalModel = model; }
      if (effort !== undefined) await this.protocol.control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
      const applied = await this.readSettings(effort === undefined);
      if (effort !== undefined && applied !== effort) throw Object.assign(new Error(`Claude applied ${applied} reasoning instead of ${effort}.`), { nativeRejected: true });
    }
    catch (error) { if (!error.nativeRejected) this.protocol.protocolFailure('Claude did not confirm the session settings. Reconnect before sending.'); throw error; }
    finally { this.configuring = false; this.changed(); }
    return { configured: true };
  }
  async setPermissionMode(mode, { restoreBuild = false } = {}) {
    if (!this.ready()) throw new Error('Finish the turn and clear your draft before changing permissions.');
    if (!this.permissionControlAvailable || !(claudePermissionOptions(this.session.claudeBypassAllowed).some(item => item.value === mode) || restoreBuild && mode === 'auto' && this.buildPermissionMode === mode)) throw new Error('Choose a permission mode available to this Claude chat. Bypass must be enabled at launch.');
    this.configuring = true; this.changed();
    try {
      const result = await this.protocol.control({ subtype: 'set_permission_mode', mode });
      if (result?.mode !== mode) throw new Error('Claude did not confirm the requested permission mode.');
      this.protocol.state.permissionMode = mode;
      this.session.claudePermissionMode = mode; this.session.bypass = mode === 'bypassPermissions';
      if (mode !== 'plan') this.buildPermissionMode = mode;
    } catch (error) { if (!error.nativeRejected) this.protocol.protocolFailure('Claude did not confirm the permissions. Reconnect before sending.'); throw error; }
    finally { this.configuring = false; this.changed(); }
    return { configured: true };
  }
  async setWorkMode(mode) {
    if (!['plan', 'build'].includes(mode)) throw new Error('Choose Plan or Build.');
    if (!this.ready()) throw new Error('Finish the turn and clear your draft before changing mode.');
    const target = mode === 'plan' ? 'plan' : this.buildPermissionMode;
    if (mode === 'build' && target !== 'auto' && !claudePermissionOptions(this.session.claudeBypassAllowed).some(item => item.value !== 'plan' && item.value === target)) throw new Error('The previous Build permissions are unavailable in this native runtime.');
    return this.setPermissionMode(target, { restoreBuild: mode === 'build' });
  }
  get items() { return new Map([...(this.loadedHistory || []), ...(this.protocol?.state.items || []).map(item => [item.id, this.displayItem(item)])]); }
  get historyItems() { return new Map(); }
  prepareReview(target) {
    if (!this.ready()) throw new Error('Finish work and clear the composer and queue before preparing a review.');
    this.draft = reviewDraft(target); this.draftRevision++; this.changed(); return { draft: this.draft, prepared: true, sent: false };
  }
  assertAttachmentReady() {
    if (this.steering.busy) throw new Error('Wait for the native guidance receipt before changing context.');
    if (this.pending.busy) throw new Error('Wait for the queue operation before editing attachments or context.');
    if (!this.initialized || this.closed || this.configuring || this.submitting || this.attachmentUpdating || this.messageActionBusy || this.usageRefreshing || this.protocol.state.uncertain) throw new Error('Wait for the Claude connection or attachment operation before editing attachments.');
  }
  async attach(paths) {
    this.assertAttachmentReady();
    if (!Array.isArray(paths) || !paths.length || paths.length > 20) throw new Error('Choose between 1 and 20 attachments.');
    this.attachmentUpdating = true; this.changed();
    try {
      const details = [...this.attachmentDetails];
      for (const file of paths) if (!details.some(item => item.path === file)) details.push((await inspectClaudeAttachment(file)).metadata);
      validateClaudeAttachments(details);
      if (this.closed) throw new Error('Claude disconnected while attaching files. Nothing was attached.');
      this.attachmentDetails = details; this.attachments = details.map(item => item.path);
      for (const item of details) this.previewPaths.add(item.resolvedPath);
      return { attached: [...this.attachments], submitted: false };
    } finally { this.attachmentUpdating = false; this.changed(); }
  }
  detach(file) {
    this.assertAttachmentReady();
    this.attachments = this.attachments.filter(item => item !== file); this.attachmentDetails = this.attachmentDetails.filter(item => item.path !== file); this.changed();
    return { detached: true };
  }
  submit(text = this.draft) {
    if (!this.verifyIdentity) return this.submitChecked(text);
    if (this.identityChecking) throw new Error('Wait for the Claude account check.');
    this.identityChecking = true; this.changed();
    return Promise.resolve().then(() => this.verifyIdentity()).then(() => this.submitChecked(text)).finally(() => { this.identityChecking = false; this.changed(); });
  }
  submitChecked(text) {
    if (this.steering.busy) throw new Error('Wait for the guidance receipt before sending another message.');
    if (this.pending.pending) throw new Error('Use the queue or remove pending messages before sending directly.');
    if (!this.initialized || this.closed || this.configuring || this.submitting || this.attachmentUpdating || this.messageActionBusy || this.usageRefreshing) throw new Error('Reconnect Claude or finish the current attachment operation before sending.');
    if (typeof text !== 'string' || text.length > 64000 || /^\s*\//.test(text)) throw new Error('Enter a message up to 64,000 characters. Use CLI for slash commands.');
    if (this.attachments.length || this.composer.items.length || skillMentions(text).length) return this.submitAttachments(text);
    this.protocol.submit(text); this.draft = ''; this.changed();
    return { delivered: true };
  }
  async submitAttachments(text) {
    if (this.protocol.state.status !== 'ready' || this.protocol.state.uncertain) throw new Error('Finish the current turn before sending attachments.');
    const selected = [...this.attachmentDetails], context = structuredClone(this.composer.items), draft = this.draft, revision = this.draftRevision;
    this.submitting = true; this.changed();
    try {
      const prepared = await this.composer.input(text, selected, context);
      if (this.closed) throw new Error('Claude disconnected before the attachments were sent.');
      this.protocol.submit(text, { content: prepared.blocks, attachments: prepared.attachments, composerContext: prepared.context });
      this.composer.consumed(context);
      if (this.draft === draft && this.draftRevision === revision) this.draft = '';
      const consumed = new Set(selected.map(item => item.path));
      this.attachments = this.attachments.filter(file => !consumed.has(file)); this.attachmentDetails = this.attachmentDetails.filter(item => !consumed.has(item.path));
      return { delivered: true };
    } finally { this.submitting = false; this.changed(); }
  }
  interrupt() { if (this.steering.busy) throw new Error('Wait for the native guidance receipt before interrupting.'); return this.protocol.interrupt().then(() => ({ interrupted: true })); }
  answer(id, decision, answers) {
    if (!['allow', 'deny'].includes(decision)) throw new Error('Choose Allow once or Decline.');
    this.protocol.answer(id, decision === 'allow', answers); return { answered: true };
  }
  async acknowledgeUncertain() { await this.steering.acknowledge(); this.protocol.acknowledgeUncertain(); return { acknowledged: true }; }
  async persistState() {
    if (!this.protocol) return;
    const state = this.protocol.snapshot();
    // Requests are transport-scoped: never restore an old approval as actionable.
    state.requests = [];
    for (const item of state.items) if (item.type === 'userMessage' && (item.attachments?.length || item.composerContext?.length)) this.historyMetadata.set(item.id, { id: item.id, nativeUuid: item.nativeUuid, type: item.type, text: item.text, attachments: item.attachments, composerContext: item.composerContext });
    while (this.historyMetadata.size > 2000) this.historyMetadata.delete(this.historyMetadata.keys().next().value);
    const previousCount = state.items.length;
    state.items = boundedTail(state.items, 6 * 1024 * 1024);
    const turns = new Set(state.items.map(item => item.turnId)); state.turns = state.turns.filter(turn => turns.has(turn.id));
    const historyMetadata = boundedTail([...this.historyMetadata.values()], 2 * 1024 * 1024);
    this.historyMetadata = new Map(historyMetadata.map(item => [item.id, item]));
    await saveJson(this.file, { version: 1, repo: this.stateDir, nativeId: this.session.nativeId, subagents: this.subagents.save(), buildPermissionMode: this.buildPermissionMode, hasOlder: !!this.hasOlder || state.items.length < previousCount, draft: this.draft, composerContext: this.composer.items, state, historyMetadata, attachments: this.attachmentDetails, previewPaths: [...this.previewPaths].slice(-500) });
  }
  exited(exitCode) { if (this.exitedOnce) return; this.exitedOnce = true; this.closed = true; this.emit('exit', { exitCode }); }
  kill() { void this.close().catch(error => { this.protocol.state.error = error.message; this.changed(); }); }
  async close() {
    if (this.closing) return this.closing;
    this.closingRequested = true; this.closed = true;
    clearTimeout(this.compactTimer);
    this.historySearch.clear();
    this.closing = (async () => {
      this.protocol?.close(); await this.transport?.close(); await this.steering.close(); await this.pending.close(); this.resultAssets.clear(); this.exited(0);
    })();
    return this.closing;
  }
}
