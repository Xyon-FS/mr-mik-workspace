import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { codexBinary } from './agents.mjs';
import { NativeProfileProbe } from './codex-profile-probe.mjs';
import { codexWorkerKey } from './codex-worker-pool.mjs';
import { withCodexStoreStartup } from './codex-profile-layout.mjs';

export async function cliVerifierKey({ account, cwd, binary }) {
  const key = await codexWorkerKey({ account, cwd, file: binary.file, args: [...binary.args, 'app-server', '--stdio'], env: account.env });
  if (!key) return null;
  // Standalone CLI updates can replace a stable launcher/junction target.
  const files = await Promise.all([binary.file, ...binary.args.filter(value => path.isAbsolute(value))].map(async file => {
    const resolved = await realpath(file), info = await stat(resolved);
    return [resolved, info.size, info.mtimeMs, info.ino];
  }));
  return createHash('sha256').update(JSON.stringify([key, files])).digest('hex');
}

// One read-only compatibility process, never a terminal/conversation or a cache
// of successful verification results. Requests serialize; each runs its checks.
export class CodexCliVerifier {
  constructor({ idleTtlMs = 60000, key = cliVerifierKey, binary = codexBinary, createProbe = (cwd, env, options) => new NativeProfileProbe(cwd, env, options), onCleanupError = () => {} } = {}) {
    Object.assign(this, { idleTtlMs, key, binary, createProbe, onCleanupError });
    this.tail = Promise.resolve(); this.generation = 0; this.closed = false;
  }
  enqueue(task) {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
  async retire(entry = this.entry) {
    if (!entry) return;
    clearTimeout(entry.timer);
    await entry.probe.close();
    if (this.entry === entry) this.entry = null;
  }
  verify(account, cwd, check) {
    const generation = this.generation;
    const cancelled = () => this.closed || generation !== this.generation;
    const assertCurrent = () => { if (cancelled()) throw new Error('Codex account verification was cancelled. Reopen this chat.'); };
    return this.enqueue(async () => {
      assertCurrent();
      return withCodexStoreStartup(account.sqliteHome, async () => {
        assertCurrent();
        let entry = this.entry;
        try {
          if (entry) { clearTimeout(entry.timer); entry.timer = null; }
          const binary = this.binary(account.env);
          const key = await this.key({ account, cwd, binary });
          assertCurrent();
          if (this.entry && (!key || this.entry.key !== key || this.entry.probe.exited || this.entry.probe.closing)) await this.retire();
          assertCurrent();
          entry = this.entry ||= { key, profileId: account.profileId, probe: this.createProbe(cwd, account.env, { binary }) };
          await check(entry.probe);
          assertCurrent();
          // A legitimate native token refresh can change auth during the read.
          // Keep the completed checks, but never reuse that old process/key.
          const latest = await this.key({ account, cwd, binary: this.binary(account.env) });
          assertCurrent();
          if (!key || latest !== key || !this.idleTtlMs) await this.retire(entry);
          else {
            const timer = setTimeout(() => {
              void this.enqueue(async () => { if (this.entry === entry && entry.timer === timer) await this.retire(entry); }).catch(this.onCleanupError);
            }, this.idleTtlMs);
            entry.timer = timer; timer.unref();
          }
        } catch (error) {
          try { await this.retire(entry); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Codex verification failed and its probe requires cleanup.'); }
          throw error;
        }
      }, { isCancelled: cancelled });
    });
  }
  invalidate() {
    ++this.generation;
    if (this.entry) clearTimeout(this.entry.timer);
    // Abort only this service-owned reader, including an outstanding RPC.
    // Never signal an interactive CLI or a graphical worker.
    const closing = this.entry?.probe.close() || Promise.resolve();
    closing.catch(() => {});
    return this.enqueue(async () => { await closing; await this.retire(); });
  }
  close() {
    if (!this.closePromise) { this.closed = true; this.closePromise = this.invalidate(); }
    return this.closePromise;
  }
}
