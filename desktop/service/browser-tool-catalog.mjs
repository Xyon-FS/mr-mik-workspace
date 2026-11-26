import { Worker } from 'node:worker_threads';

const failure = 'The browser tool catalog could not be loaded. Retry discovery.';
export class BrowserToolCatalog {
  constructor({ createWorker = () => new Worker(new URL('./browser-tool-catalog-worker.mjs', import.meta.url), { execArgv: [], env: {} }), timeout = 30000 } = {}) {
    Object.assign(this, { createWorker, timeout });
  }
  get() {
    if (this.closed) return Promise.reject(new Error('Browser discovery is closed.'));
    if (this.catalog) return this.catalog;
    let worker;
    try { worker = this.createWorker(); }
    catch { return Promise.reject(new Error(failure)); }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const task = { worker, promise };
    this.task = task; this.catalog = promise;
    task.exit = new Promise(done => {
      worker.on('message', value => {
        if (!value || !Array.isArray(value.tools) || !value.tools.length || value.tools.some(tool => typeof tool.name !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object')) {
          task.failed = true; void worker.terminate();
        } else task.value = value;
      });
      // Never expose raw worker errors, local paths or native diagnostics.
      worker.on('error', () => { task.failed = true; });
      worker.once('exit', code => {
        clearTimeout(task.timer);
        if (this.task === task) this.task = null;
        if (code !== 0 || task.failed || !task.value || this.closed) {
          if (this.catalog === promise) this.catalog = null;
          reject(new Error(this.closed ? 'Browser discovery is closed.' : failure));
        } else resolve(task.value);
        done();
      });
    });
    task.timer = setTimeout(() => { task.failed = true; void worker.terminate(); }, this.timeout);
    return promise;
  }
  async close() {
    this.closed = true;
    const task = this.task;
    if (task) {
      // Attach the rejection handler before termination during pending startup.
      void task.promise.catch(() => {});
      await task.worker.terminate(); await task.exit;
    }
  }
}
