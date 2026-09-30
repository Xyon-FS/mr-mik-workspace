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

const { Terminal } = headless;
const publicSession = session => {
  const { id, name, agent, cwd, bypass, effort, status, createdAt, lastOutputAt, lastInputAt, exitCode, nativeId, attention, activity, unread, completionVersion, lastCompletedId, cols, rows, open, pinned, tabOrder, tabColor, updatedAt, preview, hasConversation, restoreError } = session;
  return { id, name, agent, cwd, projectId: session.projectId || null, repositoryId: session.repositoryId ?? null, cardId: session.cardId || null, bypass, effort, status, createdAt, lastOutputAt, lastInputAt, exitCode, nativeId, attention, activity, unread, completionVersion, lastCompletedId, cols, rows, open, pinned, archived: !!session.archived, tabOrder, tabColor, updatedAt, preview, hasConversation, restoreError };
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
    return { activity: 'idle', unread: false, completionVersion: 0, tabOrder: this.items.size, tabColor: null, ...metadata, effort: ['codex', 'claude'].includes(metadata.agent) ? metadata.effort || defaultWorkerEffort : undefined, terminal: null, serializer: null, process: null, sequence: 0, pendingOutput: '', outputTimer: null };
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
    if (!['codex', 'claude', 'kimi'].includes(agent) || typeof nativeId !== 'string' || !nativeId.trim()) throw new Error('Choose an agent and its native conversation ID.');
    nativeId = nativeId.trim();
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
    const bridge = await this.prepareLaunch?.(session);
    const command = terminalCommand(session.agent, { bypass: session.bypass, resumeId, resumePath: session.agent === 'claude' && resumeId ? nativeWatch?.resumePath || nativeWatch?.file : null, nativeId: session.nativeId, effort: session.effort, bridge, cwd: session.cwd, fork: !!nativeWatch?.fork });
    const env = childEnvironment(session.projectId ? session.cwd : this.repo);
    if (bridge) { env.MRMAK_BRIDGE_URL = bridge.url; env.MRMAK_BRIDGE_TOKEN = bridge.token; }
    if (session.agent === 'codex') env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = `mrmak_chat_${session.id}`;
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
    this.changed(session);
    // Discovery is read-only, and only accepts an unambiguous native session.
    this.beginDiscovery(session);
    if (nativeWatch?.file) this.watchNative(session, nativeWatch.file, nativeWatch.offset);
    else if (session.agent === 'claude' && session.nativeId) claudeTranscript(session.cwd, session.nativeId).then(file => {
      if (session.process === proc) this.watchNative(session, file);
    }).catch(() => {});
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
    session.terminal.clear(); this.dirty = true;
    await this.persist(); this.emit('screen-cleared', { id });
    return { cleared: true, note: 'Visible scrollback cleared. The native agent conversation is unchanged.' };
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
    const file = !resumeId ? null : session.agent === 'codex' ? await codexTranscript(resumeId) : session.agent === 'claude' ? await claudeTranscript(session.cwd, resumeId, { search: true }) : null;
    return file ? { file, offset: (await stat(file).catch(() => null))?.size || 0 } : null;
  }
  stop(id) { const session = this.get(id); session.process?.kill(); return { stopped: !!session.process }; }
  async resume(id, nativeId) {
    if (this.closed) throw new Error('Mr. Mik is shutting down');
    const session = this.get(id);
    if (session.stopping) await session.stopping;
    if (session.process) return publicSession(session);
    if (!session.open && this.active().length >= 80) throw new Error('Close a tab before opening another.');
    await this.hydrate(session);
    let resumeId = nativeId || session.nativeId;
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
    await this.persist();
    return publicSession(session);
  }
  async remove(id) {
    const session = this.get(id);
    session.open = false; session.updatedAt = new Date().toISOString();
    if (session.process && !session.stopping) {
      const proc = session.process;
      session.stopping = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('The terminal is still closing. Try reopening it in a moment.')); }, 8000);
        const subscription = proc.onExit(() => { clearTimeout(timeout); subscription.dispose(); resolve(); });
        try { proc.kill(); } catch (error) { clearTimeout(timeout); subscription.dispose(); reject(error); }
      }).finally(() => { session.stopping = null; });
    }
    this.changed(session);
    if (session.stopping) await session.stopping;
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
    session.terminal?.dispose();
    this.emit('removed', { id });
    return { removed: true, nativeConversationUntouched: true };
  }
  async persist() {
    this.dirty = false;
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await saveJson(path.join(this.stateDir, 'sessions.json'), this.list());
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
    for (const session of this.items.values()) { session.stopNativeWatch?.(); session.process?.kill(); this.flushOutput(session); }
    await this.persist();
    for (const session of this.items.values()) session.terminal?.dispose();
  }
}
