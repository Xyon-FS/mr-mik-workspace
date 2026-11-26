import { skillMentions } from './skill-mentions.mjs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { CodexChatTransport } from './codex-chat-transport.mjs';
import { codexWorkerKey, codexWorkerEnvironment } from './codex-worker-pool.mjs';
import { codexWorkerArguments } from './codex-worker-launch.mjs';
import { codexThreadMcp } from './codex-thread-mcp.mjs';
import { authorizeCodexRpc, detachCodexThreads } from './codex-chat-worker-attachment.mjs';
import { randomUUID } from 'node:crypto';
import { codexBridgeArgs, linkedCodexMcpArgs } from './agents.mjs';
import { graphicalCodexBinary } from './codex-chat-binary.mjs';
import { connectionIssue } from './connection-errors.mjs';
import { sandboxMode, rememberSandbox, reserveSandbox } from './codex-sandbox.mjs';
import { codexExecutionDiagnostics } from './codex-execution-diagnostics.mjs';
import { setupSharedSandbox } from './codex-sandbox-setup.mjs';
import { projectTurn } from './codex-turns.mjs';
import { projectChatItem } from './codex-chat-items.mjs';
import { CodexChatAdvanced, graphicalInput } from './codex-chat-advanced.mjs';
import { GraphicalPermissions } from './codex-chat-permissions.mjs';
import { CodexChatOperations } from './codex-chat-operations.mjs';
import { validateElicitation } from './elicitation-schema.mjs';
import { GraphicalComposer } from './graphical-composer.mjs';
import { GraphicalHistorySearch } from './graphical-history-search.mjs';

const clipped = value => String(value ?? '').slice(0, 32000);
const decisions = ['accept', 'acceptForSession', 'decline', 'cancel'];
const supportedRequests = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
const bounded = (value, depth = 0) => {
  if (typeof value === 'string') return value.slice(0, 16000);
  if (depth > 8) return '[Details omitted]';
  if (Array.isArray(value)) return value.slice(0, 40).map(item => bounded(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, bounded(item, depth + 1)]));
  return value;
};

