import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { Sessions } from '../sessions.mjs';
import { mkdtemp } from './fixtures.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-incremental-save-'));
  const sessions = await new Sessions(root, root).init();
  t.after(() => sessions.close());
  const add = async id => {
    const session = sessions.make({ id, name: id, agent: 'shell', cwd: root, open: false });
    sessions.items.set(id, session); await sessions.hydrate(session); return session;
  };
  return { root, sessions, add };
}
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));

test('saving a new session does not serialize unchanged peer screens; output, resize and reset still persist', async t => {
  const { root, sessions, add } = await fixture(t), peer = await add('peer');
  await write(peer.terminal, 'Retained native output'); await sessions.persist();
  let serialized = 0; const serialize = peer.serializer.serialize.bind(peer.serializer);
  peer.serializer.serialize = (...args) => { serialized++; return serialize(...args); };
  await add('new-chat'); await Promise.all([sessions.persist(), sessions.persist()]);
  assert.equal(serialized, 0);
  await write(peer.terminal, '\r\nNew output'); await sessions.persist(); assert.equal(serialized, 1);
  assert.match(JSON.parse(await readFile(path.join(root, 'screen-peer.json'))).data, /New output/);
  peer.terminal.resize(100, 40); await sessions.persist(); assert.equal(serialized, 2);
  peer.terminal.reset(); await sessions.persist(); assert.equal(serialized, 3);
  assert.doesNotMatch(JSON.parse(await readFile(path.join(root, 'screen-peer.json'))).data, /New output/);
  const file = path.join(root, 'screen-peer.json'); await unlink(file); await mkdir(file);
  await write(peer.terminal, 'Must survive the failed write');
  try { await assert.rejects(sessions.persist()); }
  finally { await rmdir(file); }
  await sessions.persist();
  assert.match(JSON.parse(await readFile(file)).data, /Must survive the failed write/);
  await write(peer.terminal, 'Before');
  const previousSerialize = peer.serializer.serialize; let arriving;
  peer.serializer.serialize = (...args) => {
    const result = previousSerialize(...args);
    peer.serializer.serialize = previousSerialize;
    arriving = write(peer.terminal, '\r\nDuring save'); return result;
  };
  await sessions.persist(); await arriving; await sessions.persist();
  assert.match(JSON.parse(await readFile(path.join(root, 'screen-peer.json'))).data, /During save/);
});

test('graphical drafts and provider state skip unchanged peers but preserve direct draft changes and replaced runtimes', async t => {
  const { root, sessions, add } = await fixture(t), session = await add('graphical');
  let writes = 0;
  const runtime = { runtimeId: 'first', revision: 1, draft: '', attachments: [], composer: { items: [] }, persistState: async () => { writes++; } };
  session.graphical = runtime; await sessions.persist(); await sessions.persist(); assert.equal(writes, 1);
  runtime.draft = 'Unsent text'; await sessions.persist(); assert.equal(writes, 2);
  runtime.revision++; await sessions.persist(); assert.equal(writes, 3);
  session.graphical = { ...runtime }; await sessions.persist(); assert.equal(writes, 4);
  session.graphical = { threadId: 'native-thread', draft: 'Codex draft', attachments: [], composer: { items: [] }, previewPaths: new Set(), advanced: { save: () => ({}) } };
  await sessions.persist(); session.graphical.draft = 'Changed draft'; await sessions.persist();
  assert.equal(JSON.parse(await readFile(path.join(root, 'graphical-draft-graphical.json'))).text, 'Changed draft');
});
