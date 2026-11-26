import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Observer } from '../opencode/v2-observer.mjs';
import { openCodeRuntimeConfig } from '../opencode.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readV2Identity } from '../opencode-v2-session.mjs';

test('V2 resume lookup requires only identity columns, rejects missing IDs without creation and never changes rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, fork_session_id TEXT, future_column TEXT)');
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?)').run('ses_fixture', 'fixture-directory', null, 'future');
    assert.equal(readV2Identity(db, 'ses_fixture').directory, 'fixture-directory');
    assert.equal(readV2Identity(db, 'ses_missing'), null);
    assert.throws(() => readV2Identity(db, '../invalid'), /Invalid/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_v2').get().count, 1);
    db.exec('DROP TABLE session_v2; CREATE TABLE session_v2 (id TEXT)');
    assert.throws(() => readV2Identity(db, 'ses_fixture'), /not recognized/);
  } finally { db.close(); }
});

test('V2 runtime retains user settings, installs only the V2 adapter and registers scoped MCP', () => {
  const config = openCodeRuntimeConfig({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'fixture/test', plugins: ['custom'], permissions: [{ action: 'shell', resource: '*', effect: 'ask' }], mcp: { servers: { custom: { disabled: true } } } }) }, { script: 'bridge.mjs', hubSkillNames: ['hub-skill'] }, 2);
  assert.equal(config.model, 'fixture/test'); assert.equal(config.plugin, undefined);
  assert.ok(config.plugins[1].endsWith('/opencode/v2/'));
  assert.equal(config.mcp.servers.custom.disabled, true);
  assert.deepEqual(config.mcp.servers.mrmak_workspace.command, [process.execPath, 'bridge.mjs']);
  assert.equal(config.mcp.servers.mrmak_workspace.disabled, false);
  assert.deepEqual(config.permissions.at(-1), { action: 'skill', resource: 'hub-skill', effect: 'deny' });
  assert.equal(JSON.stringify(config).includes('TOKEN'), false);
});

test('V2 forks bind only after a matching native fork event and resumed roots do not replay completion', () => {
  const states = [], directory = process.cwd();
  const observe = createV2Observer({ directory, forkParent: 'ses_source', startedAt: 1, save: state => states.push(state) });
  for (const sessionID of ['ses_foreign', 'ses_fork']) observe({ type: 'session.created', created: 2, data: { sessionID, location: { directory } } });
  observe({ type: 'session.forked', created: 2, data: { sessionID: 'ses_foreign', parentID: 'ses_other' } });
  assert.equal(states.length, 0);
  observe({ type: 'session.forked', created: 2, data: { sessionID: 'ses_fork', parentID: 'ses_source' } });
  assert.equal(states.at(-1).nativeId, 'ses_fork'); assert.equal(states.at(-1).hasConversation, true);
});

test('V2 observer handles owned native forms and concurrent permissions without persisting dialog content', () => {
  const states = [], directory = process.cwd();
  const observe = createV2Observer({ directory, nativeId: 'ses_owned', chatId: 'chat', launchId: 'launch', startedAt: 1, save: state => states.push(state) });
  const event = (type, data, created = 2) => observe({ type, data, created, location: { directory } });
  event('session.execution.started', { sessionID: 'ses_owned' });
  event('form.created', { form: { id: 'frm_foreign', sessionID: 'ses_other', title: 'PRIVATE_FORM' } });
  assert.equal(states.at(-1).activity, 'working');
  event('form.created', { form: { id: 'frm_one', sessionID: 'ses_owned', title: 'PRIVATE_FORM', fields: ['PRIVATE_INPUT'] } });
  event('form.created', { form: { id: 'frm_two', sessionID: 'ses_owned' } });
  event('permission.asked', { id: 'per_one', sessionID: 'ses_owned', metadata: { secret: 'PRIVATE_TOKEN' } });
  event('session.status', { sessionID: 'ses_owned', status: { type: 'busy' } });
  assert.equal(states.at(-1).activity, 'waiting');
  event('form.replied', { id: 'frm_one', sessionID: 'ses_owned', answer: { secret: 'PRIVATE_ANSWER' } });
  event('permission.replied', { requestID: 'per_one', sessionID: 'ses_owned' });
  assert.equal(states.at(-1).activity, 'waiting');
  event('form.cancelled', { id: 'frm_two', sessionID: 'ses_owned' });
  assert.equal(states.at(-1).activity, 'working');
  event('form.created', { form: { id: 'frm_idle', sessionID: 'ses_owned' } });
  event('session.execution.succeeded', { sessionID: 'ses_owned' });
  assert.equal(states.at(-1).activity, 'waiting');
  event('form.replied', { id: 'frm_idle', sessionID: 'ses_owned' });
  assert.equal(states.at(-1).activity, 'idle');
  event('form.created', { form: { id: 'frm_old', sessionID: 'ses_owned' } }, 0);
  assert.equal(states.at(-1).activity, 'idle');
  assert.equal(JSON.stringify(states).includes('PRIVATE'), false);
});

test('V2 Hub native suppression uses IDs, leaving V1 display-name semantics unchanged', () => {
  const bridge = { script: 'fixture.mjs', hubSkillNames: ['Display name'], hubSkillIds: ['folder-id'] };
  assert.equal(openCodeRuntimeConfig({}, bridge, 2).permissions.at(-1).resource, 'folder-id');
  assert.equal(openCodeRuntimeConfig({}, bridge, 1).permission.skill['Display name'], 'deny');
});
