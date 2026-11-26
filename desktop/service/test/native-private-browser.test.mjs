import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { access, readdir, writeFile, realpath } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { launchNativePrivateBrowser, privateBrowserEnvironment } from '../native-private-browser.mjs';

async function fixture(t, failure = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-native-private-browser-'));
  let launched, stopped = 0;
  const child = new EventEmitter(); child.pid = failure ? undefined : 1234;
  const options = { temporaryRoot: root, candidates: [{ file: process.execPath, privateFlag: '--incognito' }], spawnProcess: (file, args, options) => {
    launched = { file, args, options }; queueMicrotask(() => child.emit(failure ? 'error' : 'spawn', new Error('Synthetic spawn failure'))); return child;
  }, stopProcess: async () => { stopped++; child.exitCode = 0; child.emit('exit', 0); } };
  const browser = failure ? null : await launchNativePrivateBrowser('https://auth.openai.com/oauth/authorize?state=synthetic', options);
  t.after(() => browser?.close());
  return { root, options, browser, child, launched, stopped: () => stopped };
}
test('native private launch uses its own temporary profile without automation or modified security', async t => {
  const f = await fixture(t), { args, options } = f.launched;
  assert.ok(args.includes('--incognito')); assert.ok(args.includes('--disable-sync'));
  assert.equal(options.shell, false); assert.equal(options.stdio, 'ignore');
  assert.ok(!args.some(arg => /remote-debugging|enable-automation|headless|disable-blink|proxy-server|disable-web-security|disable-features|disable-background-networking/.test(arg)));
  const folder = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  assert.equal(path.dirname(folder), await realpath(f.root)); await writeFile(path.join(folder, 'synthetic-cookies'), 'private');
  let closed = 0; f.browser.onClose(() => closed++);
  await Promise.all([f.browser.close(), f.browser.close()]);
  assert.equal(closed, 1); assert.equal(f.stopped(), 1); await assert.rejects(access(folder), { code: 'ENOENT' });
});
test('user window closure cancels only its own login and still cleans temporary data', async t => {
  const f = await fixture(t); let cancelled = false;
  f.browser.onClose(() => { cancelled = true; }); f.child.exitCode = 0; f.child.emit('exit', 0);
  assert.equal(cancelled, true); await f.browser.close();
  assert.equal(f.stopped(), 0); assert.deepEqual(await readdir(f.root), []);
});
test('private browser inherits OS locations but never application/account/API credentials', () => {
  assert.deepEqual(privateBrowserEnvironment({ SystemRoot: 'C:\\Windows', PATH: 'synthetic-path', TEMP: 'synthetic-temp', OPENAI_API_KEY: 'synthetic-private', MRMAK_BRIDGE_TOKEN: 'synthetic-private', CODEX_HOME: 'synthetic-profile', AWS_SECRET_ACCESS_KEY: 'synthetic-private' }), { SystemRoot: 'C:\\Windows', PATH: 'synthetic-path', TEMP: 'synthetic-temp' });
});
