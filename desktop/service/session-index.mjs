import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sleep } from './util.mjs';

function decode(bytes) {
  const sessions = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(sessions) || sessions.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.agent !== 'string') || new Set(sessions.map(item => item.id)).size !== sessions.length) throw new Error('Invalid History index');
  return sessions;
}
export async function loadSessionIndex(file) {
  let missing = false;
  try { return decode(await readFile(file)); }
  catch (error) { missing = error.code === 'ENOENT'; }
  try { return decode(await readFile(file + '.previous')); }
  catch (error) {
    if (missing && error.code === 'ENOENT') return [];
    throw Object.assign(new Error('The chat History index is unreadable. Existing files have been preserved; restore its backup before continuing.'), { code: 'HISTORY_INDEX_UNREADABLE' });
  }
}
async function durableWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error; await sleep(25 * (attempt + 1)); }
    }
  } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function saveSessionIndex(file, sessions) {
  const next = Buffer.from(JSON.stringify(sessions, null, 2) + '\n'); decode(next);
  let current;
  try { current = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    let valid;
    try { valid = decode(current); } catch { await durableWrite(file + '.corrupt-' + randomUUID() + '.json', current); }
    if (valid?.length) await durableWrite(file + '.previous', current);
  }
  await durableWrite(file, next);
}
