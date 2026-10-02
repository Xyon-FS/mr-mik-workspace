import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseOpenCodeVersion } from '../opencode.mjs';
import { OpenCodeTransfer, assertOpenCodeDatabaseSchema } from '../opencode-transfer.mjs';

const schema = `
CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT, time_updated INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
`;

test('OpenCode version discovery accepts later minor/major and prerelease versions, not an allowlist', () => {
  for (const version of ['1.18.34', '1.99.0', '2.0.0', '3.1.0-beta.2']) assert.equal(parseOpenCodeVersion(`OpenCode ${version}\n`), version);
  assert.throws(() => parseOpenCodeVersion('unavailable'), /could not be verified/);
});

test('legacy transfer cannot misidentify migrated V2 storage containing old V1 tables', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema + 'CREATE TABLE session_v2 (id TEXT PRIMARY KEY);');
    assert.throws(() => assertOpenCodeDatabaseSchema(db), /V2 transfer adapter/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_v2').get().count, 0);
  } finally { db.close(); }
});

test('OpenCode transfer opens compatible schemas without consulting the CLI release number', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-compat-'));
  const file = path.join(root, 'fixture.db');
  try {
    const fixture = new DatabaseSync(file);
    fixture.exec(schema + 'ALTER TABLE session ADD COLUMN future_metadata TEXT; CREATE TABLE future_table (id TEXT);');
    fixture.close();
    const transfer = new OpenCodeTransfer(root), calls = [];
    transfer.command = async args => { calls.push(args); assert.deepEqual(args, ['db', 'path']); return file; };
    const db = await transfer.database();
    assert.deepEqual(calls, [['db', 'path']]);
    assert.throws(() => db.exec("INSERT INTO session (id) VALUES ('ses_test')"), /readonly/i);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OpenCode incompatible database structures refuse only transfer/deletion before native mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-incompatible-'));
  const file = path.join(root, 'fixture.db');
  try {
    const fixture = new DatabaseSync(file);
    fixture.exec(schema + 'ALTER TABLE todo DROP COLUMN priority;'); fixture.close();
    const transfer = new OpenCodeTransfer(root), calls = [];
    transfer.command = async args => { calls.push(args); assert.deepEqual(args, ['db', 'path']); return file; };
    await assert.rejects(transfer.database(), /Unsupported native OpenCode database schema/);
    assert.deepEqual(calls, [['db', 'path']]);
    const db = new DatabaseSync(':memory:');
    assert.throws(() => assertOpenCodeDatabaseSchema(db), /schema/); db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
