import { randomUUID } from 'node:crypto';
import { claudeDisplayItem } from './claude-history-projection.mjs';

export class ClaudeHistorySearch {
  constructor(runtime) { this.runtime = runtime; this.job = null; }
  clear() { this.job = null; }
  checked(id) {
    const job = this.job;
    if (!job || job.id !== id || job.runtimeId !== this.runtime.runtimeId || this.runtime.closed || job.expires < Date.now()) throw new Error('This search expired or the conversation changed. Search again.');
    job.expires = Date.now() + 600000; return job;
  }
  async search({ query, searchId, limit = 50 } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Enter between 1 and 200 characters to search.');
    const r = this.runtime; if (r.closed) throw new Error('Reconnect before searching.');
    query = query.trim();
    const job = searchId ? this.checked(searchId) : this.job = { id: randomUUID(), runtimeId: r.runtimeId, query, expires: Date.now() + 600000, references: new Map(), scanned: 0, buffer: [], complete: false };
    if (job.query !== query || job.busy || job.failed) throw new Error('Wait for this search or search again.');
    job.busy = true; const results = []; let pages = 0;
    try {
      while (results.length < limit && !job.complete) {
        if (!job.buffer.length) {
          if (job.ended) { job.complete = true; break; }
          if (pages++ >= 3) break;
          const page = await r.history.page({ query, ...(job.cursor ? { beforeId: job.cursor } : {}), ...(job.revision ? { revision: job.revision } : {}) });
          if (this.checked(job.id) !== job) throw new Error('Search superseded.');
          job.revision = page.revision; job.cursor = page.nextCursor; job.ended = !page.hasOlder; job.buffer = page.items.reverse();
        }
        const item = job.buffer.shift(); if (!item) continue;
        job.scanned++;
        if (item.searchSnippet == null) continue;
        results.push({ id: item.id, type: claudeDisplayItem(item).type, snippet: item.searchSnippet });
        job.references.set(item.id, true); while (job.references.size > 500) job.references.delete(job.references.keys().next().value);
      }
      if (job.ended && !job.buffer.length) job.complete = true;
      return { runtimeId: r.runtimeId, searchId: job.id, query, results, scanned: job.scanned, complete: job.complete, hasMore: !job.complete };
    } catch (error) { job.failed = true; throw error; } finally { job.busy = false; }
  }
  async open({ searchId, itemId } = {}) {
    const job = this.checked(searchId);
    if (!job.references.has(itemId)) throw new Error('This result is unavailable. Search again.');
    const page = await this.runtime.history.page({ aroundId: itemId, revision: job.revision, query: job.query });
    this.checked(searchId);
    return this.runtime.historyPage(page, itemId);
  }
}
