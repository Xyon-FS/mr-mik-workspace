import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function prepareCliModel(session, boundary) {
  if (session.chatInterface === 'chat' || !['codex', 'claude'].includes(session.agent)) return;
  session.cliModelLaunchId = randomUUID();
  if (session.cliModelLabel) return;
  const inherited = await cliHistoryModel(boundary?.file || (boundary?.fork ? boundary.resumePath : null), session.agent);
  if (inherited) session.cliModelLabel = inherited;
}

export function nativeRecordModel(record, agent) {
  const model = agent === 'codex' && record.type === 'turn_context' ? record.payload?.model
    : agent === 'claude' && !record.isSidechain && record.type === 'assistant' ? record.message?.model
      : agent === 'claude' && record.type === 'system' && record.subtype === 'init' ? record.model : null;
  return typeof model === 'string' && model.length <= 200 && /^[a-z0-9][a-z0-9._:/() +\-]*$/i.test(model) ? model : null;
}

// One bounded read of the already-resolved native transcript on resume/fork.
// No transcript content is returned to the UI, and no provider is called.
export async function cliHistoryModel(file, agent) {
  if (!file || !['codex', 'claude'].includes(agent)) return null;
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const size = Math.min(info.size, 512 * 1024), offset = info.size - size, buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (offset) lines.shift();
    for (const line of lines.reverse()) {
      try { const model = nativeRecordModel(JSON.parse(line), agent); if (model) return model; } catch { /* Partial records are not metadata. */ }
    }
  } catch { /* Missing metadata retains a confirmed inherited label. */ }
  finally { await handle?.close(); }
  return null;
}
