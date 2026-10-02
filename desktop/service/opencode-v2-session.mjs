import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { openCodeBinary } from './agents.mjs';
import { validSessionId } from './opencode/observer.mjs';

const execute = promisify(execFile);
async function native(args, cwd, env) {
  const binary = openCodeBinary(env);
  if (!binary.file || /\.(cmd|bat|ps1)$/i.test(binary.file)) throw new Error('A native OpenCode V2 executable is required for safe conversation lookup.');
  try {
    return (await execute(binary.file, [...binary.args, ...args], { cwd, env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
  } catch { throw new Error('OpenCode V2 conversation operation failed. The saved screen is unchanged.'); }
}

export function readV2Identity(db, id) {
  if (!validSessionId(id)) throw new Error('Invalid OpenCode conversation ID.');
  const columns = db.prepare('PRAGMA table_info("session_v2")').all().map(row => row.name);
  if (['id', 'directory', 'fork_session_id'].some(name => !columns.includes(name))) throw new Error('OpenCode V2 conversation storage is not recognized. Resume was not attempted.');
  return db.prepare('SELECT id, directory, fork_session_id FROM session_v2 WHERE id = ?').get(id) || null;
}

export async function lookupV2Session(id, cwd, env) {
  if (!validSessionId(id)) throw new Error('Invalid OpenCode conversation ID.');
  const file = (await native(['debug', 'paths', 'db'], cwd, env)).trim();
  if (!path.isAbsolute(file)) throw new Error('OpenCode V2 database path could not be verified.');
  const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile()) throw new Error('OpenCode V2 database is unavailable.');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return readV2Identity(db, id); } finally { db.close(); }
}

export async function forkV2Session(parent, cwd, env) {
  if (!(await lookupV2Session(parent, cwd, env))) throw new Error('The source OpenCode conversation was not found. No fork was created.');
  // Let the native API create the fork before the terminal starts. Its event may
  // precede plugin loading, so event-only binding cannot reliably identify it.
  const output = await native(['api', '--standalone', 'POST', `/api/session/${parent}/fork`, '--data', '{}'], cwd, env);
  let value;
  try { value = JSON.parse(output); } catch { throw new Error('The native OpenCode fork response was not recognized.'); }
  const child = value.data;
  if (!validSessionId(child?.id) || child.id === parent || child.fork?.sessionID !== parent) throw new Error('The native OpenCode fork identity could not be verified.');
  return child.id;
}
