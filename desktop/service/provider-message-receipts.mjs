import path from 'node:path';
import { saveJson } from './util.mjs';
import { lstat, readFile } from 'node:fs/promises';
// Durable reservation precedes mutation/inference. A crash never causes replay.
export async function providerMessageReceipt({ sessions, source, request, prepare, execute }) {
  if (!/^[a-f0-9-]{36}$/i.test(request.requestId || '') || !['branch', 'edit', 'retry'].includes(request.kind) || typeof request.itemId !== 'string' || request.itemId.length > 200) throw new Error('Choose a valid message action.');
  source.providerMessageReceipts ||= new Map();
  const previous = source.providerMessageReceipts.get(request.requestId);
  if (previous) {
    if (previous.kind !== request.kind || previous.itemId !== request.itemId) throw new Error('This request ID belongs to another action.');
    return previous.promise;
  }
  if (source.providerMessageReceipts.size >= 200) throw new Error('Message-action limit reached for this open chat. Reconnect before starting more actions.');
  const file = path.join(sessions.stateDir, `message-action-${source.id}-${request.requestId}.json`);
  let reserved = false, existing = false;
  const promise = (async () => {
    const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)) throw new Error('Message action receipt is unavailable; no replay is allowed.');
    let saved;
    try { saved = info ? JSON.parse(await readFile(file, 'utf8')) : null; }
    catch { throw new Error('Message action receipt is unreadable; no replay is allowed.'); }
    if (info && (!saved || typeof saved !== 'object' || Array.isArray(saved))) throw new Error('Message action receipt is invalid; no replay is allowed.');
    if (saved) {
      existing = true;
      if (saved.kind !== request.kind || saved.itemId !== request.itemId || saved.sourceNativeId !== source.nativeId) throw new Error('Message action receipt does not match this conversation.');
      if (saved.result) return saved.result;
      throw new Error('This action was already reserved and did not finish. Its private receipt is retained; it will not be replayed automatically.');
    }
    if (source.messageActionBusy) throw new Error('Wait for the current message action.');
    source.messageActionBusy = true;
    const receipt = { kind: request.kind, itemId: request.itemId, sourceNativeId: source.nativeId, stage: 'reserved' };
    const record = async update => { Object.assign(receipt, update); await saveJson(file, receipt); };
    try {
      // Read-only validation may fail transiently (a missing attachment, busy
      // source or unavailable history). It is safe to repeat that validation
      // with the same ID; only the following durable reservation admits effects.
      await prepare?.();
      reserved = true;
      await record({});
      const result = await execute(record);
      await record({ stage: 'completed', result }); return result;
    } finally { source.messageActionBusy = false; }
  })();
  source.providerMessageReceipts.set(request.requestId, { kind: request.kind, itemId: request.itemId, promise });
  promise.catch(() => {
    if (!reserved && !existing && source.providerMessageReceipts.get(request.requestId)?.promise === promise) source.providerMessageReceipts.delete(request.requestId);
  });
  return promise;
}
