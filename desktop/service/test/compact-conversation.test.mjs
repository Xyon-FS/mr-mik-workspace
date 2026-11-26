import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { CompactConversations } from '../compact-conversation.mjs';

const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
test('real user events restore literal pasted envelopes and pair duplicates across incremental reads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mik-compact-envelope-'));
  try {
    const file = path.join(dir, 'fixture.jsonl');
    const text = '<environment_context>Literal user example</environment_context>';
    const event = value => ({ type: 'event_msg', payload: { type: 'user_message', message: value } });
    const line = value => JSON.stringify(value) + '\n';
    await writeFile(file, line(message('user', '<environment_context>Injected configuration</environment_context>')) + line(message('user', text)));
    const reader = new CompactConversations(async () => file), session = { agent: 'codex', nativeId: 'fixture' };
    assert.equal((await reader.read(session)).messages.length, 0);
    await appendFile(file, line(event(text)) + line(message('assistant', 'Explanation')));
    assert.deepEqual((await reader.read(session)).messages.map(row => row.text), [text, 'Explanation']);
    await appendFile(file, line(message('user', 'Repeat')));
    await reader.read(session);
    await appendFile(file, line(event('Repeat')) + line(message('assistant', 'Again')) + line(event('Repeat')) + line(message('user', 'Repeat')));
    assert.equal((await reader.read(session)).messages.filter(row => row.text === 'Repeat').length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('incremental read retains partial records, never writes the native file, handles truncation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mik-compact-test-'));
  try {
    const file = path.join(dir, 'fixture.jsonl');
    const first = JSON.stringify(message('user', 'Hello')) + '\n';
    const second = JSON.stringify(message('assistant', 'Hello 🐽'));
    await writeFile(file, first + second.slice(0, 30));
    let resolutions = 0;
    const reader = new CompactConversations(async () => { resolutions++; return file; });
    const session = { agent: 'codex', nativeId: 'fixture' };
    assert.equal((await reader.read(session)).messages.length, 1);
    await appendFile(file, second.slice(30) + '\n');
    assert.deepEqual((await reader.read(session)).messages.map(row => row.text), ['Hello', 'Hello 🐽']);
    assert.equal((await reader.read(session)).messages.length, 2);
    assert.equal(resolutions, 1);
    assert.equal(await readFile(file, 'utf8'), first + second + '\n');
    await writeFile(file, JSON.stringify(message('user', 'Reset')) + '\n');
    assert.deepEqual((await reader.read(session)).messages.map(row => row.text), ['Reset']);
    await assert.rejects(reader.read({ agent: 'claude' }), /Codex only/);
    assert.equal((await reader.read({ agent: 'codex' })).status, 'waiting');
    await appendFile(file, Array.from({ length: 105 }, (_, i) => JSON.stringify(message('assistant', `Answer ${i}`))).join('\n') + '\n');
    const result = await reader.read(session);
    assert.equal(result.messages.length, 100); assert.equal(result.truncated, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
