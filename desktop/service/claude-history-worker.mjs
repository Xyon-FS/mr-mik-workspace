// File-only official SDK helpers in a process with the chat's native config.
import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectClaudeHistory } from './claude-history-projection.mjs';
const [action, id, dir, anchor] = process.argv.slice(2);
try {
  if (!['read', 'fork', 'page'].includes(action) || !/^[a-f0-9-]{36}$/i.test(id || '') || !path.isAbsolute(dir || '')) throw new Error('Invalid history operation');
  const root = process.env.CLAUDE_CONFIG_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error('Explicit native config directory required');
  const matches = [];
  for (const entry of await readdir(path.join(root, 'projects'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const folder = path.join(root, 'projects', entry.name), info = await lstat(path.join(folder, `${id}.jsonl`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info) matches.push({ folder, info });
  }
  if (matches.length !== 1) throw new Error('Native identity is missing or ambiguous');
  const { folder, info } = matches[0];
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('Native transcript unavailable or exceeds 32 MB');
  // Exact managed ID, uniquely verified inside this profile. A relocated Hub
  // can retain a transcript under its original encoded native project folder.
  const messages = await getSessionMessages(id);
  if (!messages.length || messages.length > (action === 'page' ? 50000 : 4000)) throw new Error('Native history unavailable or too long');
  if (action === 'read') process.stdout.write(JSON.stringify(messages));
  else if (action === 'page') {
    const options = JSON.parse(anchor || '{}');
    if (Object.keys(options).some(key => !['beforeId', 'aroundId', 'revision', 'query'].includes(key)) || Object.values(options).some(value => typeof value !== 'string' || value.length > 2000) || options.query?.length > 200) throw new Error('Invalid history window');
    const revision = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
    if (options.revision && options.revision !== revision) throw new Error('Native history changed');
    const projected = projectClaudeHistory(messages, options.query ? 32 * 1024 * 1024 : 200000), all = projected.items;
    let end = options.beforeId ? all.findIndex(item => item.id === options.beforeId) : all.length;
    if (options.aroundId) { const index = all.findIndex(item => item.id === options.aroundId); if (index < 0) throw new Error('Unknown message'); end = Math.min(all.length, index + 41); }
    if (end < 0) throw new Error('Unknown history boundary');
    const start = Math.max(0, end - 100), items = all.slice(start, end), turnIds = new Set(items.map(item => item.turnId));
    for (const item of items) {
      if (options.query) {
        const text = `${item.text || ''}\n${item.type === 'tool' ? JSON.stringify(item.input || {}) : ''}`, index = text.toLowerCase().indexOf(options.query.toLowerCase());
        item.searchSnippet = index < 0 ? null : text.slice(Math.max(0, index - 60), index + options.query.length + 160).replace(/\s+/g, ' ');
        if (options.aroundId === item.id && index >= 200000) item.text = `[Excerpt from native history]\n${item.searchSnippet}`;
      }
      item.text = item.text.slice(0, 200000);
    }
    process.stdout.write(JSON.stringify({ revision, items, turns: projected.turns.filter(turn => turnIds.has(turn.id)), hasOlder: start > 0, nextCursor: start > 0 ? items[0].id : null }));
  }
  else {
    if (anchor && !messages.some(message => message.uuid === anchor)) throw new Error('Unknown native fork boundary');
    const fork = await forkSession(id, { ...(anchor ? { upToMessageId: anchor } : {}) });
    process.stdout.write(JSON.stringify({ nativeId: fork.sessionId, file: path.join(folder, `${fork.sessionId}.jsonl`), messages: await getSessionMessages(fork.sessionId) }));
  }
} catch { process.stderr.write('Claude native history operation could not be verified. Existing transcripts are preserved.'); process.exitCode = 1; }
