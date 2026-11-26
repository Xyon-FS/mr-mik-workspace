import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { CodexChatTransport } from './codex-chat-transport.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export function codexWorkerEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(MRMAK_BRIDGE_URL|MRMAK_BRIDGE_TOKEN|MRMIK_BROWSER_ENDPOINT|MRMIK_BROWSER_TOKEN|CODEX_INTERNAL_ORIGINATOR_OVERRIDE)$/i.test(key)));
}
export async function codexWorkerKey({ account, file, args, cwd, env }) {
  if (!account || account.system || !account.profileId || !account.privateHome || !account.configRevision) return null;
  const revisions = [], names = new Set([path.join(account.privateHome, 'auth.json'), path.join(account.privateHome, 'config.toml')]);
  for (let folder = cwd; ; folder = path.dirname(folder)) {
    names.add(path.join(folder, '.codex', 'config.toml'));
    if (path.dirname(folder) === folder) break;
  }
  for (const name of names) {
    const info = await stat(name).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.size > 4 * 1024 * 1024)) return null;
    revisions.push([name, info ? digest(await readFile(name)) : null]);
  }
  return digest(JSON.stringify(stable({ profile: account.profileId, home: account.privateHome, store: account.conversationStoreId, config: account.configRevision, file, args, cwd, env: codexWorkerEnvironment(env), revisions })));
}

// Service-local only: never serialize workers, credentials or attachment state.
export class CodexWorkerPool {
  constructor({ maxIdle = 0, idleTtlMs = 300000, onCleanupError = () => {} } = {}) {
    this.workers = new Map(); this.retained = new Set(); this.closed = false;
    this.maxIdle = maxIdle; this.idleTtlMs = idleTtlMs; this.maintenance = Promise.resolve(); this.onCleanupError = onCleanupError;
  }
  configure({ maxIdle, idleTtlMs = this.idleTtlMs }) { this.maxIdle = maxIdle; this.idleTtlMs = idleTtlMs; }
  async retire(worker) { this.quarantine(worker); await worker.transport.close(); }
  trim() {
    const operation = this.maintenance.catch(() => {}).then(async () => {
      for (;;) {
        const idle = [...this.retained].filter(worker => !worker.users.size && !worker.transport.closed).sort((a, b) => a.idleAt - b.idleAt);
        if (idle.length <= this.maxIdle) break;
        await this.retire(idle[0]); // Recheck ownership after every asynchronous exit.
      }
    });
    this.maintenance = operation; return operation;
  }
  async invalidate(profileId = null) {
    const workers = [...this.retained].filter(worker => !profileId || worker.profileId === profileId);
    for (const worker of workers) this.quarantine(worker);
    // An account/config action must not kill real chat attachments.
    await Promise.all(workers.filter(worker => ![...worker.users].some(user => user.kind !== 'preparation')).map(worker => this.retire(worker)));
  }
  async discardPreparation() {
    await Promise.all([...this.retained].filter(worker => worker.users.size && [...worker.users].every(user => user.kind === 'preparation')).map(worker => this.retire(worker)));
  }
  async preparationRoom(key) {
    await this.maintenance;
    if (this.workers.has(key)) return;
    for (;;) {
      const idle = [...this.retained].filter(worker => !worker.users.size).sort((a, b) => a.idleAt - b.idleAt);
      if (!idle.length || idle.length < this.maxIdle) return;
      await this.retire(idle[0]);
    }
  }
  acquire(key, { file, args, cwd, env, spawnChild, profileId, kind = 'chat' }) {
    if (this.closed) throw new Error('The Codex worker pool is closing.');
    if ([...this.retained].reduce((count, worker) => count + [...worker.users].filter(user => user.closing).length, 0) >= 8) throw new Error('Several Codex conversations are still closing. Wait for their cleanup before opening another.');
    let worker = this.workers.get(key);
    if (!worker || worker.transport.closed || !worker.accepting) {
      const transport = new CodexChatTransport({ spawnChild });
      worker = { key, transport, users: new Set(), accepting: true, profileId, idleAt: 0 };
      this.workers.set(key, worker); this.retained.add(worker);
      transport.once('exit', () => { this.retained.delete(worker); if (this.workers.get(key) === worker) this.workers.delete(key); });
      transport.on('fault', () => {
        this.quarantine(worker);
        if (![...worker.users].some(user => user.kind !== 'preparation')) void this.retire(worker).catch(error => { worker.cleanupError = error; this.onCleanupError(error); });
      });
      try { transport.start(file, args, { cwd, env: { ...codexWorkerEnvironment(env), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: `mrmak_worker_${randomUUID()}` }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { this.quarantine(worker); this.retained.delete(worker); throw error; }
    }
    clearTimeout(worker.idleTimer); worker.idleTimer = null;
    const user = { kind }; worker.users.add(user);
    return {
      transport: worker.transport,
      discard: async () => {
        this.quarantine(worker); worker.users.delete(user);
        if (!worker.users.size || [...worker.users].every(item => item.kind === 'preparation' || item.abandoned)) await this.retire(worker);
      },
      release: detach => {
        if (user.releaseTask) return user.releaseTask;
        const task = (async () => {
          if (!worker.users.has(user)) return;
          user.closing = true;
          try {
            if (worker.users.size === 1 && (!this.maxIdle || !worker.accepting || this.closed)) await this.retire(worker);
            else if (!worker.transport.closed) await detach();
            worker.users.delete(user);
            if (worker.users.size && [...worker.users].every(item => item.abandoned) && !worker.transport.closed) await this.retire(worker);
            if (!worker.users.size && !worker.transport.closed) {
              if (!worker.accepting || this.closed || !this.maxIdle) await this.retire(worker);
              else {
                worker.idleAt = Date.now();
                const timer = setTimeout(() => {
                  if (worker.idleTimer !== timer || worker.users.size) return;
                  void this.retire(worker).catch(error => { worker.cleanupError = error; this.onCleanupError(error); });
                }, this.idleTtlMs);
                worker.idleTimer = timer; timer.unref(); await this.trim();
              }
            }
          } catch (error) {
            this.quarantine(worker);
            // Native hooks may delay unload. With no sibling, preserve the old
            // whole-process close path instead of caching an unfinished root.
            if (error.code === 'CODEX_UNLOAD_PENDING' && worker.users.size === 1) {
              await this.retire(worker); worker.users.delete(user); return;
            }
            throw error;
          }
        })();
        user.releaseTask = task;
        task.catch(() => { if (user.releaseTask === task) user.releaseTask = null; });
        return task;
      },
      abandon: async () => {
        user.abandoned = true; this.quarantine(worker);
        if ([...worker.users].every(item => item.abandoned)) await this.retire(worker);
      },
    };
  }
  quarantine(worker) { worker.accepting = false; clearTimeout(worker.idleTimer); worker.idleTimer = null; if (this.workers.get(worker.key) === worker) this.workers.delete(worker.key); }
  async close() {
    this.closed = true;
    await Promise.all([...this.retained].map(worker => this.retire(worker)));
  }
}
