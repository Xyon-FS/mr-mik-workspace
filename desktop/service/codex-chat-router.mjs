const validThread = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const requestKey = id => (typeof id === 'string' && id.length > 0 && id.length <= 200 || Number.isSafeInteger(id)) ? String(id) : null;
const globalEvents = new Set(['account/updated', 'account/rateLimits/updated', 'account/login/completed', 'skills/changed', 'app/list/updated', 'configWarning', 'warning', 'deprecationNotice', 'windows/worldWritableWarning', 'mcpServer/oauthLogin/completed', 'mcpServer/startupStatus/updated']);

// No implicit "last active chat" fallback. Unknown conversation events remain
// unowned until a verified root or a referenced spawned child is registered.
export class CodexChatRouter {
  constructor(send) {
    this.send = send;
    this.owners = new Set(); this.threads = new Map(); this.requests = new Map();
    this.buffer = []; this.bufferBytes = 0; this.lost = new Set(); this.exclusive = new Map();
  }
  attach(handlers) {
    const owner = { handlers, active: true, root: null };
    this.owners.add(owner);
    return {
      bindRoot: id => this.bindRoot(owner, id),
      observeItem: item => this.observeItem(owner, owner.root, item),
      expect: method => this.expect(owner, method),
      cancelExpected: method => { if (this.exclusive.get(method) === owner) this.exclusive.delete(method); },
      send: message => this.reply(owner, message),
      detach: () => this.detach(owner),
      threads: () => [...this.threads].filter(([, record]) => record.owner === owner).map(([id]) => id),
    };
  }
  issue(owner, message) { if (owner.active) owner.handlers.onIssue?.(message); }
  bindRoot(owner, id) {
    if (!owner.active || !validThread(id) || owner.root && owner.root !== id || this.threads.has(id) && this.threads.get(id).owner !== owner) throw new Error('Codex conversation ownership could not be verified.');
    owner.root = id;
    this.threads.set(id, { owner, root: true });
    this.flush(id);
  }
  observeItem(owner, parentId, item) {
    if (!owner.active || this.threads.get(parentId)?.owner !== owner || item?.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') return;
    const ids = [...new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), ...Object.keys(item.agentsStates || {})])].filter(validThread).slice(0, 40);
    for (const id of ids) {
      const existing = this.threads.get(id);
      if (existing) {
        if (existing.owner !== owner || existing.root) this.issue(owner, 'Codex reported a conflicting subagent owner. The other conversation was not attached.');
        continue;
      }
      // Bound retained child metadata for long conversations.
      if ([...this.threads.values()].filter(record => record.owner === owner).length >= 256) {
        this.issue(owner, 'Codex subagent routing reached its limit. Reconnect before starting more work.');
        break;
      }
      this.threads.set(id, { owner, root: false, parentId });
      this.flush(id);
    }
  }
  expect(owner, method) {
    if (!owner.active || method !== 'windowsSandbox/setupCompleted') throw new Error('Unknown Codex process operation.');
    const existing = this.exclusive.get(method);
    if (existing && existing !== owner) throw new Error('Another conversation is preparing the Codex sandbox.');
    this.exclusive.set(method, owner);
  }
  reply(owner, message) {
    const key = requestKey(message.id), record = key == null ? null : this.requests.get(key);
    if (!owner.active || message.method || !record || record.owner !== owner || record.conflicted || record.responded || message.id !== record.nativeId) throw new Error('This native request does not belong to this chat or has already been answered.');
    // Mark before writing because synthetic/native responses can be synchronous.
    record.responded = true;
    try { this.send(message); }
    catch (error) { record.uncertain = true; throw error; }
  }
  route(message) {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
    const p = message.params || {};
    const threadId = message.method === 'thread/started' ? p.thread?.id : p.threadId;
    if (p.threadId != null && !validThread(p.threadId) || threadId != null && !validThread(threadId) || message.method === 'thread/started' && p.threadId != null && p.threadId !== threadId) return;
    if (message.method === 'serverRequest/resolved') {
      const key = requestKey(p.requestId), record = key == null ? null : this.requests.get(key);
      if (!record) {
        if (threadId && !this.threads.has(threadId)) this.retain(threadId, message);
        else if (!threadId) {
          const queued = this.buffer.filter(entry => entry.message.id === p.requestId && entry.message.method);
          if (queued.length === 1) this.retain(queued[0].threadId, message);
        }
        return;
      }
      if (record.conflicted || record.nativeId !== p.requestId || threadId != null && threadId !== record.threadId) return;
      this.requests.delete(key);
      if (record.owner.active) this.deliver(this.threads.get(record.threadId), { ...message, params: { ...p, threadId: record.threadId } });
      return;
    }
    if (message.id != null) {
      const record = this.threads.get(threadId), key = requestKey(message.id);
      // Never guess the owner of a native approval, even with one open chat.
      if (key == null) return;
      if (!record) {
        if (validThread(threadId)) this.retain(threadId, message);
        else for (const owner of this.owners) this.issue(owner, 'Codex sent a request without conversation ownership. No decision was sent.');
        return;
      }
      const previous = this.requests.get(key);
      if (previous) {
        if (previous.owner !== record.owner || previous.threadId !== threadId || previous.nativeId !== message.id || previous.method !== message.method) {
          previous.conflicted = true;
          this.issue(previous.owner, 'Codex reused a pending request identifier. No decision was sent.');
          this.issue(record.owner, 'Codex reused a pending request identifier. No decision was sent.');
        }
        return;
      }
      if (this.requests.size >= 256) { this.issue(record.owner, 'Codex has too many pending native requests. No decision was sent.'); return; }
      this.requests.set(key, { owner: record.owner, nativeId: message.id, threadId, turnId: p.turnId, method: message.method });
      this.deliver(record, message);
      return;
    }
    if (threadId != null) {
      const record = this.threads.get(threadId);
      if (record) {
        if (message.method === 'turn/completed' && typeof p.turn?.id === 'string') for (const [key, request] of this.requests) if (request.threadId === threadId && request.turnId === p.turn.id) this.requests.delete(key);
        this.deliver(record, message);
      }
      else this.retain(threadId, message);
      return;
    }
    if (message.method === 'windowsSandbox/setupCompleted') {
      if (p.mode !== 'elevated') return;
      const owner = this.exclusive.get(message.method);
      this.exclusive.delete(message.method);
      if (owner?.active) owner.handlers.onGlobal?.(message);
      return;
    }
    if (globalEvents.has(message.method)) for (const owner of this.owners) if (owner.active) owner.handlers.onGlobal?.(message);
  }
  deliver(record, message) {
    if (!record?.owner.active) return;
    if (record.root) record.owner.handlers.onMessage?.(message);
    else {
      const p = message.params || {};
      if (message.method === 'item/completed') this.observeItem(record.owner, p.threadId, p.item);
      record.owner.handlers.onChild?.(message);
    }
  }
  retain(threadId, message) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > 4 * 1024 * 1024) { this.markLost(threadId); return; }
    this.buffer.push({ threadId, message, bytes }); this.bufferBytes += bytes;
    while (this.buffer.length > 256 || this.bufferBytes > 4 * 1024 * 1024) {
      const removed = this.buffer.shift(); this.bufferBytes -= removed.bytes; this.markLost(removed.threadId);
    }
  }
  markLost(threadId) {
    this.lost.add(threadId);
    while (this.lost.size > 256) this.lost.delete(this.lost.values().next().value);
  }
  flush(threadId) {
    const matching = this.buffer.filter(entry => entry.threadId === threadId);
    this.buffer = this.buffer.filter(entry => entry.threadId !== threadId);
    for (const entry of matching) { this.bufferBytes -= entry.bytes; this.route(entry.message); }
    if (this.lost.delete(threadId)) this.issue(this.threads.get(threadId).owner, 'Some native events arrived before ownership could be confirmed. Check conversation status before continuing.');
  }
  detach(owner) {
    owner.active = false; this.owners.delete(owner);
    for (const [id, record] of this.threads) if (record.owner === owner) { this.threads.delete(id); this.lost.delete(id); }
    for (const [id, record] of this.requests) if (record.owner === owner) this.requests.delete(id);
    for (const [method, record] of this.exclusive) if (record === owner) this.exclusive.delete(method);
    if (!this.owners.size) { this.buffer = []; this.bufferBytes = 0; this.lost.clear(); }
  }
  clear() {
    for (const owner of [...this.owners]) this.detach(owner);
    this.threads.clear(); this.requests.clear(); this.exclusive.clear();
  }
}
