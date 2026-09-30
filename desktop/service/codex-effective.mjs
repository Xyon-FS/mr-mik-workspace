import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexBinary } from './agents.mjs';

// Read only the non-secret parts of Codex's resolved configuration. Never send
// the raw config/read payload (which may contain MCP headers or environment).
export async function effectiveCodex(root, env = process.env) {
  const binary = codexBinary(env);
  const child = spawn(binary.file, [...binary.args, 'app-server', '--stdio'], {
    cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  let settled = false;
  const fail = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (!pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error('Codex could not resolve this project configuration.'));
      else resolve(message.result);
    } catch { /* Ignore non-RPC output. */ }
  });
  child.on('error', () => fail(new Error('Codex app-server could not start.')));
  child.on('exit', () => { if (!settled) fail(new Error('Codex app-server stopped before returning configuration.')); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
      if (error && pending.has(id)) { pending.delete(id); reject(new Error('Could not communicate with Codex.')); }
    });
  });
  const timeout = setTimeout(() => { fail(new Error('Codex configuration check timed out.')); child.kill(); }, 10000);
  try {
    await rpc('initialize', { clientInfo: { name: 'mrmak_configuration_check', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await rpc('config/read', { cwd: root, includeLayers: true });
    settled = true;
    const config = result?.config || {};
    return {
      checkedAt: new Date().toISOString(),
      projectLayerLoaded: Array.isArray(result?.layers) && result.layers.some(layer => layer?.name?.type === 'project'),
      plugins: Object.fromEntries(Object.entries(config.plugins || {}).map(([id, value]) => [id, value?.enabled === true])),
      mcp: Object.fromEntries(Object.entries(config.mcp_servers || {}).map(([id, value]) => [id, value?.enabled !== false])),
      skills: (config.skills?.config || []).filter(item => typeof item?.path === 'string').map(item => ({ path: item.path, enabled: item.enabled !== false })),
      note: 'Resolved configuration from a fresh Codex process, not a live chat connection or tool list.',
    };
  } finally {
    clearTimeout(timeout);
    settled = true;
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
