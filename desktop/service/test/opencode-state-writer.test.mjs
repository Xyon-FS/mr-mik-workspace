import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateWriter, replaceControlFile } from '../opencode/state-writer.mjs';

test('control publication retries the same file without creating a second request and rejects changed chats', async () => {
  let attempts = 0, delivered = 0;
  const replace = async (source, destination) => {
    assert.equal(source, 'request.tmp'); assert.equal(destination, 'request');
    if (++attempts < 3) throw Object.assign(new Error('reader lock'), { code: 'EPERM' });
    delivered++;
  };
  await replaceControlFile('request.tmp', 'request', () => true, { replace, pause: async () => {} });
  assert.equal(attempts, 3); assert.equal(delivered, 1);
  let active = true;
  await assert.rejects(replaceControlFile('request.tmp', 'request', () => active, {
    replace: async () => { throw Object.assign(new Error('lock'), { code: 'EBUSY' }); },
    pause: async () => { active = false; },
  }), /chat changed/);
  assert.equal(delivered, 1);
});

test('observer atomic state retries Windows reader locks and coalesces to the newest revision', () => {
  let job, bytes, saved, locked = true;
  const save = createStateWriter('fixture', {
    write: (_file, value) => { bytes = value; },
    rename: () => { if (locked) throw Object.assign(new Error('reader lock'), { code: 'EPERM' }); saved = JSON.parse(bytes); },
    schedule: callback => { job = callback; return 1; }, cancel: () => { job = null; },
  });
  save({ revision: 1, activity: 'waiting' });
  save({ revision: 2, activity: 'idle' });
  assert.equal(saved, undefined);
  locked = false; job();
  assert.deepEqual(saved, { revision: 2, activity: 'idle' });
  save.dispose(); save({ revision: 3 });
  assert.equal(saved.revision, 2);
});

test('observer retries are bounded and disposal cancels outstanding timers', () => {
  let job, attempts = 0, cancelled = false;
  const save = createStateWriter('fixture', {
    write: () => {}, rename: () => { attempts++; throw Object.assign(new Error('lock'), { code: 'EACCES' }); },
    schedule: callback => { job = callback; return 1; }, cancel: () => { cancelled = true; job = null; },
  });
  save({ revision: 1 });
  while (job) { const next = job; job = null; next(); }
  assert.equal(attempts, 40);
  save({ revision: 2 }); save.dispose();
  assert.equal(cancelled, true); assert.equal(job, null);
});
