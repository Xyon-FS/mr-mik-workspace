import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexBinary } from './agents.mjs';

// A bounded RPC client used for read-only compatibility probes and the explicit
// canonical-home setup flow. Raw native data never reaches the frontend.
export class NativeProfileProbe {
  constructor(cwd, env, { binary = codexBinary(env), spawnChild = spawn, onNotification, onExit } = {}) {
    this.cwd = cwd;
    this.pending = new Map(); this.sequence = 0; this.closing = false;
    this.child = spawnChild(binary.file, [...binary.args, 'app-server', '--stdio'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.diagnosticKinds = new Set();
    this.child.stderr.on('data', data => {
      // Fixed diagnostic categories only; never expose the raw native output.
      const text = String(data);
      for (const [kind, expression] of [['sqlite-busy', /database is locked|database is busy|SQLITE_BUSY/i], ['invalid-config', /config.*(?:invalid|error)|failed to (?:load|parse).*config/i], ['invalid-argument', /unexpected argument|unrecognized option/i], ['sqlite-initialization', /failed to initialize sqlite state runtime/i]]) if (expression.test(text)) this.diagnosticKinds.add(kind);
    });
    this.ended = new Promise(resolve => { const ended = () => { this.exited = true; this.fail(); onExit?.(); resolve(); }; this.child.once('exit', ended); this.child.once('error', ended); });
    this.child.stdin.on('error', () => this.fail());
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try {
        const message = JSON.parse(line), pending = this.pending.get(message.id);
        if (!pending) { if (message.method && message.id == null) onNotification?.(message); return; }
        if (message.error) pending.reject(new Error('Native profile compatibility RPC rejected.'));
        else pending.resolve(message.result);
      } catch { /* Unsolicited native output is deliberately discarded. */ }
    });
    // Initialization is lazy: every rejection has an attached caller.
  }
  fail() { for (const request of this.pending.values()) request.reject(new Error(`Native profile probe stopped (${this.child.exitCode ?? 'unknown'}; ${[...this.diagnosticKinds].join(',') || 'no-classified-diagnostic'}).`)); }
  async rpc(method, params, timeoutMs = 15000) {
    if (this.closing || this.exited) throw new Error('Native profile probe is closed.');
    const id = ++this.sequence; let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Native profile compatibility RPC timed out.'), { uncertain: true })), timeoutMs);
        this.pending.set(id, { resolve, reject });
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) reject(new Error('Native profile probe write failed.')); });
      });
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async initialize() {
    if (!this.ready) this.ready = this.rpc('initialize', { clientInfo: { name: 'mr_mik_account_compatibility', version: '1' } }).then(() => this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'));
    await this.ready;
  }
  async config() {
    await this.initialize();
    const result = await this.rpc('config/read', { cwd: this.cwd }), config = result?.config || {};
    return { cli_auth_credentials_store: config.cli_auth_credentials_store, sqlite_home: config.sqlite_home, model: config.model };
  }
  async modelLabel(config) {
    if (typeof config.model === 'string' && config.model.trim()) return config.model.trim();
    const catalog = await this.rpc('model/list', { limit: 100 }, 750);
    const selected = catalog?.data?.find(item => item.isDefault);
    return selected?.displayName || selected?.model || null;
  }
  async account() {
    await this.initialize();
    // False avoids forcing a refresh simply to inspect local account state.
    const result = await this.rpc('account/read', { refreshToken: false });
    const account = result?.account;
    if (!account) return null;
    return { type: account.type, email: typeof account.email === 'string' ? account.email : null };
  }
  close() {
    if (!this.closePromise) this.closePromise = (async () => {
      this.closing = true; this.fail(); this.lines.close();
      if (this.exited) return;
      this.child.stdin.end();
      let timer;
      try {
        const graceful = await Promise.race([this.ended.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
        if (graceful) return;
      } finally { clearTimeout(timer); }
      this.child.kill();
      try {
        const closed = await Promise.race([this.ended.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
        if (!closed) throw new Error('Native profile probe did not exit; retain its fixture.');
      } finally { clearTimeout(timer); }
    })();
    return this.closePromise;
  }
}
