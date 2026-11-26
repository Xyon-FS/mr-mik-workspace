import { NativeProfileProbe } from './codex-profile-probe.mjs';
import { launchNativePrivateBrowser } from './native-private-browser.mjs';

export function codexLoginUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password && !url.port && url.pathname === '/oauth/authorize') return url.href;
  } catch { /* Never include the authorization URL in an error. */ }
  throw new Error('Codex did not provide a supported sign-in link. Update its native CLI and retry.');
}

export async function openPrivateLoginBrowser(url, options) {
  return launchNativePrivateBrowser(codexLoginUrl(url), options);
}

// Native OAuth owns callback verification and auth storage. Only the URL is
// handed to a private browser; it never reaches the frontend, logs or History.
export async function runPrivateCodexLogin(command, env, { onStart, signal, timeoutMs = 180000,
  createProbe = options => new NativeProfileProbe(options.cwd, options.env, options),
  openBrowser = openPrivateLoginBrowser } = {}) {
  if (command.args.at(-1) !== 'login') throw new Error('Private browser login requires the native Codex login action.');
  let probe, browser, loginId, complete = false, timer;
  const early = new Map();
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  const cancel = () => rejectDone(new Error('Private Codex sign-in cancelled. Connect the account again to retry.'));
  const notification = message => {
    if (message.method !== 'account/login/completed') return;
    const p = message.params || {};
    if (!loginId) { if (early.size < 4 && typeof p.loginId === 'string') early.set(p.loginId, p); return; }
    if (p.loginId !== loginId) return;
    if (p.success === true) { complete = true; resolveDone(); }
    else rejectDone(new Error('Native Codex sign-in did not complete. Retry the private sign-in window.'));
  };
  try {
    if (signal?.aborted) throw new Error('Private Codex sign-in cancelled.');
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => rejectDone(new Error('Private Codex sign-in timed out. Connect the account again to retry.')), timeoutMs);
    probe = createProbe({ cwd: env?.CODEX_HOME || process.cwd(), env, binary: { file: command.file, args: command.args.slice(0, -1) }, onNotification: notification, onExit: () => { if (!complete) cancel(); } });
    if (Number.isInteger(probe.child?.pid) && probe.child.pid > 0) await onStart?.(probe.child.pid);
    await Promise.race([probe.initialize(), done]);
    const result = await Promise.race([probe.rpc('account/login/start', { type: 'chatgpt' }), done]);
    if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || !result.loginId || result.loginId.length > 200) throw new Error('Native Codex does not support private browser sign-in. Update its CLI and retry.');
    loginId = result.loginId;
    if (early.has(loginId)) notification({ method: 'account/login/completed', params: early.get(loginId) });
    browser = await openBrowser(codexLoginUrl(result.authUrl));
    browser.onClose(cancel);
    await done;
    return { requested: true, completed: true };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    try {
      if (!complete && loginId && !probe?.exited) await probe.rpc('account/login/cancel', { loginId }).catch(() => {});
    } finally {
      try { await browser?.close(); }
      finally { await probe?.close(); }
    }
  }
}
