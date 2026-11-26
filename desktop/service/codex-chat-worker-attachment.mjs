import { setTimeout as delay } from 'node:timers/promises';
import { stat } from 'node:fs/promises';

const reads = new Set(['thread/read', 'thread/items/list', 'thread/turns/list']);
const rootMethods = new Set([...reads, 'thread/settings/update', 'thread/compact/start', 'review/start', 'turn/start', 'turn/steer', 'turn/interrupt', 'mcpServerStatus/list', 'mcpServer/tool/call']);
const processReads = new Set(['model/list', 'account/read', 'account/rateLimits/read', 'config/read', 'collaborationMode/list', 'windowsSandbox/readiness', 'windowsSandbox/setupStart']);
// A failed turn (including quota exhaustion) may leave a loaded thread in
// systemError. It is terminal, not active; unloading still needs confirmation.
const settled = state => ['idle', 'systemError'].includes(state.thread?.status?.type);
export function authorizeCodexRpc(runtime, method, params) {
  if (runtime.closed) throw new Error('Codex is disconnected. Reconnect before continuing.');
  if (runtime.closeTask && runtime.initialized) throw new Error('This conversation is closing. No new native operation was sent.');
  if (processReads.has(method)) {
    if (params?.cwd != null && params.cwd !== runtime.session.cwd) throw new Error('Choose this chat’s working directory.');
    return;
  }
  if (method === 'skills/list' && params?.cwds?.length === 1 && params.cwds[0] === runtime.session.cwd) return;
  if (runtime.openingThread && !runtime.threadId && ['thread/start', 'thread/resume', 'thread/fork'].includes(method)) return;
  if (params?.threadId === runtime.threadId && rootMethods.has(method)) return;
  if (reads.has(method) && runtime.route.threads().includes(params?.threadId)) return;
  throw new Error('This native operation does not belong to this conversation.');
}

// Only the owning attachment may stop/unsubscribe these native threads. Failure
// keeps its lease; never terminate the shared worker to hide a detach failure.
export async function detachCodexThreads(runtime) {
  const transport = runtime.transport, ids = runtime.route.threads().reverse();
  if (!runtime.threadId && runtime.openingThread) throw new Error('Native conversation creation is unconfirmed; its worker is retained.');
  for (const threadId of ids) {
    // A verified root that never admitted work has no native history to read or
    // flush. Local drafts do not change that. Keep the same unload confirmation
    // and owner/descriptor lifetime; any submission or uncertainty uses the full
    // native state/persistence checks below.
    const unusedRoot = ids.length === 1 && threadId === runtime.threadId && runtime.initialized && !runtime.capabilitiesPending
      && runtime.session.hasConversation === false && !runtime.session.lastInputAt && !runtime.submission
      && !runtime.turnId && !runtime.nativeActive && !runtime.submitting && !runtime.uncertain
      && !runtime.turns.size && !runtime.items.size && !runtime.historyItems.size && !runtime.requests.size
      && !runtime.operations.busy && !runtime.operations.agentsBusy && !runtime.messageActionBusy
      && !runtime.advanced.busy && !runtime.advanced.steering && !runtime.advanced.dispatching && !runtime.permissions.busy;
    if (unusedRoot) { await waitForCodexUnload(transport, threadId, runtime.unloadTimeoutMs); continue; }
    let state = await transport.rpc('thread/read', { threadId, includeTurns: false }, 3000);
    if (state.thread?.id !== threadId) throw new Error('Codex did not confirm the conversation being closed.');
    if (state.thread.status?.type === 'active') {
      let turnId = threadId === runtime.threadId && runtime.turnId;
      if (!turnId) {
        // Paginated native threads reject full-turn hydration. Their current
        // turn metadata is sufficient to stop an owned child or resumed root.
        if (state.thread.historyMode === 'paginated') {
          let cursor; const cursors = new Set();
          for (let page = 0; page < 10; page++) {
            const history = await transport.rpc('thread/turns/list', { threadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) }, 3000);
            turnId = history.data?.find(turn => turn.status === 'inProgress')?.id;
            cursor = history.nextCursor;
            if (turnId || !cursor) break;
            if (cursors.has(cursor)) throw new Error('Codex repeated an active conversation cursor.');
            cursors.add(cursor);
          }
        } else {
          const history = await transport.rpc('thread/read', { threadId, includeTurns: true }, 3000);
          turnId = history.thread?.turns?.findLast(turn => turn.status === 'inProgress')?.id;
        }
      }
      if (!turnId) throw new Error('The active Codex turn could not be identified; its lease is retained.');
      await transport.rpc('turn/interrupt', { threadId, turnId }, 3000);
      for (let attempt = 0; attempt < 30; attempt++) {
        state = await transport.rpc('thread/read', { threadId, includeTurns: false }, 3000);
        if (state.thread?.id === threadId && settled(state)) break;
        await delay(50);
      }
    }
    if (state.thread?.id !== threadId || !settled(state)) throw new Error('Codex has not confirmed an idle conversation; its lease is retained.');
    if (threadId === runtime.threadId && (runtime.session.hasConversation || runtime.turns.size)) {
      const file = state.thread.path;
      const exists = typeof file === 'string' && (await stat(file).catch(() => null) || await stat(file + '.zst').catch(() => null));
      // Paginated native history is lazy. A loaded-only first turn must be
      // materialized before transferring its ID to another account/process.
      // Existing transcripts avoid loading their entire history on every close.
      if (!exists) {
        try { await transport.rpc('thread/read', { threadId, includeTurns: true }, 5000); }
        catch (error) {
          // This native version can commit paginated persistence, then reject
          // full turn hydration. Accept only that exact capability failure and
          // independently confirm the durable file; never suppress a write error.
          if (!error.nativeRejected || !/list_turns is not supported yet/.test(error.message)) throw error;
          const saved = await transport.rpc('thread/read', { threadId, includeTurns: false }, 3000);
          const durable = saved.thread?.path;
          if (saved.thread?.id !== threadId || typeof durable !== 'string' || !(await stat(durable).catch(() => null) || await stat(durable + '.zst').catch(() => null))) throw error;
        }
      }
    }
    // Unsubscribe acknowledges subscription removal, before asynchronous native
    // shutdown has flushed persistence. Confirm unloaded state before handing
    // the conversation to another account/process or releasing its descriptors.
    await waitForCodexUnload(transport, threadId, runtime.unloadTimeoutMs);
  }
}

