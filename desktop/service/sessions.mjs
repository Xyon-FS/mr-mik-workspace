import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { TerminalSnapshotAddon } from './terminal-snapshot.mjs';
import { terminalCommand, childEnvironment } from './agents.mjs';
import { readJson, saveJson } from './util.mjs';
import { claudeTranscript, codexTranscript, codexTranscriptForChat, tailNativeFile } from './native-events.mjs';
import { englishTitle, restoredTitle } from './titles.mjs';
import { defaultWorkerEffort, workerEfforts, claudeEfforts } from './effort.mjs';
import { openCodeLaunchEnvironment, openCodeRuntimeConfig, openCodeVersion, openCodeStateFile, readOpenCodeState, watchOpenCode, validSessionId } from './opencode.mjs';
import { lookupV2Session } from './opencode-v2-session.mjs';

const { Terminal } = headless;
const publicSession = session => {
  const { id, name, agent, cwd, bypass, effort, status, createdAt, lastOutputAt, lastInputAt, exitCode, nativeId, attention, activity, unread, completionVersion, lastCompletedId, cols, rows, open, pinned, tabOrder, tabColor, updatedAt, preview, hasConversation, restoreError, toolRefresh } = session;
  return { id, name, agent, cwd, projectId: session.projectId || null, repositoryId: session.repositoryId ?? null, cardId: session.cardId || null, bypass, effort, status, createdAt, lastOutputAt, lastInputAt, exitCode, nativeId, attention, activity, unread, completionVersion, lastCompletedId, cols, rows, open, pinned, archived: !!session.archived, tabOrder, tabColor, updatedAt, preview, hasConversation, restoreError, nativeUnavailable: session.nativeUnavailable || null, toolRefresh: toolRefresh || null };
};

export class Sessions extends EventEmitter {
  constructor(repo, stateDir) {
    super();
    this.repo = repo;
    this.stateDir = stateDir;
    this.items = new Map();
    this.saveChain = Promise.resolve();
    this.dirty = false;
    this.closed = false;
  }

  async init() {
    await mkdir(this.stateDir, { recursive: true });
    const saved = await readJson(path.join(this.stateDir, 'sessions.json'), []);
    for (const [index, metadata] of saved.entries()) {
      const item = this.make({ ...metadata, name: restoredTitle(metadata.name, index), open: metadata.open ?? metadata.agent !== 'kimi', pinned: !!metadata.pinned, archived: !!metadata.archived, updatedAt: metadata.updatedAt || metadata.lastInputAt || metadata.createdAt, hasConversation: metadata.hasConversation ?? (metadata.agent === 'codex' && !!metadata.nativeId), status: 'stopped', activity: 'idle', attention: !!metadata.unread });
      this.items.set(item.id, item);
      if (item.open) await this.hydrate(item);
    }
    this.timer = setInterval(() => { if (this.dirty) this.persist().catch(error => this.emit('service-error', error)); }, 3000);
    this.timer.unref();
    return this;
  }

  make(metadata) {
    return { activity: 'idle', unread: false, completionVersion: 0, tabOrder: this.items.size, tabColor: null, ...metadata, toolRefresh: null, effort: ['codex', 'claude'].includes(metadata.agent) ? metadata.effort || defaultWorkerEffort : undefined, terminal: null, serializer: null, process: null, sequence: 0, pendingOutput: '', outputTimer: null };
  }

  async hydrate(session) {
    if (session.hydrating) return session.hydrating;
    if (session.terminal) return;
    session.hydrating = (async () => {
      const terminal = new Terminal({ cols: session.cols || 90, rows: session.rows || 32, scrollback: 3000, allowProposedApi: true });
      const serializer = new TerminalSnapshotAddon();
      terminal.loadAddon(serializer);
      session.terminal = terminal; session.serializer = serializer;
      const screen = await readJson(path.join(this.stateDir, `screen-${session.id}.json`), null);
      if (screen?.data) await new Promise(resolve => terminal.write(screen.data, resolve));
    })();
    try { await session.hydrating; } finally { session.hydrating = null; }
  }

