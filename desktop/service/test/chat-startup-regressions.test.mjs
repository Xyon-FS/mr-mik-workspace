import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

test('an unanswered optional Claude settings read does not block a ready chat', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-startup-')), session = { id: randomUUID(), nativeId: randomUUID(), cwd: root, agent: 'claude' };
  const wire = claudeFixture(session.nativeId, { holdSettings: true }), runtime = new ClaudeChat({ session, stateDir: root, transportFactory: wire.factory });
  try {
    let deadline; await Promise.race([runtime.start(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Optional settings blocked startup')), 2000); })]).finally(() => clearTimeout(deadline));
    assert.equal(runtime.snapshot().connected, true); assert.equal(runtime.effortControlAvailable, undefined);
    const request = wire.calls.find(call => call.request?.subtype === 'get_settings'); assert.ok(request);
    [...wire.transports][0].emit({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success', response: { applied: { effort: 'high' } } } });
    for (let i = 0; i < 20 && !runtime.effortControlAvailable; i++) await delay(5);
    assert.equal(runtime.effortControlAvailable, true); assert.equal(wire.calls.some(call => call.type === 'user'), false);
  } finally { await runtime.close(); wire.close(); }
});

test('Codex checks the real worker identity before creating a thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-startup-codex-')), wire = graphicalFixture();
  const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask' }, env: process.env, spawnChild: wire.spawnChild });
  runtime.verifyStartupAccount = async worker => { assert.equal(worker, runtime); assert.equal(wire.calls.at(-1).method, 'initialized'); throw new Error('Synthetic profile mismatch'); };
  try { await assert.rejects(runtime.start(), /Synthetic profile mismatch/); assert.equal(wire.children.length, 1); assert.equal(wire.calls.some(call => call.method === 'thread/start'), false); }
  finally { await runtime.close(); }
});

test('closing Claude while history is loading prevents a late native transport', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-startup-cancel-')), id = randomUUID();
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  let launches = 0;
  const runtime = new ClaudeChat({ session: { id: randomUUID(), nativeId: id, hasConversation: true, cwd: root, agent: 'claude' }, stateDir: root, transportFactory: () => { launches++; throw new Error('Must not launch'); } });
  runtime.history.page = async () => { entered(); await gate; return null; };
  const starting = runtime.start(id); const rejected = assert.rejects(starting, /closed during startup/);
  try { await waiting; await runtime.close(); release(); await rejected; assert.equal(launches, 0); }
  finally { release(); await runtime.close(); }
});
