import test from 'node:test';
import assert from 'node:assert/strict';
import { codexLoginUrl, runPrivateCodexLogin } from '../codex-private-login.mjs';

const command = { file: 'synthetic-codex.exe', args: ['-c', 'synthetic=true', 'login'] };
const authUrl = 'https://auth.openai.com/oauth/authorize?state=synthetic-private-state';
function fixture({ event, browserError, type = 'chatgpt' } = {}) {
  const calls = []; let hooks, probeClosed = false, browserClosed = false, browserClose;
  const createProbe = options => {
    hooks = options;
    return { child: { pid: 42 }, initialize: async () => calls.push('initialize'), rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'account/login/start') return { type, loginId: 'owned-login', authUrl };
      return {};
    }, close: async () => { probeClosed = true; } };
  };
  const notify = params => hooks.onNotification({ method: 'account/login/completed', params });
  const openBrowser = async url => {
    assert.equal(url, authUrl);
    if (browserError) throw new Error('Synthetic private browser unavailable');
    if (event) queueMicrotask(() => event(notify));
    return { onClose: callback => { browserClose = callback; }, close: async () => { browserClosed = true; browserClose?.(); } };
  };
  return { createProbe, openBrowser, notify, calls, state: () => ({ probeClosed, browserClosed }), hooks: () => hooks };
}

test('private login delegates native OAuth to the selected profile and observes only its completion', async () => {
  const f = fixture({ event: notify => { notify({ loginId: 'foreign-login', success: false }); notify({ loginId: 'owned-login', success: true }); } });
  let pid;
  assert.deepEqual(await runPrivateCodexLogin(command, { CODEX_HOME: 'synthetic-profile' }, { ...f, onStart: id => { pid = id; } }), { requested: true, completed: true });
  assert.equal(pid, 42); assert.equal(f.hooks().cwd, 'synthetic-profile');
  assert.deepEqual(f.hooks().binary, { file: command.file, args: command.args.slice(0, -1) });
  assert.equal(f.calls.some(call => call.method === 'account/login/cancel'), false);
  assert.deepEqual(f.state(), { probeClosed: true, browserClosed: true });
});

test('private window failure cancels native login and never falls back to the personal browser', async () => {
  const f = fixture({ browserError: true });
  await assert.rejects(runPrivateCodexLogin(command, {}, f), /private browser unavailable/);
  assert.deepEqual(f.calls.at(-1), { method: 'account/login/cancel', params: { loginId: 'owned-login' } });
  assert.equal(f.state().probeClosed, true);
});

test('unsupported native login and untrusted authorization URLs fail without exposing URLs', async () => {
  const f = fixture({ type: 'apiKey' });
  await assert.rejects(runPrivateCodexLogin(command, {}, f), /does not support private/);
  for (const value of ['http://auth.openai.com/oauth/authorize', 'https://auth.openai.com.evil.test/oauth/authorize', 'https://user:secret@auth.openai.com/oauth/authorize', 'file:///synthetic', 'https://auth.openai.com:444/oauth/authorize']) assert.throws(() => codexLoginUrl(value), error => !error.message.includes(value) && /supported sign-in/.test(error.message));
  assert.equal(codexLoginUrl(authUrl), authUrl);
});
