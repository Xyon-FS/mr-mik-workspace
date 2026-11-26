import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson } from './util.mjs';
const setups = new Map();
const key = env => createHash('sha256').update(String(env.CODEX_HOME || env.USERPROFILE || '').toLowerCase()).digest('hex');
export async function sandboxMode(directory, env) {
  if (!directory) return null;
  try { const value = JSON.parse(await readFile(path.join(directory, key(env) + '.json'), 'utf8')); return ['elevated', 'unelevated'].includes(value.mode) ? value.mode : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function rememberSandbox(directory, env, mode) {
  if (!directory || !['elevated', 'unelevated'].includes(mode)) return;
  await mkdir(directory, { recursive: true }); await saveJson(path.join(directory, key(env) + '.json'), { mode });
}
export function reserveSandbox(env, owner) {
  const id = key(env);
  if (setups.has(id)) throw new Error('Sandbox setup is already in progress for this account. Wait for it to finish.');
  setups.set(id, owner);
  return () => { if (setups.get(id) === owner) setups.delete(id); };
}
