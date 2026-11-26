import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CodexChatRouter } from './codex-chat-router.mjs';

// Owns one native process and its RPC namespace. Conversation state and grants
// remain in CodexChat. This transport is deliberately dedicated for now.
export class CodexChatTransport extends EventEmitter {
  constructor({ spawnChild = spawn } = {}) {
    super();
    this.spawnChild = spawnChild;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.router = new CodexChatRouter(message => this.send(message));
  }
  start(file, args, options) {
    if (this.child || this.closed) throw new Error('This Codex transport has already been started or closed.');
    this.child = this.spawnChild(file, args, options);
    this.ended = new Promise(resolve => { this.finishExit = resolve; });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch { this.emit('invalid'); }
    });
    // Native diagnostics may include account/config data; never forward them.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.emit('fault'));
    this.child.once('error', () => this.child.pid ? this.emit('fault') : this.disconnected());
    this.child.once('exit', code => this.disconnected(code));
  }
  initialize() {
    // Keep a failed initialization failed: retrying may duplicate delivery.
    this.initialization ||= this.rpc('initialize', { clientInfo: { name: 'mr_mik_graphical_worker', version: '1' }, capabilities: { experimentalApi: true } })
      .then(result => { this.send({ method: 'initialized' }); return result; });
    return this.initialization;
  }
  send(message) {
    if (!this.child || this.closed) throw new Error('Codex is disconnected. Reconnect before continuing.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  rpc(method, params, timeout = 30000, owner = null) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Codex did not confirm the request. Delivery may be uncertain; it has not been resent.'), { uncertain: true }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, owner });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (this.closed) return;
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(String(message.error.message ?? '').slice(0, 32000)), { nativeRejected: true }));
      else pending.resolve(message.result);
      return;
    }
    this.router.route(message);
    this.emit('message', message);
  }
  failPending(error) {
    for (const { timer, reject } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  failOwner(owner, error) {
    for (const [id, pending] of this.pending) if (pending.owner === owner) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); }
  }
  terminate() { this.child?.kill(); }
  disconnected(exitCode = 1) {
    if (this.closed) return;
    this.closed = true; this.lines?.close();
    this.failPending(new Error('Codex disconnected. Accepted input has not been resent.'));
    this.finishExit?.();
    this.emit('exit', exitCode);
    this.router.clear();
  }
  close() {
    if (!this.child || this.closed) return Promise.resolve();
    if (!this.closing) {
      const closing = this.closeProcess();
      this.closing = closing;
      // A failed shutdown retains ownership, but may be retried explicitly.
      closing.catch(() => { if (this.closing === closing) this.closing = null; });
    }
    return this.closing;
  }
  async closeProcess() {
    if (!this.child || this.closed) return;
    this.child.stdin.end();
    let timer;
    try { await Promise.race([this.ended, new Promise(resolve => { timer = setTimeout(() => { this.terminate(); resolve(); }, 1500); })]); }
    finally { clearTimeout(timer); }
    if (!this.closed) {
      try { await Promise.race([this.ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex worker did not exit; its lease is retained.')), 5000); })]); }
      finally { clearTimeout(timer); }
    }
  }
}
