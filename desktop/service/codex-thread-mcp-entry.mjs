import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';

try {
  const file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error('descriptor');
  for (let current = file; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || current === file && (!info.isFile() || info.size > 65536)) throw new Error('descriptor');
    if (path.dirname(current) === current) break;
  }
  if ((await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('descriptor');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.version !== 1 || !['bridge', 'browser'].includes(value.kind)) throw new Error('descriptor');
  const keys = value.kind === 'bridge' ? ['MRMAK_BRIDGE_URL', 'MRMAK_BRIDGE_TOKEN'] : ['MRMIK_BROWSER_ENDPOINT', 'MRMIK_BROWSER_TOKEN'];
  for (const key of ['MRMAK_BRIDGE_URL', 'MRMAK_BRIDGE_TOKEN', 'MRMIK_BROWSER_ENDPOINT', 'MRMIK_BROWSER_TOKEN']) delete process.env[key];
  for (const key of keys) {
    if (typeof value.env?.[key] !== 'string' || !value.env[key] || value.env[key].length > 16000) throw new Error('descriptor');
    process.env[key] = value.env[key];
  }
  const endpoint = new URL(process.env[keys[0]]);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) throw new Error('descriptor');
  if (value.kind === 'bridge') await import('./bridge-mcp.mjs');
  else await import('./shared-browser-entry.mjs');
} catch {
  process.stderr.write('The scoped Codex tool could not start. Reconnect this chat.\n');
  process.exitCode = 1;
}
