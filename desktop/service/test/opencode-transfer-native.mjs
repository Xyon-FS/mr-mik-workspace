// Explicit native transfer test: two isolated profiles; no provider or account.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OpenCodeTransfer, openCodeHash, openCodeRelation } from '../opencode-transfer.mjs';

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-oc-transfer-native-')));
const agents = [];
for (const name of ['pc1', 'pc2']) {
  const cwd = path.join(base, name); await mkdir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) { env[key] = path.join(cwd, key); await mkdir(env[key]); }
  agents.push(new OpenCodeTransfer(cwd, { env, binary: { file: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe', args: [] } }));
}
const [source, target] = agents, id = 'ses_miktransferfixture';
const message = suffix => ({ info: { id: `msg_mik${suffix}`, sessionID: id, role: 'user', time: { created: suffix === 'first' ? 1 : 2 }, agent: 'build', model: { providerID: 'fixture', modelID: 'unused' } }, parts: [{ id: `prt_mik${suffix}`, sessionID: id, messageID: `msg_mik${suffix}`, type: 'text', text: `Offline ${suffix}` }] });
const initial = { info: { id, projectID: 'global', slug: 'offline-fixture', title: 'Offline fixture', directory: source.repo, version: '1.18.34', time: { created: 1, updated: 1 } }, messages: [message('first')] };
const file = path.join(base, 'native.json'); await writeFile(file, JSON.stringify(initial));
await source.command(['import', file]);
const original = await source.read(id); assert.equal(original.messages.length, 1);
await target.write(original, target.repo, null);
assert.equal(openCodeRelation(await target.read(id), original), 'identical');
const auth = path.join(target.env.XDG_DATA_HOME, 'opencode', 'auth.json'), config = path.join(target.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
await mkdir(path.dirname(auth), { recursive: true }); await mkdir(path.dirname(config), { recursive: true });
await writeFile(auth, '{}'); await writeFile(config, '{"permission":"ask"}');
const continuation = structuredClone(original); continuation.messages.push(message('second')); continuation.info.time.updated = 2;
continuation.info.cost = 12; continuation.info.tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } };
continuation.todos = [{ content: 'Offline fixture task', status: 'pending', priority: 'medium', position: 0 }];
await source.write(continuation, source.repo, openCodeHash(original));
const next = await source.read(id); assert.equal(openCodeRelation(await target.read(id), next), 'update');
await target.write(next, target.repo, openCodeHash(original));
assert.equal(openCodeRelation(await target.read(id), next), 'identical');
assert.notEqual((await target.read(id)).info.cost, 12); // Native import keeps existing metadata.
assert.deepEqual((await target.read(id)).todos, []); // Archived tasks are reference-only.
const collision = structuredClone(next); collision.info.id = 'ses_collisionfixture';
for (const message of collision.messages) { message.info.sessionID = collision.info.id; for (const part of message.parts) part.sessionID = collision.info.id; }
await assert.rejects(target.write(collision, target.repo, null), /belongs to another/);
assert.equal(await target.read(collision.info.id), null); assert.equal(openCodeRelation(await target.read(id), next), 'identical');
const divergent = structuredClone(next); divergent.messages[0].parts[0].text = 'Divergent offline fixture';
const beforeConflict = openCodeHash(await target.read(id));
await assert.rejects(target.write(divergent, target.repo, beforeConflict), /cannot replace divergent/);
assert.equal(openCodeHash(await target.read(id)), beforeConflict);
const unrelated = structuredClone(initial); unrelated.info.id = 'ses_unrelatedfixture';
unrelated.messages = []; const other = path.join(base, 'unrelated.json'); await writeFile(other, JSON.stringify(unrelated)); await target.command(['import', other]);
await target.remove(id, openCodeHash(await target.read(id)));
assert.equal(await target.read(id), null); assert.ok(await target.read(unrelated.info.id));
await assert.rejects(target.write(next, target.repo, 'stale-hash'), /changed/);
assert.equal(await readFile(auth, 'utf8'), '{}'); assert.equal(await readFile(config, 'utf8'), '{"permission":"ask"}');
// No auth files have been supplied or copied; only session JSON enters transfers.
assert.ok(!(await readFile(file, 'utf8')).includes('auth'));
console.log('PASS: OpenCode native two-profile import, continuation, conflict refusal, stale guard and native selective deletion. No account or paid calls.');