// Opt-in worker runtime. Keeps native auth/history; never copies tokens or
// replays an uncertain submission. The PTY runtime remains independent.
export class CodexChat extends EventEmitter {
  constructor({ session, env, bridge, browser, sharedHome, sandboxStateDir, spawnChild = spawn, workerPool, account, stateDir }) {
    super(); Object.assign(this, { session, env, bridge, browser, sandboxStateDir, spawnChild, workerPool, account, stateDir });
    this.sandboxEnv = sharedHome ? { ...env, CODEX_HOME: sharedHome } : env;
    this.installTransport(new CodexChatTransport({ spawnChild }));
    this.requests = new Map(); this.items = new Map(); this.turns = new Map(); this.historyItems = new Map(); this.outputs = new Map();
    this.resultAssets = new Map();
    this.revision = 0; this.turnId = null; this.submitting = false; this.nativeActive = false; this.nativeStateVersion = 0;
    this.closed = false; this.draft = ''; this.attachments = []; this.attachmentInfo = new Map(); this.previewPaths = new Set(); this.error = ''; this.effective = null; this.finishedTurns = new Set(); this.uncertain = false;
    this.runtimeId = randomUUID(); this.draftRevision = 0;
    this.errorId = 0; this.sandbox = { status: 'checking', settingUp: false }; this.model = session.graphicalModel || null;
    this.advanced = new CodexChatAdvanced(this);
    this.permissions = new GraphicalPermissions(this);
    this.operations = new CodexChatOperations(this);
    this.composer = new GraphicalComposer(this);
    this.historySearch = new GraphicalHistorySearch(this);
  }
  installTransport(transport) {
    if (this.transport) {
      this.route.detach();
      for (const [event, listener] of this.transportListeners) this.transport.off(event, listener);
    }
    this.transport = transport;
    this.route = this.transport.router.attach({
      onMessage: message => this.message(message),
      onChild: message => {
        if (message.id != null || message.method === 'serverRequest/resolved') this.message(message, { childRequest: true });
        else this.operations.observeAgent(message);
      },
      onGlobal: message => this.message(message),
      onIssue: message => { this.uncertain = true; this.reportError(message); this.changed(); },
    });
    this.transportListeners = [
      ['invalid', () => { this.reportError('An unrecognized Codex event was received. No pending action was approved.'); this.changed(); }],
      ['fault', () => this.connectionFault()], ['exit', code => this.disconnected(code)],
    ];
    for (const [event, listener] of this.transportListeners) transport.on(event, listener);
  }
  idle({ settings = false } = {}) { return this.initialized === true && !this.capabilitiesPending && !this.closeTask && !this.messageActionBusy && !this.closed && !this.uncertain && !this.operations.busy && !this.submitting && !this.nativeActive && !this.advanced.busy && !this.advanced.steering && !this.permissions.busy && (settings || !this.permissions.uncertain) && !this.turnId && !this.requests.size && !this.sandbox.settingUp; }
  ready() { return this.idle() && !this.operations.agentsBusy && !this.advanced.queue.length && !this.draft.trim() && !this.attachments.length && !this.composer.items.length; }
  sandboxRequired() { return this.effective?.sandbox !== 'dangerFullAccess'; }
  reportError(error) { this.errorId++; this.connectionIssue = connectionIssue(error); this.error = this.connectionIssue.category === 'unknown' ? clipped(error?.message || error) : this.connectionIssue.message; }
  onExit(callback) { this.on('exit', callback); return { dispose: () => this.off('exit', callback) }; }
  resize() {}
  write() { throw new Error('Use the graphical composer; terminal input is unavailable in this chat.'); }
  changed() { this.revision++; this.emit('change'); }
  start(...args) { this.startupPromise ||= this.startNative(...args); return this.startupPromise; }
  async startNative(resumeId, fork = false, forkAnchor = null) {
    if (forkAnchor && (!fork || Object.keys(forkAnchor).length !== 1 || !['lastTurnId', 'beforeTurnId'].includes(Object.keys(forkAnchor)[0]) || !Object.values(forkAnchor).every(value => typeof value === 'string' && value.length > 0 && value.length <= 200))) throw new Error('Choose a valid native turn for this branch.');
    if (this.model != null && (typeof this.model !== 'string' || !this.model.trim() || this.model.length > 200)) throw new Error('The saved graphical model is invalid. Choose a valid model before resuming.');
    const binary = graphicalCodexBinary(), mode = this.session.codexPermissions || 'ask';
    const reviewer = mode === 'auto-review' ? 'auto_review' : 'user';
    const policy = mode === 'bypass' ? 'never' : 'on-request';
    const sandbox = ['bypass', 'full-access'].includes(mode) ? 'danger-full-access' : 'workspace-write';
    const savedSandbox = await sandboxMode(this.sandboxStateDir, this.sandboxEnv);
    const args = codexWorkerArguments(binary, mode, savedSandbox);
    const workerArgs = [...args, 'app-server', '--stdio'];
    if (this.bridge) {
      args.push(...codexBridgeArgs(this.bridge.script));
      args.push(...linkedCodexMcpArgs(this.bridge.linkedMcps));
      if (this.bridge.instructions) args.push('-c', `developer_instructions=${JSON.stringify(this.bridge.instructions)}`);
      if (this.bridge.codexWritableRoots) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(this.bridge.contentDirectories || [])}`);
    }
    if (this.browser) args.push('-c', `mcp_servers.${this.browser.serverName}={command=${JSON.stringify(this.browser.command)},args=${JSON.stringify(this.browser.args)},enabled=true${this.browser.shared ? ',env_vars=["MRMIK_BROWSER_ENDPOINT","MRMIK_BROWSER_TOKEN"]' : ''}}`);
    const nativeArgs = args.filter((value, index) => !(value === '-c' && /^(approval_policy|approvals_reviewer|sandbox_mode)=/.test(args[index + 1] || '')) && !/^(approval_policy|approvals_reviewer|sandbox_mode)=/.test(value));
    this.nativeSettingsBinary = { ...binary, args: nativeArgs };
    args.push('app-server', '--stdio');
    if (this.workerPool) {
      const key = await codexWorkerKey({ account: this.account, file: binary.file, args: workerArgs, cwd: this.session.cwd, env: this.env });
      if (key) this.threadScope = await codexThreadMcp({ stateDir: this.stateDir, bridge: this.bridge, browser: this.browser });
      if (this.closeTask) throw new Error('Chat closed during startup.');
      if (this.threadScope) {
        this.workerLease = this.workerPool.acquire(key, { file: binary.file, args: workerArgs, cwd: this.session.cwd, env: codexWorkerEnvironment(this.env), spawnChild: this.spawnChild, profileId: this.account.profileId });
        this.installTransport(this.workerLease.transport);
      }
    }
    if (!this.workerLease) this.transport.start(binary.file, args, { cwd: this.session.cwd, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    await this.transport.initialize();
    await this.verifyStartupAccount?.(this);
    const params = { cwd: this.session.cwd, ...(mode === 'native' ? {} : { approvalPolicy: policy, approvalsReviewer: reviewer, sandbox }), ...(this.model ? { model: this.model } : {}), ...(this.threadScope ? { config: this.threadScope.config, ...(this.threadScope.developerInstructions ? { developerInstructions: this.threadScope.developerInstructions } : {}) } : {}) };
    const stateVersion = this.nativeStateVersion;
    this.openingThread = true;
    let result;
    try { result = await this.rpc(resumeId ? fork ? 'thread/fork' : 'thread/resume' : 'thread/start', { ...params, ...(resumeId ? { threadId: resumeId, excludeTurns: true } : {}), ...(forkAnchor || {}) }); }
    catch (error) { if (error.nativeRejected) this.openingThread = false; else this.uncertain = true; throw error; }
    if (!result?.thread?.id || resumeId && !fork && result.thread.id !== resumeId) throw new Error('Codex did not resume the requested conversation.');
    if (fork && result.thread.id === resumeId) throw new Error('Codex did not create a separate branch. The original conversation was not submitted.');
    this.threadId = result.thread.id;
    this.route.bindRoot(this.threadId);
    this.openingThread = false;
    if (this.nativeStateVersion === stateVersion) this.nativeActive = result.thread.status?.type === 'active';
    this.effective = { approvalPolicy: result.approvalPolicy, reviewer: result.approvalsReviewer, sandbox: result.sandbox?.type || 'unknown', model: result.model || null };
    this.permissions.initialize(result);
    this.historyMode = result.thread.historyMode;
    // A pooled process has a worker originator, not a unique chat originator.
    // Persist the verified root before optional discovery/history work can fail.
    if (this.workerLease) await this.recordNativeRoot?.(result.thread.id);
    if (resumeId) {
      if (this.historyMode === 'paginated') {
        let cursor; const cursors = new Set();
        for (let count = 0; count < 20; count++) {
          const page = await this.rpc('thread/items/list', { threadId: this.threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page.data)) throw new Error('Codex did not return a valid history page. Reconnect to retry.');
          for (const entry of [...page.data].reverse()) this.upsert(entry.item || entry, { turnId: entry.turnId, startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs });
          this.truncated = !!page.nextCursor;
          if (page.data.length || !page.nextCursor) break;
          if (cursors.has(page.nextCursor)) throw new Error('Codex repeated an empty history page. Reconnect to retry.');
          cursors.add(page.nextCursor); cursor = page.nextCursor;
          if (count === 19) throw new Error('Codex returned too many empty history pages. Reconnect to retry.');
        }
        // Timing-only history read; not all older native engines expose this API.
        const history = await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' }).catch(() => null);
        for (const turn of history?.data || []) this.rememberTurn(turn);
      } else {
        const history = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: true });
        for (const turn of history.thread?.turns || []) { this.rememberTurn(turn); for (const item of turn.items || []) this.upsert(item, { turnId: turn.id }); }
      }
    }
    if (this.nativeActive && !this.turnId) this.turnId = [...this.turns.values()].reverse().find(turn => turn.status === 'inProgress')?.id || null;
    // The root is owned, so closing may detach it immediately. Send/connected
    // readiness waits for capability checks without holding close behind them.
    this.capabilitiesPending = true; this.initialized = true;
    // An unhandled failure must not advertise readiness before caller cleanup.
    await Promise.all([this.checkSandbox(), this.advanced.discover()]);
    this.capabilitiesPending = false;
    this.changed(); return result;
  }
  async checkSandbox() {
    try { const result = await this.rpc('windowsSandbox/readiness', null, 5000); this.sandbox.status = ['ready', 'notConfigured', 'updateRequired'].includes(result?.status) ? result.status : 'unavailable'; }
    catch { this.sandbox.status = 'unavailable'; }
    this.changed(); return this.sandbox;
  }
  async executionDiagnostics() {
    this.executionIssue = await codexExecutionDiagnostics(this.sandboxEnv.CODEX_HOME).catch(() => ({ status: 'unavailable' }));
    this.changed(); return this.executionIssue;
  }
  async setupSandbox() {
    if (!this.idle()) throw new Error('Finish work before setting up the sandbox. Your draft will be retained.');
    const state = await this.checkSandbox();
    if (!this.idle()) throw new Error('The chat changed before sandbox setup.');
    if (state.status === 'ready') return { started: false, ready: true };
    if (!['notConfigured', 'updateRequired'].includes(state.status)) throw new Error('This Codex version does not expose sandbox setup readiness. Use its native setup flow.');
    this.releaseSandbox = reserveSandbox(this.sandboxEnv, this); this.sandbox.settingUp = true; this.sandbox.error = ''; this.changed();
    if (this.sandboxEnv.CODEX_HOME !== this.env.CODEX_HOME) {
      // Keep provisioning alive independently if its chat is closed during consent.
      this.sandboxSetup = setupSharedSandbox({ cwd: this.session.cwd, env: this.sandboxEnv, binary: graphicalCodexBinary(), spawnChild: this.spawnChild })
        .then(params => this.sandboxCompleted(params), () => this.sandboxCompleted({ mode: 'elevated', success: false }));
      return { started: true };
    }
    try { this.route.expect('windowsSandbox/setupCompleted'); const result = await this.rpc('windowsSandbox/setupStart', { mode: 'elevated', cwd: this.session.cwd }); if (!result.started) throw Object.assign(new Error('Codex did not start sandbox setup.'), { nativeRejected: true }); return result; }
    catch (error) { if (error.nativeRejected) { this.route.cancelExpected('windowsSandbox/setupCompleted'); this.releaseSandbox?.(); this.sandbox.settingUp = false; } this.sandbox.error = 'Sandbox setup was not confirmed. Check Windows consent before retrying.'; this.changed(); throw error; }
  }
  async sandboxCompleted(params) {
    if (!this.sandbox.settingUp || params.mode !== 'elevated') return;
    try {
      if (params.success) await rememberSandbox(this.sandboxStateDir, this.sandboxEnv, params.mode);
      this.sandbox.error = params.success ? '' : /cancel|declin|1223/i.test(params.error || '') ? 'Windows sandbox setup was cancelled. Your draft has been retained.' : 'Windows sandbox setup did not complete. Check local tool diagnostics before retrying.';
      this.sandbox.restartRequired = !!params.success;
    } catch { this.sandbox.error = 'Sandbox setup completed but its local preference could not be saved.'; }
    finally { this.sandbox.settingUp = false; this.releaseSandbox?.(); await this.checkSandbox(); }
  }
  send(message) {
    if (this.closed) throw new Error('Codex is disconnected. Reconnect before continuing.');
    this.route.send(message);
  }
  rpc(method, params, timeout = 30000) {
    try { if (this.workerLease) authorizeCodexRpc(this, method, params); }
    catch (error) { return Promise.reject(error); }
    return this.transport.rpc(method, params, timeout, this.runtimeId);
  }
  rememberTurn(turn, observed = false) {
    if (!turn?.id) return;
    this.turns.set(turn.id, projectTurn(turn, this.turns.get(turn.id), { observed }));
    while (this.turns.size > 150) this.turns.delete(this.turns.keys().next().value);
  }
  upsert(item, metadata = {}) {
    if (!item?.id || !item.type) return;
    const previous = this.items.get(item.id);
    const { fullDetails, fullResources, ...value } = projectChatItem(item, previous ? { ...previous, details: this.outputs.get(item.id) ?? previous.details } : undefined, { turnId: this.turnId, ...metadata });
    this.rememberResultAssets(item.id, fullResources);
    this.outputs.set(item.id, fullDetails);
    if (value.attachments) value.attachments = value.attachments.map(attachment => ({ ...attachment, ...this.attachmentInfo.get(attachment.path) }));
    this.items.set(item.id, value);
    this.route.observeItem(item);
    if (item.type === 'commandExecution' && /helper_unknown_error|setup refresh had errors/i.test(value.details)) void this.executionDiagnostics();
    else if (item.type === 'commandExecution' && item.status === 'completed' && item.exitCode === 0) { this.executionIssue = null; this.sandbox.error = ''; }
    while (this.items.size > 150) { const id = this.items.keys().next().value; this.items.delete(id); if (!this.historyItems.has(id)) { this.outputs.delete(id); this.resultAssets.delete(id); } this.truncated = true; }
  }
  rememberResultAssets(id, assets) {
    if (!assets) return;
    this.resultAssets.delete(id); this.resultAssets.set(id, assets);
    let bytes = 0;
    for (const [key, value] of [...this.resultAssets].reverse()) {
      bytes += value.reduce((size, asset) => size + (asset.data?.length || 0) + Buffer.byteLength(asset.text || ''), 0);
      if (bytes > 32 * 1024 * 1024 || !this.items.has(key) && !this.historyItems.has(key) && key !== id) this.resultAssets.delete(key);
    }
  }
  async older({ beforeId, cursor } = {}) {
    const reference = { kind: 'older', beforeId, cursor };
    if (typeof beforeId !== 'string' || !beforeId || cursor != null && (typeof cursor !== 'string' || cursor.length > 16000)) throw new Error('Choose a valid history position.');
    let entries = [], nextCursor = null;
    if (this.historyMode === 'paginated') {
      let anchorFound = !!cursor;
      const visited = new Set();
      for (let count = 0; count < 20; count++) {
        const page = await this.rpc('thread/items/list', { threadId: this.threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
        const data = page.data || [];
        const anchor = data.findIndex(entry => (entry.item || entry).id === beforeId);
        if (!anchorFound && anchor >= 0) { entries = data.slice(anchor + 1); anchorFound = true; }
        else if (anchorFound) entries = data;
        nextCursor = page.nextCursor || null;
        if (nextCursor && (nextCursor === cursor || visited.has(nextCursor))) throw new Error('Codex repeated a history page. Return to the latest messages and retry.');
        if (entries.length || !nextCursor) break;
        if (visited.has(nextCursor)) throw new Error('Codex repeated a history page. Return to the latest messages and retry.');
        visited.add(nextCursor); cursor = nextCursor;
      }
      if (!anchorFound) throw new Error('This history position could not be located. Return to the latest messages and retry.');
      entries.reverse();
    } else {
      const history = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: true });
      const all = (history.thread?.turns || []).flatMap(turn => { this.rememberTurn(turn); return (turn.items || []).map(item => ({ item, turnId: turn.id })); });
      const index = all.findIndex(entry => entry.item.id === beforeId);
      if (index < 0) throw new Error('This history position could not be located. Return to the latest messages and retry.');
      entries = all.slice(Math.max(0, index - 100), index); nextCursor = index > 100 ? entries[0].item.id : null;
    }
    return this.historyPage(entries, { turns: [...this.turns.values()], nextCursor, hasOlder: !!nextCursor }, reference);
  }
  historyPage(entries, options, reference = { kind: 'legacy' }) {
    this.historyReferences ||= new Map();
    for (const entry of entries) { const id = (entry.item || entry).id; this.historyReferences.set(id, reference); this.historyItems.delete(id); }
    const items = entries.map(entry => { const { fullDetails, fullResources, ...item } = projectChatItem(entry.item || entry, {}, entry); this.historyItems.set(item.id, item); this.rememberResultAssets(item.id, fullResources); this.outputs.set(item.id, fullDetails); return item; });
    while (this.historyItems.size > 250) this.historyItems.delete(this.historyItems.keys().next().value);
    for (const id of this.outputs.keys()) if (!this.items.has(id) && !this.historyItems.has(id)) this.outputs.delete(id);
    for (const id of this.resultAssets.keys()) if (!this.items.has(id) && !this.historyItems.has(id)) this.resultAssets.delete(id);
    return { runtimeId: this.runtimeId, items, ...options };
  }
  async ensureHistoryItem(id, force = false) {
    if (!force && (this.items.has(id) || this.historyItems.has(id))) return;
    const reference = this.historyReferences?.get(id);
    if (!reference) return;
    if (reference.kind === 'older') { await this.older(reference); return; }
    if (reference.kind === 'page') {
      const page = await this.rpc('thread/items/list', { threadId: this.threadId, limit: 100, sortDirection: 'desc', ...(reference.cursor ? { cursor: reference.cursor } : {}) });
      this.historyPage([...(page.data || [])].reverse(), { turns: [...this.turns.values()], nextCursor: page.nextCursor || null, hasOlder: !!page.nextCursor }, reference);
      return;
    }
    if (this.historyMode === 'paginated') {
      let cursor = null;
      const seen = new Set();
      for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
        const page = await this.rpc('thread/items/list', { threadId: this.threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
        if ((page.data || []).some(entry => (entry.item || entry).id === id)) { this.historyPage([...(page.data || [])].reverse(), { turns: [...this.turns.values()], nextCursor: page.nextCursor || null, hasOlder: !!page.nextCursor }, { kind: 'page', cursor }); return; }
        if (!page.nextCursor) return;
        if (page.nextCursor === cursor || seen.has(page.nextCursor)) throw new Error('Native history repeated a cursor. Locate this message with conversation search.');
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      throw new Error('Locate this older message with conversation search to reload its source.');
    }
    const history = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: true });
    const all = (history.thread?.turns || []).flatMap(turn => (turn.items || []).map(item => ({ item, turnId: turn.id })));
    const index = all.findIndex(entry => entry.item.id === id);
    if (index >= 0) this.historyPage(all.slice(Math.max(0, index - 10), index + 11), { turns: [...this.turns.values()], nextCursor: null, hasOlder: index > 10 }, reference);
  }
  async reconcile() {
    if (!this.uncertain || !this.submission) throw new Error('No uncertain submission needs checking.');
    const result = this.historyMode === 'paginated' ? await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 10, sortDirection: 'desc', itemsView: 'full' }) : await this.rpc('thread/read', { threadId: this.threadId, includeTurns: true });
    const turns = result.data || result.thread?.turns || [];
    const matches = turns.filter(turn => ['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status) && (this.submission.kind === 'steer' ? turn.id === this.submission.turnId : !this.submission.knownTurns?.includes(turn.id) && Number.isFinite(turn.startedAt) && turn.startedAt * 1000 >= this.submission.at - 2000) && (turn.items || []).some(item => !this.submission.knownItems?.includes(item.id) && item.type === 'userMessage' && item.content?.some(part => part.type === 'text' && part.text === this.submission.text)));
    if (matches.length !== 1) return { confirmed: false, message: 'Codex could not confirm this submission. Nothing was resent. Keep the draft and inspect the conversation before starting new work.' };
    const turn = matches[0]; this.rememberTurn(turn); for (const item of turn.items || []) this.upsert(item, { turnId: turn.id });
    this.turnId = turn.status === 'inProgress' ? turn.id : null; this.nativeActive = !!this.turnId; this.uncertain = false; this.error = ''; this.submitting = false; this.changed();
    this.advanced.confirmed(this.submission.queueId);
    this.emit('native', { kind: this.turnId ? 'turn-started' : 'turn-interrupted' });
    return { confirmed: true, message: 'Submission found in Codex. Nothing was resent. Your retained draft may duplicate that message; review it before sending.' };
  }
  message(message, { childRequest = false } = {}) {
    if (this.closed) return;
    if (message.id != null && !message.method) return;
    const p = message.params || {};
    if (message.method === 'windowsSandbox/setupCompleted') { void this.sandboxCompleted(p); return; }
    if (p.threadId && this.threadId && p.threadId !== this.threadId && !(childRequest && (message.id != null || message.method === 'serverRequest/resolved'))) return;
    if (message.id != null) {
      // Preserve the request ID until native resolution. Unknown requests never
      // get an affirmative response and can be cancelled explicitly.
      if (this.requests.size >= 32) { this.send({ id: message.id, error: { code: -32603, message: 'Too many pending requests.' } }); return; }
      this.requests.set(String(message.id), { id: String(message.id), nativeId: message.id, method: message.method, params: p, supported: supportedRequests.has(message.method) });
      this.emit('native', { kind: 'attention' }); this.changed(); return;
    }
    this.advanced.observe(message.method, p);
    this.operations.observe(message.method, p);
    if (message.method === 'thread/settings/updated') this.permissions.observe(p.threadSettings);
    if (message.method === 'thread/status/changed') { this.nativeStateVersion++; this.nativeActive = p.status?.type === 'active'; }
    if (message.method === 'serverRequest/resolved') this.requests.delete(String(p.requestId));
    if (message.method === 'turn/started') { this.nativeStateVersion++; this.rememberTurn(p.turn, true); this.turnId = p.turn.id; this.nativeActive = true; this.error = ''; this.emit('native', { kind: 'turn-started' }); }
    if (message.method === 'turn/completed') {
      this.rememberTurn(p.turn, true);
      if (this.finishedTurns.has(p.turn.id)) { this.changed(); return; }
      if (this.turnId && p.turn.id !== this.turnId) { this.changed(); return; }
      this.finishedTurns.add(p.turn.id); if (this.finishedTurns.size > 100) this.finishedTurns.delete(this.finishedTurns.values().next().value);
      this.nativeStateVersion++; this.turnId = null; this.nativeActive = false; this.submitting = false;
      for (const [id, request] of this.requests) if (!request.params.threadId || request.params.threadId === this.threadId) this.requests.delete(id);
      if (!this.uncertain || this.submission?.kind !== 'steer' && !this.advanced.queue.some(entry => entry.id === this.submission?.queueId && entry.state === 'uncertain')) this.uncertain = false;
      this.advanced.completed(p.turn.status);
      if (p.turn.error) this.reportError(p.turn.error);
      this.emit('native', { kind: p.turn.status === 'interrupted' ? 'turn-interrupted' : 'turn-completed', id: p.turn.id,
        preview: [...this.items.values()].filter(item => item.type === 'agentMessage').at(-1)?.text.slice(0, 240) });
    }
    if (['item/started', 'item/completed'].includes(message.method)) this.upsert({ ...p.item, status: p.item?.status || (message.method === 'item/started' ? 'inProgress' : 'completed') }, { turnId: p.turnId });
    if (message.method === 'item/reasoning/summaryPartAdded') {
      if (!this.items.has(p.itemId)) this.upsert({ id: p.itemId, type: 'reasoning', status: 'inProgress' }, { turnId: p.turnId });
      const item = this.items.get(p.itemId);
      item.summaryParts ||= [];
      const index = Number.isInteger(p.summaryIndex) ? Math.min(39, Math.max(0, p.summaryIndex)) : item.summaryParts.length;
      item.summaryParts[index] ??= ''; this.changed(); return;
    }
    if (['item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta'].includes(message.method)) {
      if (!this.items.has(p.itemId)) this.upsert({ id: p.itemId, type: message.method.includes('agentMessage') ? 'agentMessage' : message.method.includes('/plan/') ? 'plan' : message.method.includes('reasoning') ? 'reasoning' : 'commandExecution', status: 'inProgress' }, { turnId: p.turnId });
      const item = this.items.get(p.itemId);
      if (message.method.includes('reasoning')) {
        const index = Number.isInteger(p.summaryIndex) ? Math.min(39, Math.max(0, p.summaryIndex)) : 0;
        item.summaryParts ||= []; item.summaryParts[index] = (item.summaryParts[index] || '') + (p.delta || '');
        item.text = item.summaryParts.join('\n\n'); this.changed(); return;
      }
      if (message.method.includes('agentMessage') || message.method.includes('/plan/')) item.text += p.delta || '';
      else { const output = (this.outputs.get(item.id) || '') + (p.delta || ''); this.outputs.set(item.id, output); item.details = output.slice(0, 32000); item.detailsTruncated = output.length > 32000; }
      this.items.set(item.id, item);
    }
    if (message.method === 'turn/plan/updated') this.upsert({ id: 'plan-' + (p.turnId || this.turnId), type: 'plan', text: p.explanation || '', plan: p.plan || [] }, { turnId: p.turnId });
    if (message.method === 'turn/diff/updated') this.upsert({ id: 'diff-' + (p.turnId || this.turnId), type: 'fileChange', text: 'Turn changes', aggregatedOutput: p.diff });
    if (message.method === 'error') { this.reportError(p.error || { message: 'Codex reported an error.' }); this.emit('native', { kind: 'attention', text: this.error, connectionIssue: this.connectionIssue }); }
    if (message.method === 'serverRequest/resolved' && !this.requests.size) this.emit('native', { kind: this.turnId ? 'turn-started' : 'turn-interrupted' });
    this.changed();
  }
  snapshot() {
    this.historyReferences ||= new Map();
    for (const id of this.items.keys()) if (!this.historyReferences.has(id)) this.historyReferences.set(id, { kind: 'legacy' });
    return { messageActionBusy: !!this.messageActionBusy, messageOrigin: this.session.messageOrigin || null, sharedBrowser: this.browser?.shared === true, runtimeId: this.runtimeId, revision: this.revision, items: [...this.items.values()], turns: [...this.turns.values()], activeTurnId: this.turnId, submitting: this.submitting, requests: [...this.requests.values()].map(({ nativeId, ...request }) => { void nativeId; return { ...request, params: bounded(request.params) }; }),
      subagents: this.operations.agents(), effective: this.effective, working: !!this.turnId || this.submitting || this.nativeActive, connected: this.initialized === true && !this.capabilitiesPending && !this.closed, error: this.error, truncated: !!this.truncated,
      errorId: this.errorId, executionIssue: this.executionIssue || null, connectionIssue: this.error ? this.connectionIssue : null, sandbox: this.sandbox, requiresSandbox: this.sandboxRequired(), canInterrupt: (!!this.turnId || this.nativeActive) && !this.closed && !this.interrupting,
      draft: this.draft, attachments: [...this.attachments], attachmentDetails: this.attachments.map(file => this.attachmentInfo.get(file) || { path: file, name: file.split(/[\\/]/).pop(), kind: /\.(png|jpe?g|gif|webp|bmp)$/i.test(file) ? 'image' : 'file' }), composerContext: this.composer.items, uncertain: this.uncertain, permissionsUpdating: this.permissions.busy, permissionsUncertain: this.permissions.uncertain, model: this.model || this.effective?.model, effort: this.session.effort, advanced: this.advanced.snapshot() };
  }
  async submit(text = this.draft, { queuedId = null, paths = this.attachments } = {}) {
    if (this.verifyIdentity) await this.verifyIdentity();
    if (!this.idle()) throw new Error('Finish the current request before sending another message.');
    if (!queuedId && this.advanced.queue.length) throw new Error('Add this message to the queue, or clear the queue before sending directly.');
    if (this.sandboxRequired() && (['notConfigured', 'updateRequired'].includes(this.sandbox.status) || this.sandbox.restartRequired)) throw new Error('Complete Windows sandbox setup and reconnect this chat before sending. Your draft has not been submitted.');
    if (typeof text !== 'string' || text.length > 64000 || !text.trim() && !paths.length && (queuedId || !this.composer.items.length)) throw new Error('Enter a message or attach context.');
    if (/^\s*\//.test(text)) throw new Error('Slash commands are not yet supported in Chat preview. Use CLI mode for native commands.');
    const collaboration = this.advanced.payload();
    const submittedDraft = this.draft, submittedRevision = this.draftRevision, submittedPaths = [...paths];
    const context = queuedId ? [] : [...this.composer.items];
    this.submitting = true; this.error = ''; this.changed(); this.emit('native', { kind: 'turn-started' });
    try {
      const input = context.length || skillMentions(text).length ? await this.composer.input(text, submittedPaths, context) : graphicalInput(text, submittedPaths);
      this.submission = { at: Date.now(), text: input[0].text, knownTurns: [...this.turns.keys()], queueId: queuedId };
      const result = await this.rpc('turn/start', { threadId: this.threadId, input, ...(this.model ? { model: this.model } : {}), effort: this.session.effort, ...collaboration });
      if (!result.turn?.id || !['inProgress', 'completed', 'failed', 'interrupted'].includes(result.turn.status) || this.submission.knownTurns.includes(result.turn.id)) throw Object.assign(new Error('Codex did not confirm a new turn for this message. Nothing was resent.'), { uncertain: true });
      if (result.turn?.status === 'inProgress' && !this.finishedTurns.has(result.turn.id)) { this.rememberTurn(result.turn, true); this.turnId = result.turn.id; }
      if (!queuedId && this.draftRevision === submittedRevision && this.draft === submittedDraft) this.draft = '';
      if (!queuedId) { this.attachments = this.attachments.filter(file => !submittedPaths.includes(file)); this.composer.consumed(context); } return { delivered: true, accepted: true };
    } catch (error) {
      this.reportError(error);
      this.uncertain = !error.nativeRejected;
      if (error.nativeRejected && !this.turnId) this.emit('native', { kind: 'turn-interrupted' });
      // Reconcile via native completion/reconnect. Never automatically resend.
      throw error;
    } finally { this.submitting = false; this.changed(); this.advanced.schedule(); }
  }
  async refreshActiveTurn() {
    const version = this.nativeStateVersion, expected = this.turnId;
    const paginated = this.historyMode === 'paginated';
    const result = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: !paginated }, 5000);
    if (this.closed || version !== this.nativeStateVersion) return;
    let turns = result.thread?.turns;
    if (paginated) {
      turns = []; let cursor; const seen = new Set();
      for (let page = 0; page < 10; page++) {
        const history = await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) }, 5000);
        if (this.closed || version !== this.nativeStateVersion) return;
        if (!Array.isArray(history.data)) throw new Error('Codex did not confirm its current turn state.');
        turns.push(...history.data);
        if (history.data.some(turn => expected ? turn.id === expected : turn.status === 'inProgress') || !history.nextCursor) break;
        if (seen.has(history.nextCursor)) throw new Error('Codex repeated its current turn history page.');
        seen.add(history.nextCursor); cursor = history.nextCursor;
      }
    }
    if (!Array.isArray(turns)) return;
    const turn = expected ? turns.find(turn => turn.id === expected) : [...turns].reverse().find(turn => turn.status === 'inProgress');
    if (turn && ['completed', 'interrupted', 'failed'].includes(turn.status)) {
      this.message({ method: 'turn/completed', params: { threadId: this.threadId, turn } });
    } else if (turn?.status === 'inProgress') {
      this.rememberTurn(turn, true); this.turnId = turn.id; this.nativeActive = true; this.changed();
    } else if (!expected && result.thread?.status?.type === 'idle') {
      this.nativeActive = false; this.changed();
    }
  }
  async interrupt() {
    if (this.interrupting) throw new Error('An interruption is already pending.');
    this.interrupting = true; this.advanced.paused = true; this.changed();
    try {
      if (!this.turnId) await this.refreshActiveTurn();
      if (!this.turnId && !this.nativeActive) return { interrupted: true };
      if (!this.turnId) throw new Error('Codex has not reported its active turn. Stop could not be confirmed; try again.');
      const turnId = this.turnId;
      await this.rpc('turn/interrupt', { threadId: this.threadId, turnId });
      // The RPC acknowledges receipt, not completion. Recover a missed final
      // notification from native state, without resending Stop or user input.
      for (let attempt = 0; attempt < 4 && this.turnId === turnId && !this.closed; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
        await this.refreshActiveTurn();
      }
      if (this.turnId === turnId) throw new Error('Codex acknowledged Stop but the turn is still active. Stop can be retried; no message was resent.');
      return { interrupted: true };
    } finally { this.interrupting = false; this.changed(); }
  }
  answer(id, action, answers) {
    const request = this.requests.get(String(id));
    if (!request || request.responded) throw new Error('This request has already been answered or resolved.');
    let result;
    if (!request.supported) {
      if (action !== 'cancel') throw new Error('This native request is not supported by Chat preview.');
      this.send({ id: request.nativeId, error: { code: -32601, message: 'Unsupported native request cancelled by user.' } });
    } else {
      if (/\/(commandExecution|fileChange)\/requestApproval$/.test(request.method)) {
        if (!decisions.includes(action)) throw new Error('Choose a valid approval decision.');
        if (request.params.availableDecisions && !request.params.availableDecisions.includes(action)) throw new Error('This approval decision is unavailable.');
        result = { decision: action };
      } else if (request.method === 'item/permissions/requestApproval') {
        if (!['accept', 'decline'].includes(action)) throw new Error('Choose accept or decline.');
        result = { permissions: action === 'accept' ? request.params.permissions : {}, scope: 'turn' };
      } else if (request.method === 'item/tool/requestUserInput') {
        if (action !== 'answer' || !answers || typeof answers !== 'object') throw new Error('Answer the pending questions.');
        result = { answers: {} };
        for (const question of request.params.questions || []) {
          const value = answers[question.id]; if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw new Error('Answer every question.');
          result.answers[question.id] = { answers: [value] };
        }
      } else {
        if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error('Choose a valid tool response.');
        if (action === 'accept' && request.params.mode !== 'url') {
          const checked = validateElicitation(request.params.requestedSchema, answers);
          if (!checked.valid) throw new Error(checked.error || Object.values(checked.errors)[0]);
        }
        result = { action, content: action === 'accept' && request.params.mode !== 'url' ? answers || {} : null };
      }
      this.send({ id: request.nativeId, result });
    }
    if (['decline', 'cancel'].includes(action)) { this.advanced.paused = true; this.advanced.queueNotice = 'Queue paused after a declined or cancelled request.'; }
    request.responded = true; this.changed(); return { answered: true };
  }
  async models() {
    const models = [], cursors = new Set(); let cursor;
    do { const page = await this.rpc('model/list', { ...(cursor ? { cursor } : {}) }); models.push(...(page.data || [])); cursor = page.nextCursor; if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a model catalog page.'); cursors.add(cursor); } while (cursor && models.length < 500);
    return models;
  }
  connectionFault() {
    if (this.closed || this.transportFault) return;
    this.transportFault = true; this.uncertain = true;
    this.freezeTurnClock();
    this.errorId++;
    this.error = 'The Codex connection failed. Input has not been resent. Waiting for the worker to stop.';
    this.transport.failPending(Object.assign(new Error(this.error), { uncertain: true })); this.changed();
    // Only actual process exit releases ownership. Broken pipes do not prove
    // that native execution has stopped.
    try { this.transport.terminate(); } catch { /* close() reports a bounded shutdown failure. */ }
  }
  disconnected(exitCode = 1) {
    if (this.closed) return;
    this.freezeTurnClock(); this.closed = true; this.advanced.paused = true;
    if (!this.workerLease) this.transport.disconnected(exitCode);
    this.transport.failOwner(this.runtimeId, new Error('Codex disconnected. Accepted input has not been resent.'));
    this.route.detach();
    for (const [event, listener] of this.transportListeners) this.transport.off(event, listener);
    this.scopeCleanup ||= this.threadScope?.cleanup().catch(error => { this.cleanupError = error; this.reportError('Codex scoped tool cleanup failed. Its private descriptor was retained.'); this.changed(); });
    this.requests.clear(); this.resultAssets.clear(); this.historySearch.clear(); this.turnId = null; this.nativeActive = false;
    this.emit('exit', { exitCode }); this.changed();
  }
  kill() { void this.close().catch(error => { this.reportError(error); this.changed(); }); }
  freezeTurnClock() {
    const turn = this.turns.get(this.turnId);
    if (turn && turn.observedUntil == null) turn.observedUntil = Date.now();
  }
  close() {
    if (!this.closeTask) {
      const task = this.closeNative(); this.closeTask = task;
      task.catch(() => { if (this.closeTask === task) this.closeTask = null; });
    }
    return this.closeTask;
  }
  async closeNative() {
    this.historySearch.clear();
    this.resultAssets.clear();
    if (this.startupPromise && !this.initialized && !this.closed) await this.startupPromise.catch(() => {});
    if (this.workerLease) {
      try {
        await this.workerLease.release(async () => {
          await detachCodexThreads(this);
          this.disconnected(0);
          await this.scopeCleanup;
          if (this.cleanupError) throw this.cleanupError;
        });
      }
      catch (error) {
        // A failed, unbound startup has no app input path. Quarantine it until
        // its siblings leave, then stop the worker and release retained grants.
        if (!this.initialized && !this.threadId) await this.workerLease.abandon();
        throw error;
      }
      this.disconnected(0);
    } else {
      await this.transport.close();
      if (!this.closed) this.disconnected(0);
    }
    await this.scopeCleanup;
    if (this.cleanupError) throw this.cleanupError;
  }
}