// Slow native shutdown is still an owned close operation, not a transport fault.
// New, distinct roots may use the healthy engine while this owner keeps its
// conversation lease and scoped grants. Same-ID resumes must await this barrier.
export async function waitForCodexUnload(transport, threadId, timeoutMs = 12000) {
  let closed = false, wake;
  const onMessage = message => {
    if (message.method === 'thread/closed' && message.params?.threadId === threadId) { closed = true; wake?.(); }
  };
  transport.on('message', onMessage);
  const started = Date.now(), deadline = started + timeoutMs;
  const pending = () => Object.assign(new Error('Codex has not finished unloading this conversation; its lease is retained.'), { code: 'CODEX_UNLOAD_PENDING' });
  try {
    const result = await transport.rpc('thread/unsubscribe', { threadId }, 3000);
    if (!['unsubscribed', 'notLoaded', 'notSubscribed'].includes(result.status)) throw new Error('Codex did not confirm conversation detach.');
    while (!closed && Date.now() < deadline) {
      let cursor; const cursors = new Set(); let found = false;
      do {
        let loaded;
        try { loaded = await transport.rpc('thread/loaded/list', { ...(cursor ? { cursor } : {}), limit: 100 }, Math.max(1, Math.min(1500, deadline - Date.now()))); }
        catch (error) {
          if (closed) return;
          if (error.uncertain && Date.now() >= deadline) throw pending();
          throw error;
        }
        if (!Array.isArray(loaded.data)) throw new Error('Codex did not confirm loaded conversation state.');
        if (loaded.data.includes(threadId)) { found = true; break; }
        cursor = loaded.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a loaded conversation cursor.');
        cursors.add(cursor);
      } while (cursor && !closed && Date.now() < deadline);
      if (closed || !found && !cursor) return;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, Math.min(Date.now() - started < 2500 ? 100 : 400, Math.max(1, deadline - Date.now())));
        wake = () => { clearTimeout(timer); resolve(); };
        if (closed) wake();
      });
      wake = null;
    }
    if (!closed) throw pending();
  } finally { transport.off('message', onMessage); wake?.(); }
}
