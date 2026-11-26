// One selected context, no native root, grant, message, or serialized auth state.
export class CodexPreparation {
  constructor({ pool, resolve, verify, launch }) {
    Object.assign(this, { pool, resolve, verify, launch });
    this.generation = 0; this.running = Promise.resolve(); this.cancelling = Promise.resolve(); this.closed = false;
  }
  request(input, { delay = 200 } = {}) {
    if (this.closed || input && !this.pool.maxIdle) return;
    const signature = JSON.stringify(input);
    if (input && signature === this.signature && ['scheduled', 'preparing'].includes(this.status)) return;
    this.signature = signature; const generation = ++this.generation;
    // Drop only this optional reader's wait. A shared engine may already own
    // real chat requests; neither the process nor their RPCs can be cancelled.
    const discovery = this.discovery;
    clearTimeout(this.timer);
    this.cancelling = this.cancelling.catch(() => {}).then(() => {
      if (discovery) discovery.transport.failOwner(discovery.owner, new Error('Codex preparation context changed.'));
      // Select bare preparation workers before the rejected read can release
      // its lease into the idle cache. Adopted workers keep their real owner.
      return this.pool.discardPreparation();
    });
    if (!input) { this.status = 'cancelled'; return; }
    this.status = 'scheduled';
    this.timer = setTimeout(() => {
      const previous = this.running;
      this.running = this.run(input, generation, previous);
      // Public callers receive no private diagnostic payload or unhandled error.
      this.running.catch(error => this.pool.onCleanupError(error));
    }, delay);
    this.timer.unref();
  }
  async run(input, generation, previous) {
    let lease;
    const current = () => !this.closed && generation === this.generation && !this.pool.closed;
    try {
      await this.cancelling; await previous.catch(() => {});
      if (!current()) return;
      this.status = 'preparing';
      const context = await this.resolve(input);
      if (!context || !current()) { if (current()) { this.status = 'skipped'; this.signature = null; } return; }
      const launch = await this.launch(context);
      if (!launch.key || !current()) { if (current()) { this.status = 'skipped'; this.signature = null; } return; }
      await this.pool.preparationRoom(launch.key);
      if (!current()) return;
      lease = this.pool.acquire(launch.key, launch);
      await lease.transport.initialize();
      await this.verify(context, lease.transport);
      if (!current()) return;
      await lease.transport.rpc('model/list', {});
      if (!current()) return;
      // Warm native plugin/skill discovery for this selected working directory,
      // without creating a root or retaining a catalog in the application.
      // Foreground chats can adopt the engine while this optional read runs;
      // unsupported/slow discovery must not discard their verified transport.
      const discovery = { transport: lease.transport, owner: {} };
      this.discovery = discovery;
      try { await lease.transport.rpc('skills/list', { cwds: [launch.cwd] }, 5000, discovery.owner); }
      catch { /* Native thread startup still performs authoritative discovery. */ }
      finally { if (this.discovery === discovery) this.discovery = null; }
      if (!current()) return;
      // Check auth/config generation again after network work, without persisting it.
      const latest = await this.resolve(input);
      if (!latest || !current() || (await this.launch(latest)).key !== launch.key) { await lease.discard(); lease = null; if (current()) { this.status = 'skipped'; this.signature = null; } return; }
      this.readyKey = launch.key; this.status = 'ready';
    } catch {
      if (lease) { await lease.discard(); lease = null; }
      if (current()) { this.status = 'failed'; this.signature = null; }
    } finally { if (lease) await lease.release(async () => {}); }
  }
  async cancel() {
    this.request(null); await this.cancelling; await this.running;
  }
  async close() { await this.cancel(); this.closed = true; clearTimeout(this.timer); }
}
