import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Local identity comparison only: never retain tokens or return raw auth data.
// JWT claims are not signature verification or proof of subscription entitlement.
export async function readAccountIdentity(home) {
  const file = path.join(home, 'auth.json');
  const before = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error('Codex credentials cannot be inspected safely.');
  let auth;
  try { auth = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Codex account identity is unreadable. Reconnect this account.'); }
  const after = await lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.isSymbolicLink() || after.nlink !== 1) throw new Error('Codex credentials changed during verification. Try again.');
  let claims;
  try { claims = JSON.parse(Buffer.from(auth?.tokens?.id_token.split('.')[1], 'base64url').toString('utf8')); } catch { throw new Error('A recognizable ChatGPT account is required. Reconnect this account.'); }
  const account = auth?.tokens?.account_id || claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  const subject = claims?.sub || claims?.['https://api.openai.com/auth']?.chatgpt_user_id;
  if (![account, subject].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value))) throw new Error('A recognizable ChatGPT account is required. Reconnect this account.');
  const email = typeof claims.email === 'string' && claims.email.length <= 254 && !/[\x00-\x1f]/.test(claims.email) ? claims.email : null;
  return { version: 1, fingerprint: createHash('sha256').update(JSON.stringify([account, subject])).digest('hex'), email };
}
