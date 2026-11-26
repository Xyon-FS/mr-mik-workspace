import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { projectChatItem } from './codex-chat-items.mjs';
import { projectTurn } from './codex-turns.mjs';
import { chatSearchText } from './chat-search-text.mjs';

const publicTypes = new Set(['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'plan', 'imageGeneration', 'imageView', 'enteredReviewMode', 'exitedReviewMode', 'collabAgentToolCall', 'contextCompaction']);
const rawItem = entry => entry.item || entry;
// Binary payloads and private reasoning are not a search index.
function projection(entry) {
  const item = rawItem(entry);
  if (!publicTypes.has(item.type)) return null;
  const scrub = part => {
    if (!part || typeof part !== 'object') return part;
    const { data, blob, ...value } = part; void data; void blob;
    if (part.resource) { const { blob, ...resource } = part.resource; void blob; value.resource = resource; }
    for (const key of ['imageUrl', 'audioUrl']) if (typeof value[key] === 'string' && value[key].startsWith('data:')) delete value[key];
    return value;
  };
  const value = projectChatItem({ ...item, ...(item.result ? { result: { ...item.result, content: item.result.content?.map(scrub) } } : {}), ...(item.contentItems ? { contentItems: item.contentItems.map(scrub) } : {}) });
  return { ...value, resources: value.fullResources?.map(resource => ({ name: resource.name, text: resource.text, uri: resource.uri })) || value.resources };
}
const legacyEntries = turns => turns.flatMap(turn => (turn.items || []).map(item => ({ item, turnId: turn.id, turn })));

export class GraphicalHistorySearch {
  constructor(runtime) { this.runtime = runtime; this.job = null; }
  clear() { clearTimeout(this.timer); this.job = null; }
  retain(job) { clearTimeout(this.timer); job.expires = Date.now() + 600000; this.timer = setTimeout(() => { if (this.job === job) this.clear(); }, 600000); this.timer.unref?.(); }
  checked(id) {
    const job = this.job, r = this.runtime;
    if (!job || job.id !== id || job.threadId !== r.threadId || Date.now() > job.expires || r.closed) throw new Error('This search expired or the conversation changed. Search again.');
    this.retain(job); return job;
  }
  async search({ query, searchId, limit = 50 } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Enter between 1 and 200 characters to search.');
    const r = this.runtime; if (r.closed) throw new Error('Reconnect the conversation before searching.');
    query = query.trim();
    const job = searchId ? this.checked(searchId) : this.job = { id: randomUUID(), threadId: r.threadId, query, expires: Date.now() + 600000, live: [...r.items.values()].reverse().map(item => ({ ...item, fullDetails: r.outputs.get(item.id) ?? item.details })), seen: new Set(), cursors: new Set(), references: new Map(), scanned: 0, complete: false, cursor: null, buffer: [], nativeEnded: false, legacyBefore: null };
    this.retain(job);
    if (job.query !== query || job.busy) throw new Error('Wait for the current search or start a new query.');
    if (job.failed) throw new Error('This search could not finish. Search again to retry.');
    job.busy = true;
    const results = [], key = query.toLowerCase(); let pages = 0, bytes = 0, inspected = 0;
    const active = () => { if (this.job !== job || r.closed || job.threadId !== r.threadId) throw new Error('This search was superseded or the conversation changed.'); };
    const document = item => {
      if (!item || !publicTypes.has(item.type)) return { id: item?.id, type: item?.type, size: 0, snippet: null };
      const text = chatSearchText(item), index = text.toLowerCase().indexOf(key);
      return { id: item.id, type: item.type, size: text.length, snippet: index < 0 ? null : (index > 60 ? '…' : '') + text.slice(Math.max(0, index - 60), index + query.length + 160).replace(/\s+/g, ' ') + (index + query.length + 160 < text.length ? '…' : '') };
    };
    const inspect = (entry, hint, live = false, prepared = false) => {
      const id = rawItem(entry).id;
      if (typeof id !== 'string') return;
      if (job.seen.has(id)) { if (job.references.has(id)) job.references.set(id, { ...job.references.get(id), hint }); return; }
      job.seen.add(id); job.scanned++;
      const doc = prepared ? entry : document(live ? entry : projection(entry)); bytes += doc.size;
      if (doc.snippet == null) return;
      const hit = { id, type: doc.type, snippet: doc.snippet };
      results.push(hit); job.references.set(id, { hint });
      while (job.references.size > 500) job.references.delete(job.references.keys().next().value);
    };
    try {
      while (job.live.length && results.length < limit && bytes < 4 * 1024 * 1024) inspect(job.live.shift(), { live: true }, true);
      if (!job.live.length && results.length < limit && bytes < 4 * 1024 * 1024) {
        if (r.historyMode === 'paginated') {
          while (results.length < limit && bytes < 4 * 1024 * 1024) {
            if (!job.buffer.length) {
              if (job.nativeEnded) { job.complete = true; break; }
              if (pages++ >= 3) break;
              const cursor = job.cursor;
              const page = await r.rpc('thread/items/list', { threadId: r.threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
              active(); if (!Array.isArray(page.data)) throw new Error('Codex did not return readable history items.');
              const next = page.nextCursor || null;
              if (next && (typeof next !== 'string' || next.length > 16000)) throw new Error('Codex returned an unsupported history cursor.');
              if (next && (next === cursor || job.cursors.has(next))) throw new Error('Codex repeated a history cursor. Search again to retry.');
              if (next) job.cursors.add(next);
              job.buffer = [];
              for (const entry of page.data) {
                const item = projection(entry); job.buffer.push({ entry: document(item || { id: rawItem(entry).id, type: rawItem(entry).type }), cursor });
                if (job.buffer.length % 25 === 0) { await setImmediate(); active(); }
              }
              job.cursor = next; job.nativeEnded = !next;
            }
            if (!job.buffer.length) continue;
            const value = job.buffer.shift(); inspect(value.entry, { cursor: value.cursor }, false, true);
            if (++inspected % 25 === 0) { await setImmediate(); active(); }
          }
          if (!job.live.length && !job.buffer.length && job.nativeEnded) job.complete = true;
        } else {
          const page = await r.rpc('thread/read', { threadId: r.threadId, includeTurns: true });
          active(); if (!Array.isArray(page.thread?.turns) || page.thread.id && page.thread.id !== r.threadId) throw new Error('Saved history could not be read for this conversation.');
          const entries = legacyEntries(page.thread?.turns || []).reverse();
          const before = job.legacyBefore == null ? -1 : entries.findIndex(entry => entry.item.id === job.legacyBefore);
          if (job.legacyBefore != null && before < 0) throw new Error('The saved history changed. Search again.');
          let index = before + 1;
          for (; index < entries.length && results.length < limit && bytes < 4 * 1024 * 1024; index++) {
            inspect(entries[index], { legacy: true }); job.legacyBefore = entries[index].item.id;
            if (++inspected % 25 === 0) { await setImmediate(); active(); }
          }
          job.complete = index === entries.length;
        }
      }
      return { runtimeId: r.runtimeId, searchId: job.id, query, results, scanned: job.scanned, complete: job.complete, hasMore: !job.complete };
    } catch (error) { job.failed = true; throw error; }
    finally { job.busy = false; }
  }
  async open({ searchId, itemId } = {}) {
    const job = this.checked(searchId), reference = job.references.get(itemId), r = this.runtime;
    if (!reference) throw new Error('This result is no longer available. Search again.');
    if (reference.hint.live) {
      const all = [...r.items.values()], index = all.findIndex(item => item.id === itemId);
      if (index < 0) throw new Error('This result left the live window. Search again to locate it in saved history.');
      const start = Math.max(0, index - 40), items = all.slice(start, index + 41);
      return { runtimeId: r.runtimeId, items, turns: [...r.turns.values()], nextCursor: null, hasOlder: start > 0 || r.truncated, anchorId: itemId };
    }
    if (r.historyMode === 'paginated') {
      const cursor = reference.hint.cursor;
      const page = await r.rpc('thread/items/list', { threadId: r.threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
      this.checked(searchId);
      if (!(page.data || []).some(entry => rawItem(entry).id === itemId)) throw new Error('This history page changed. Search again to locate the result.');
      return r.historyPage([...(page.data || [])].reverse(), { turns: [...r.turns.values()], nextCursor: page.nextCursor || null, hasOlder: !!page.nextCursor, anchorId: itemId }, { kind: 'page', cursor });
    }
    const page = await r.rpc('thread/read', { threadId: r.threadId, includeTurns: true }), entries = legacyEntries(page.thread?.turns || []);
    this.checked(searchId);
    const index = entries.findIndex(entry => entry.item.id === itemId);
    if (index < 0) throw new Error('This message is unavailable in saved history. Search again.');
    const start = Math.max(0, index - 40), window = entries.slice(start, index + 41), turns = [...new Map(window.map(entry => [entry.turnId, projectTurn(entry.turn)])).values()];
    return r.historyPage(window, { turns, nextCursor: start > 0 ? window[0].item.id : null, hasOlder: start > 0, anchorId: itemId });
  }
}