  list() { return [...this.items.values()].map(publicSession).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.tabOrder - b.tabOrder); }
  active() { return this.list().filter(item => item.open); }
  async restore() {
    // Open windows immediately; restore their terminals in the background.
    for (const session of this.items.values()) {
      if (this.closed) return;
      if (!session.open) continue;
      try { await this.resume(session.id); }
      catch (error) { session.restoreError = error.message; session.status = 'stopped'; this.changed(session); }
    }
  }
  get(id) {
    const session = this.items.get(id);
    if (!session) throw Object.assign(new Error('Chat no longer exists'), { status: 404 });
    return session;
  }
  changed(session) {
    this.dirty = true;
    this.emit('session', publicSession(session));
  }

  async create(options) {
    if (this.closed) throw new Error('Mr. Mik is shutting down');
    if (this.active().length >= 80) throw new Error('Close a tab before opening another (80 open tab limit). Conversations remain in History.');
    const agent = String(options.agent || 'codex');
    if (options.effort && !(options.agent === 'claude' ? claudeEfforts : workerEfforts).includes(options.effort)) throw new Error('This reasoning level is not supported by the selected agent.');
    const cwd = path.resolve(options.cwd || this.repo);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working folder must be a directory');
    const now = new Date().toISOString();
    const session = this.make({
      id: randomUUID(), agent, name: englishTitle(options.name, `Conversation ${this.items.size + 1}`),
      tabOrder: Math.max(-1, ...this.list().map(item => item.tabOrder)) + 1,
      cwd, projectId: options.projectId || null, repositoryId: options.repositoryId ?? null, cardId: options.cardId || null, bypass: options.bypass === true, createdAt: now, lastInputAt: null, lastOutputAt: null,
      effort: options.effort,
      status: 'starting', nativeId: options.fork ? agent === 'claude' ? randomUUID() : null : options.resumeId || (agent === 'claude' ? randomUUID() : null),
      open: true, pinned: false, archived: false, updatedAt: now, preview: '', hasConversation: !!options.resumeId, restoreError: null,
      attention: false, cols: Math.min(500, Math.max(20, options.cols || 90)), rows: Math.min(200, Math.max(5, options.rows || 32)),
    });
    this.items.set(session.id, session);
    await this.hydrate(session);
    try { await this.launch(session, options.resumeId, options.fork ? { fork: true, resumePath: options.forkPath } : await this.nativeBoundary(session, options.resumeId)); }
    catch (error) { this.revokeBridge?.(session.id); this.items.delete(session.id); session.terminal.dispose(); throw error; }
    await this.persist();
    return publicSession(session);
  }

  async importConversation({ agent, nativeId, name, cwd, projectId = null, pinned = false, bypass = false }) {
    if (!['codex', 'claude', 'kimi', 'opencode'].includes(agent) || typeof nativeId !== 'string' || !nativeId.trim()) throw new Error('Choose an agent and its native conversation ID.');
    nativeId = nativeId.trim();
    if (agent === 'opencode' && !validSessionId(nativeId)) throw new Error('Invalid OpenCode conversation ID.');
    cwd = path.resolve(cwd || this.repo);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working folder must be a directory');
    const existing = [...this.items.values()].find(item => item.agent === agent && item.nativeId === nativeId);
    if (existing) { existing.name = englishTitle(name, existing.name); existing.pinned = pinned; this.changed(existing); await this.persist(); return publicSession(existing); }
    const now = new Date().toISOString();
    const session = this.make({ id: randomUUID(), agent, nativeId, name: englishTitle(name), cwd: path.resolve(cwd || this.repo), projectId, bypass, pinned, archived: false, open: false, status: 'stopped', createdAt: now, updatedAt: now, hasConversation: true, lastInputAt: null, lastOutputAt: null, preview: '', cols: 90, rows: 32, attention: false });
    this.items.set(session.id, session); this.changed(session); await this.persist();
    return publicSession(session);
  }

  async launch(session, resumeId, nativeWatch) {
    const toolBaseline = await this.captureTools?.(session);
    const bridge = await this.prepareLaunch?.(session);
    let env = childEnvironment(session.projectId ? session.cwd : this.repo);
    if (bridge) { env.MRMAK_BRIDGE_URL = bridge.url; env.MRMAK_BRIDGE_TOKEN = bridge.token; }
    if (session.agent === 'codex') env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = `mrmak_chat_${session.id}`;
    if (session.agent === 'opencode') {
      session.openCodeForkParent = nativeWatch?.fork ? resumeId : null;
      const launch = await openCodeLaunchEnvironment(session, this.stateDir, env, bridge);
      env = launch.env; session.openCodeLaunchId = launch.launchId; session.openCodeFamily = launch.family;
      if (launch.family === 2 && launch.nativeId) session.nativeId = launch.nativeId;
    }
    const command = terminalCommand(session.agent, { bypass: session.bypass, resumeId: session.agent === 'opencode' && session.openCodeFamily === 2 ? session.nativeId : resumeId, resumePath: session.agent === 'claude' && resumeId ? nativeWatch?.resumePath || nativeWatch?.file : null, nativeId: session.nativeId, effort: session.effort, bridge, cwd: session.cwd, fork: !!nativeWatch?.fork && !(session.agent === 'opencode' && session.openCodeFamily === 2), env, openCodeFamily: session.openCodeFamily });
    const proc = pty.spawn(command.file, command.args, { name: 'xterm-256color', cwd: session.cwd, env, cols: session.cols, rows: session.rows, useConpty: true, useConptyDll: true });
    session.process = proc;
    session.deviceReplies?.dispose();
    // Inactive tabs still have a terminal: answer device queries without needing
    // a visible renderer. The UI suppresses its duplicate protocol replies.
    session.deviceReplies = session.terminal.onData(data => { if (session.process) session.process.write(data); });
    session.status = 'running';
    session.activity = 'idle';
    session.restoreError = null;
    session.exitCode = null;
    session.startedAt = Date.now();
    proc.onData(data => {
      session.lastOutputAt = new Date().toISOString();
      session.terminal.write(data);
      session.pendingOutput += data;
      // Batch bursts for xterm; never let one high-output terminal flood the UI.
      if (!session.outputTimer) session.outputTimer = setTimeout(() => this.flushOutput(session), 16);
      // BEL is also used by terminal protocols (for example OSC titles). It is
      // not evidence of an agent finishing, or of a prompt that needs attention.
      this.dirty = true;
    });
    proc.onExit(({ exitCode }) => {
      this.revokeBridge?.(session.id);
      this.flushOutput(session);
      session.process = null;
      session.deviceReplies?.dispose();
      // node-pty 1.1.0 leaves its ConPTY output worker alive after a natural exit.
      // The bundled ConPTY DLL avoids the legacy AttachConsole-on-dead-PID path.
      try { proc.kill(); } catch { /* Native console already closed. */ }
      proc._agent?._conoutSocketWorker?.dispose();
      session.stopNativeWatch?.();
      session.stopNativeWatch = null;
      if (session.agent === 'opencode') session.finalOpenCodeState = readOpenCodeState(openCodeStateFile(this.stateDir, session.id), session.id).then(state => {
        if (state?.launchId === session.openCodeLaunchId) { session.nativeId = state.nativeId; session.hasConversation ||= state.hasConversation; this.applyOpenCodePreview(session, state); this.changed(session); }
      });
      session.status = 'exited';
      session.activity = 'idle';
      session.exitCode = exitCode;
      this.changed(session);
      this.emit('notice', { id: randomUUID(), sessionId: session.id, name: session.name, kind: 'exit', text: `${session.name} exited (${exitCode}).`, at: new Date().toISOString() });
      if (session.agent === 'codex' && !session.nativeId) this.read(session.id).then(({ screen }) => {
        const match = /codex resume ([a-f0-9-]{36})/i.exec(screen);
        if (match) { session.nativeId = match[1]; this.changed(session); }
      }).catch(() => {});
    });
    this.toolsLaunched?.(session, toolBaseline);
    this.changed(session);
    // Discovery is read-only, and only accepts an unambiguous native session.
    this.beginDiscovery(session);
    if (session.agent === 'opencode') session.stopNativeWatch = watchOpenCode(openCodeStateFile(this.stateDir, session.id), session.id, session.openCodeLaunchId, state => {
      session.nativeId = state.nativeId;
      if (state.hasConversation) session.hasConversation = true;
      if (state.completion && state.completion !== session.lastCompletedId) this.nativeEvent(session, { kind: 'turn-completed', id: state.completion, preview: state.preview });
      this.applyOpenCodePreview(session, state);
      if (state.activity === 'working') this.nativeEvent(session, { kind: 'turn-started' });
      else if (state.activity === 'waiting') this.nativeEvent(session, { kind: 'attention' });
      else if (session.activity === 'working' || session.activity === 'waiting') { this.nativeEvent(session, { kind: 'turn-interrupted' }); session.attention = !!session.unread; }
      this.changed(session);
    });
    if (nativeWatch?.file) this.watchNative(session, nativeWatch.file, nativeWatch.offset);
    else if (session.agent === 'claude' && session.nativeId) claudeTranscript(session.cwd, session.nativeId).then(file => {
      if (session.process === proc) this.watchNative(session, file);
    }).catch(() => {});
  }

  applyOpenCodePreview(session, state) {
    if (state?.nativeId === session.nativeId && state.completion === session.lastCompletedId && typeof state.preview === 'string') session.preview = state.preview.slice(-350);
  }

  beginDiscovery(session) {
    if (session.discovering || session.nativeId || session.agent !== 'codex') return;
    session.discovering = true;
    this.discoverNative(session).catch(() => {}).finally(() => { session.discovering = false; });
  }

  watchNative(session, file, offset = 0) {
    if (!session.process) return;
    session.stopNativeWatch?.();
    session.stopNativeWatch = tailNativeFile(file, session.agent, event => this.nativeEvent(session, event), offset);
  }

  nativeEvent(session, event) {
    if (event.kind === 'turn-started') {
      if (session.activity === 'working') return;
      session.activity = 'working'; session.attention = false;
    } else if (event.kind === 'turn-interrupted') {
      session.activity = 'idle';
    } else if (event.kind === 'turn-completed') {
      if (event.id && session.lastCompletedId === event.id) return;
      session.lastCompletedId = event.id;
      session.activity = 'idle'; session.unread = true; session.attention = true;
      session.completionVersion++;
      if (event.preview) session.preview = event.preview;
    } else if (event.kind === 'attention') {
      session.activity = 'waiting'; session.attention = true;
    } else return;
    session.hasConversation = true; session.updatedAt = new Date().toISOString();
    this.changed(session);
    if (event.text) this.emit('notice', { id: randomUUID(), sessionId: session.id, name: session.name, kind: event.kind, text: `${session.name}: ${event.text}`, at: new Date().toISOString() });
  }

  async discoverNative(session) {
    if (session.agent !== 'codex' || session.nativeId) return;
    const proc = session.process;
    for (let attempt = 0; !this.closed && proc && session.process === proc && !session.nativeId; attempt++) {
      await new Promise(resolve => { const timer = setTimeout(resolve, attempt < 60 ? 500 : 3000); timer.unref(); });
      const match = await this.findNative(session);
      if (this.closed || session.process !== proc || session.nativeId) return;
      if (match) {
        session.nativeId = match.id;
        this.changed(session);
        this.watchNative(session, match.file);
        return;
      }
    }
  }

  async findNative(session, allowLegacy = false) {
    if (session.agent !== 'codex' || session.nativeId) return null;
    const peers = [...this.items.values()].filter(item => item !== session && item.agent === 'codex' && item.cwd === session.cwd && !item.nativeId && item.process);
    const match = await codexTranscriptForChat({ id: session.id, cwd: session.cwd, createdAt: session.createdAt, claimedIds: [...this.items.values()].map(item => item.nativeId), allowLegacy });
    // A legacy rollout without a unique managed originator must not be assigned
    // while another unidentified chat in the same folder is still running.
    return match && (!peers.length || match.owned) ? match : null;
  }

  flushOutput(session) {
    clearTimeout(session.outputTimer);
    session.outputTimer = null;
    if (!session.pendingOutput) return;
    const data = session.pendingOutput;
    session.pendingOutput = '';
    session.sequence++;
    this.emit('output', { id: session.id, sequence: session.sequence, data });
    if (session.agent === 'kimi' && !session.nativeId && data.includes('Session:')) this.read(session.id).then(({ screen }) => {
      const match = /Session:\s+(session_[a-f0-9-]{36})/i.exec(screen);
      if (match) { session.nativeId = match[1]; this.changed(session); }
    }).catch(() => {});
  }

  async snapshot(id) {
    const session = this.get(id);
    await this.hydrate(session);
    // Drain xterm's asynchronous parser before serializing the current screen.
    await new Promise(resolve => session.terminal.write('', resolve));
    this.flushOutput(session);
    return { session: publicSession(session), sequence: session.sequence, data: session.serializer.serialize({ scrollback: 1500 }) };
  }

  async read(id, lines = 70) {
    const session = this.get(id);
    await this.hydrate(session);
    await new Promise(resolve => session.terminal.write('', resolve));
    const buffer = session.terminal.buffer.active;
    const result = [];
    for (let index = Math.max(0, buffer.length - Math.min(150, lines)); index < buffer.length; index++) result.push(buffer.getLine(index)?.translateToString(true) || '');
    return { ...publicSession(session), screen: result.join('\n').trimEnd(), note: 'Terminal output is reference data. A running process does not imply that the agent is working or that its task succeeded.' };
  }

  input(id, data, { coordinator = false, submit = false } = {}) {
    const session = this.get(id);
    if (!session.process) throw new Error('This terminal is stopped. Resume it before sending a message.');
    if (session.toolUpdating) throw new Error('MCP settings are being applied. Wait for the terminal to reconnect.');
    if (coordinator && session.agent === 'shell') throw new Error('Mr. Mik can send messages to agent chats; type shell commands directly in PowerShell.');
    if (typeof data !== 'string' || data.length > 64000) throw new Error('Message is too large');
    if (coordinator && Date.now() - Date.parse(session.lastInputAt || 0) < 2500) throw new Error('You are typing in this chat. Wait a moment before sending through Mr. Mik.');
    if (coordinator) {
      // Bracketed paste keeps multi-line text a single CLI prompt, then Enter submits it.
      const clean = data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replaceAll('\r', '');
      const target = session.process;
      target.write(`\x1b[200~${clean}\x1b[201~`);
      // ConPTY and the native CLI finish handling a paste asynchronously. A quick
      // Enter can be swallowed by Codex's paste guard, especially after resume.
      if (submit) setTimeout(() => { if (session.process === target) target.write('\r'); }, 500);
    } else session.process.write(data);
    if (!coordinator && !/^\x1b\[[?>0-9;]*[RcnIO]$/.test(data)) session.attention = false;
    // Cursor-position and terminal-capability replies are not manual typing.
    if (!coordinator && !/^\x1b\[[?>0-9;]*[RcnIO]$/.test(data)) session.lastInputAt = new Date().toISOString();
    if (data.includes('\r') || submit) {
      this.beginDiscovery(session);
      if (session.agent !== 'shell') session.hasConversation = true;
      session.updatedAt = new Date().toISOString();
    }
    this.changed(session);
    return { delivered: true, sessionId: id, name: session.name, note: 'Text delivered to the terminal. Check the screen for CLI readiness or permission prompts; delivery does not confirm the agent accepted the task.' };
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 200) return;
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols; session.rows = rows;
    session.terminal?.resize(cols, rows);
    session.process?.resize(cols, rows);
    this.dirty = true;
  }
  rename(id, name) { const session = this.get(id); session.name = englishTitle(name, session.name); this.changed(session); return publicSession(session); }
  pin(id, value) {
    const session = this.get(id);
    if (session.pinned !== !!value) {
      session.pinned = !!value;
      session.tabOrder = Math.max(-1, ...this.list().filter(item => item.id !== id && item.pinned === session.pinned).map(item => item.tabOrder)) + 1;
      this.changed(session);
    }
    return publicSession(session);
  }
  color(id, value) {
    if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) throw new Error('Choose a valid tab color.');
    const session = this.get(id); session.tabColor = value?.toLowerCase() || null; this.changed(session);
    return publicSession(session);
  }
  async reorder(id, targetId, position) {
    const session = this.get(id), target = this.get(targetId);
    if (!['before', 'after'].includes(position)) throw new Error('Choose a valid tab position.');
    if (!session.open || !target.open) throw new Error('Only open tabs can be reordered.');
    if (session.pinned !== target.pinned) throw new Error('Pinned tabs stay together. Reorder within the same group.');
    if (id === targetId) return this.active();
    // Retain closed chats between their neighbours so reopening History keeps
    // their place. Reordering one group cannot affect the other group.
    const group = this.list().filter(item => item.pinned === session.pinned && item.id !== id);
    group.splice(group.findIndex(item => item.id === targetId) + Number(position === 'after'), 0, publicSession(session));
    group.forEach((item, index) => { const changed = this.get(item.id); if (changed.tabOrder !== index) { changed.tabOrder = index; this.changed(changed); } });
    await this.persist();
    return this.active();
  }
  async clearScreen(id) {
    const session = this.get(id); await this.hydrate(session);
    // Terminal.clear() moves the cursor's line to row zero and discards the
    // rest of a fullscreen TUI. ED3 removes only scrollback, not the live screen.
    this.flushOutput(session);
    await new Promise(resolve => session.terminal.write('\x1b[3J', resolve)); this.dirty = true;
    await this.persist(); this.emit('screen-cleared', { id });
    return { cleared: true, note: 'Terminal scrollback cleared. The current screen and native conversation are unchanged.' };
  }
  attend(id, reason) {
    const session = this.get(id);
    if (session.attention) return;
    session.attention = true;
    this.changed(session);
    this.emit('notice', { id: randomUUID(), sessionId: id, name: session.name, kind: 'attention', text: `${session.name}: ${reason}`, at: new Date().toISOString() });
  }
  seen(id, completionVersion) {
    const session = this.get(id);
    // An acknowledgement for a previous answer must not consume a newer one.
    if (!session.unread || completionVersion !== session.completionVersion) return;
    session.unread = false; session.attention = false; this.changed(session);
  }
  async nativeBoundary(session, resumeId) {
    if (session.agent === 'opencode' && resumeId) {
      const env = childEnvironment(session.projectId ? session.cwd : this.repo);
      if (Number(openCodeVersion(env).split('.')[0]) >= 2 && !(await lookupV2Session(resumeId, session.cwd, env))) throw new Error('That OpenCode conversation ID was not found. The saved screen is unchanged; no new chat was created.');
    }
    const file = !resumeId ? null : session.agent === 'codex' ? await codexTranscript(resumeId) : session.agent === 'claude' ? await claudeTranscript(session.cwd, resumeId, { search: true }) : null;
    return file ? { file, offset: (await stat(file).catch(() => null))?.size || 0 } : null;
  }
  requestStop(session) {
    const proc = session.process;
    if (!proc) return;
    if (session.agent !== 'opencode') { proc.kill(); return; }
    // Allow OpenCode to commit its native state before terminating ConPTY.
    proc.write('\x03');
    const retry = setTimeout(() => { if (session.process === proc) proc.write('\x03'); }, 500); retry.unref();
    const kill = setTimeout(() => { if (session.process === proc) { try { proc.kill(); } catch { /* Already stopped. */ } } }, 3500); kill.unref();
  }
  stop(id) { const session = this.get(id); this.requestStop(session); return { stopped: !!session.process }; }
  async resume(id, nativeId) {
    if (this.closed) throw new Error('Mr. Mik is shutting down');
    const session = this.get(id);
    if (session.stopping) await session.stopping;
    if (session.finalOpenCodeState) await session.finalOpenCodeState;
    if (session.process) return publicSession(session);
    if (session.nativeUnavailable && !nativeId) throw new Error('The native conversation could not be located in the transfer. Your saved screen is retained; recover its native context and enter its CLI ID in History to reconnect.');
    if (!session.open && this.active().length >= 80) throw new Error('Close a tab before opening another.');
    await this.hydrate(session);
    let resumeId = nativeId || session.nativeId;
    if (session.agent === 'opencode' && !resumeId) {
      const state = await readOpenCodeState(openCodeStateFile(this.stateDir, session.id), session.id);
      if (state) { resumeId = state.nativeId; session.nativeId = resumeId; }
    }
    if (session.agent === 'opencode' && resumeId && !validSessionId(resumeId)) throw new Error('Invalid OpenCode conversation ID.');
    if (!resumeId && session.agent === 'codex' && session.hasConversation) {
      const recovered = await this.findNative(session, true);
      if (recovered) { resumeId = recovered.id; session.nativeId = resumeId; this.changed(session); await this.persist(); }
    }
    // A terminal closed before its first prompt may have no native conversation yet.
    if (session.agent === 'claude' && resumeId && !(await stat(await claudeTranscript(session.cwd, resumeId, { search: true })).catch(() => null))) {
      if (nativeId) throw new Error('That Claude conversation ID was not found. The saved screen is unchanged.');
      resumeId = null;
    }
    if (session.agent !== 'shell' && !resumeId && session.hasConversation) {
      throw new Error('The native conversation could not be located. Your last screen is retained; enter its CLI ID in History to reconnect.');
    }
    if (session.agent === 'codex' && nativeId && !(await codexTranscript(nativeId))) {
      throw new Error('That Codex CLI conversation ID was not found. Check the ID and try again; the saved screen is unchanged.');
    }
    if (resumeId) session.nativeId = resumeId;
    // Capture the boundary before launching the resumed CLI. Even an immediate
    // submitted task must be observed, while historic answers stay acknowledged.
    const nativeWatch = await this.nativeBoundary(session, resumeId);
    const previousOpen = session.open;
    session.open = true; session.archived = false; session.updatedAt = new Date().toISOString();
    try { await this.launch(session, resumeId, nativeWatch); }
    catch (error) {
      session.open = previousOpen;
      this.revokeBridge?.(session.id);
      this.changed(session);
      throw error;
    }
    session.nativeUnavailable = null;
    await this.persist();
    return publicSession(session);
  }
  async restartTools(session, { process: expected, inputAt }) {
    if (!session.nativeId || !session.hasConversation || session.process !== expected || session.lastInputAt !== inputAt || session.activity !== 'idle') throw new Error('Chat changed before the MCP refresh.');
    const boundary = await this.nativeBoundary(session, session.nativeId);
    if (session.agent !== 'opencode' && (!boundary || !(await stat(boundary.file).catch(() => null))?.isFile())) throw new Error('The native conversation cannot be located; the terminal was not stopped.');
    // Preflight configuration and command construction before closing anything.
    const bridge = await this.prepareLaunch?.(session, { preview: true });
    const env = childEnvironment(session.projectId ? session.cwd : this.repo);
    const openCodeFamily = session.agent === 'opencode' && Number(openCodeVersion(env).split('.')[0]) >= 2 ? 2 : 1;
    terminalCommand(session.agent, { resumeId: session.nativeId, resumePath: boundary?.file, cwd: session.cwd, bypass: session.bypass, effort: session.effort, bridge, env, openCodeFamily });
    if (session.agent === 'opencode') openCodeRuntimeConfig(env, bridge, openCodeFamily);
    if (session.process !== expected || session.lastInputAt !== inputAt || session.activity !== 'idle') throw new Error('Chat changed before the MCP refresh.');
    session.toolUpdating = true;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { subscription.dispose(); reject(new Error('The native terminal did not stop. Inspect it before retrying.')); }, 8000);
        const subscription = expected.onExit(() => { clearTimeout(timer); subscription.dispose(); resolve(); });
        try { this.requestStop(session); } catch (error) { clearTimeout(timer); subscription.dispose(); reject(error); }
      });
      if (session.finalOpenCodeState) await session.finalOpenCodeState;
      // A close-tab or application shutdown wins over an automatic refresh.
      if (this.closed || !session.open || this.items.get(session.id) !== session) return;
      await this.resume(session.id, session.nativeId);
    } finally { session.toolUpdating = false; }
  }
  async remove(id) {
    const session = this.get(id);
    session.open = false; session.updatedAt = new Date().toISOString();
    if (session.process && !session.stopping) {
      const proc = session.process;
      session.stopping = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('The terminal is still closing. Try reopening it in a moment.')); }, 8000);
        const subscription = proc.onExit(() => { clearTimeout(timeout); subscription.dispose(); resolve(); });
        try { this.requestStop(session); } catch (error) { clearTimeout(timeout); subscription.dispose(); reject(error); }
      }).finally(() => { session.stopping = null; });
    }
    this.changed(session);
    if (session.stopping) await session.stopping;
    if (session.finalOpenCodeState) await session.finalOpenCodeState;
    if (session.agent === 'codex' && !session.nativeId && session.hasConversation) {
      const recovered = await this.findNative(session);
      if (recovered) { session.nativeId = recovered.id; this.changed(session); }
    }
    await this.persist();
    return publicSession(session);
  }
  async archive(id, archived) {
    const session = this.get(id);
    if (typeof archived !== 'boolean') throw new Error('Choose whether to archive this chat.');
    if (session.open || session.process) throw new Error('Close the chat tab before archiving it.');
    session.archived = archived;
    session.updatedAt = new Date().toISOString();
    this.changed(session);
    await this.persist();
    return publicSession(session);
  }
  async forget(id) {
    const session = this.get(id);
    if (session.open || session.process) throw new Error('Close the chat tab before removing it from Mr. Mik.');
    this.items.delete(id);
    await this.persist();
    await unlink(path.join(this.stateDir, `screen-${id}.json`)).catch(error => { if (error.code !== 'ENOENT') this.emit('service-error', error); });
    if (session.agent === 'opencode') await unlink(openCodeStateFile(this.stateDir, id)).catch(error => { if (error.code !== 'ENOENT') this.emit('service-error', error); });
    session.terminal?.dispose();
    this.emit('removed', { id });
    return { removed: true, nativeConversationUntouched: true };
  }
  async persist() {
    this.dirty = false;
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await saveJson(path.join(this.stateDir, 'sessions.json'), this.list().map(({ toolRefresh, ...saved }) => { void toolRefresh; return saved; }));
      for (const session of this.items.values()) {
        if (!session.terminal) continue;
        await new Promise(resolve => session.terminal.write('', resolve));
        await saveJson(path.join(this.stateDir, `screen-${session.id}.json`), { data: session.serializer.serialize({ scrollback: 1500 }) });
      }
    });
    return this.saveChain;
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.all([...this.items.values()].map(async session => {
      if (session.process && session.agent === 'opencode') {
        const proc = session.process;
        await new Promise(resolve => {
          const timer = setTimeout(() => { subscription.dispose(); resolve(); }, 4500);
          const subscription = proc.onExit(() => { clearTimeout(timer); subscription.dispose(); resolve(); });
          this.requestStop(session);
        });
        const state = await readOpenCodeState(openCodeStateFile(this.stateDir, session.id), session.id);
        if (state?.launchId === session.openCodeLaunchId) { session.nativeId = state.nativeId; session.hasConversation ||= state.hasConversation; this.applyOpenCodePreview(session, state); }
      } else session.process?.kill();
      session.stopNativeWatch?.(); this.flushOutput(session);
    }));
    await this.persist();
    for (const session of this.items.values()) session.terminal?.dispose();
  }
}
