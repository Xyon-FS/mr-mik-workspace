import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function writeClaudeHistory(config, cwd, id, count = 180) {
  const rows = [];
  for (let index = 0; index < count; index++) {
    rows.push({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: `Input ${index}${index === 2 ? ' ancient-needle' : ''}` } });
    rows.push({ type: 'assistant', uuid: randomUUID(), message: { id: `${id}-answer-${index}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Response ${index}` }] } });
  }
  const folder = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  await writeFile(file, rows.map((row, index) => JSON.stringify({ ...row, sessionId: id, cwd, parentUuid: rows[index - 1]?.uuid || null, isSidechain: false, timestamp: new Date(index + 1).toISOString() })).join('\n') + '\n');
  return { rows, file };
}
