import { open, stat, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { codexMetadata } from './codex-metadata.mjs';

export function completedTurn(record, agent) {
  if (agent === 'codex' && record.type === 'event_msg' && record.payload?.type === 'task_complete') return { kind: 'turn-completed', id: record.payload.turn_id, text: 'The agent finished its turn. Review the result.', preview: String(record.payload.last_agent_message || '').slice(-350) };
  // Claude writes thinking and text as separate records with the same message ID
  // and stop reason. Only the actual final answer creates a completion notice.
  if (agent === 'claude' && !record.isSidechain && record.type === 'assistant' && record.message?.stop_reason === 'end_turn' && record.message.content?.some(item => item.type === 'text')) return { kind: 'turn-completed', id: record.message.id, text: 'The agent finished its turn. Review the result.', preview: record.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(-350) };
  if (agent === 'claude' && !record.isSidechain && record.type === 'system' && record.subtype === 'api_error') return { kind: 'attention', text: 'The agent reported an API error.' };
  return null;
}

export function nativeActivity(record, agent) {
  const completed = completedTurn(record, agent);
  if (completed) return completed;
  if (agent === 'codex' && record.type === 'event_msg') {
    if (record.payload?.type === 'task_started') return { kind: 'turn-started' };
    if (record.payload?.type === 'turn_aborted') return { kind: 'turn-interrupted' };
  }
  if (agent === 'claude' && !record.isSidechain) {
    if (record.type === 'user' && !record.isMeta) {
      const content = record.message?.content;
      const interrupted = value => typeof value === 'string' && value.startsWith('[Request interrupted by user');
      if (interrupted(content) || Array.isArray(content) && content.some(item => item.type === 'text' && interrupted(item.text))) return { kind: 'turn-interrupted' };
      // Tool results also confirm ongoing work; file snapshots and metadata do not.
      if (content) return { kind: 'turn-started' };
    }
    if (record.type === 'assistant' && record.message?.stop_reason !== 'end_turn') return { kind: 'turn-started' };
  }
  return null;
}

// Only read records appended after this managed session starts. These files belong
// to the native CLI; MR-MAK never modifies them or replaces the user's hooks.
export function tailNativeFile(file, agent, onEvent, from = 0) {
  let offset = from, partial = '', closed = false, reading = false, decoder = new StringDecoder('utf8');
  const tick = async () => {
    if (closed || reading) return;
    reading = true;
    try {
      const info = await stat(file);
      if (info.size < offset) { offset = 0; partial = ''; decoder = new StringDecoder('utf8'); }
      if (info.size === offset) return;
      if (info.size - offset > 4 * 1024 * 1024) { offset = info.size - 4 * 1024 * 1024; partial = ''; decoder = new StringDecoder('utf8'); }
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(info.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        const lines = (partial + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        partial = lines.pop() || '';
        for (const line of lines) {
          try { const event = nativeActivity(JSON.parse(line), agent); if (event && !closed) onEvent(event); } catch { /* Partial records are ignored, never guessed. */ }
        }
      } finally { await handle.close(); }
    } catch { /* CLI may not have created its transcript yet. */ }
    finally { reading = false; }
  };
  const timer = setInterval(tick, 400); timer.unref(); tick();
  return () => { closed = true; clearInterval(timer); };
}

export async function claudeTranscript(cwd, nativeId, { search = false } = {}) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  if (search) {
    if (!/^[a-f0-9-]{36}$/i.test(nativeId || '')) throw new Error('Invalid Claude conversation ID.');
    const matches = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file = path.join(root, entry.name, `${nativeId}.jsonl`);
      const info = await lstat(file).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) matches.push(file);
    }
    if (matches.length > 1) throw new Error('Multiple native Claude transcripts share this ID. Resolve duplicates before resuming or importing.');
    if (matches.length) return matches[0];
  }
  const escaped = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const folders = await readdir(root).catch(() => []);
  const folder = folders.find(item => item.toLowerCase() === escaped) || cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(root, folder, `${nativeId}.jsonl`);
}

export async function codexTranscript(nativeId, { strict = false } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(nativeId)) return null;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const pending = [path.join(home, 'sessions')];
  const matches = [];
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(`-${nativeId.toLowerCase()}.jsonl`)) {
        const handle = await open(file, 'r');
        try {
          const first = await codexMetadata(file, { allowCompleteEof: true });
          if (first.type === 'session_meta' && first.payload?.id === nativeId) matches.push(file);
        } catch { /* A matching name alone is not proof of the native session. */ }
        finally { await handle.close(); }
      }
    }
  }
  if (strict && matches.length > 1) throw new Error('Multiple native Codex files share this conversation ID. Resolve the duplicate before transferring it.');
  return matches.length === 1 ? matches[0] : null;
}

// Recover a managed chat whose CLI ID was not captured before its tab closed.
// Exact originator identity wins; the legacy fallback requires one unclaimed
// CLI rollout in the same folder and a narrow creation-time window.
export async function codexTranscriptForChat({ id, cwd, createdAt, claimedIds = [], allowLegacy = false }) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const pending = [path.join(home, 'sessions')];
  const claimed = new Set(claimedIds.filter(Boolean).map(value => value.toLowerCase()));
  const owned = [], legacy = [];
  const started = Date.parse(createdAt);
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { pending.push(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const handle = await open(file, 'r').catch(() => null);
      if (!handle) continue;
      try {
        const first = await codexMetadata(file);
        const meta = first.payload;
        if (first.type !== 'session_meta' || typeof meta?.id !== 'string' || claimed.has(meta.id.toLowerCase()) || meta.cwd?.toLowerCase() !== cwd.toLowerCase()) continue;
        if (meta.originator === `mrmak_chat_${id}`) owned.push({ id: meta.id, file, owned: true });
        else if (allowLegacy && !meta.originator && meta.source === 'cli' && Number.isFinite(started)) {
          const recorded = Date.parse(first.timestamp || meta.timestamp);
          if (Number.isFinite(recorded) && Math.abs(recorded - started) <= 2 * 60 * 1000) legacy.push({ id: meta.id, file, owned: false });
        }
      } catch { /* Ignore partial, inaccessible, or unrelated transcripts. */ }
      finally { await handle.close(); }
    }
  }
  return owned.length === 1 ? owned[0] : owned.length ? null : legacy.length === 1 ? legacy[0] : null;
}
