// Actual native MCP discovery after config changes; disposable unauthenticated
// profile, blocked external network, no turn submissions or tool calls.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CodexChat } from '../codex-chat.mjs';
import { CodexWorkerPool } from '../codex-worker-pool.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-codex-mcp-reopen-'));
const pool = new CodexWorkerPool({ maxIdle: 2 }), runtimes = [];
try {
  const home = path.join(root, 'home'); await mkdir(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' });
  const receipt = path.join(root, 'receipt.jsonl'), fixture = fileURLToPath(new URL('./workspace-mcp-fixture.mjs', import.meta.url));
  const config = enabled => `check_for_update_on_startup=false\nweb_search="disabled"\n[features]\napps=false\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n` + (enabled == null ? '' : `[mcp_servers.review_fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([fixture, receipt])}\nenabled=${enabled}\n`);
  const account = { profileId: 'synthetic-review', privateHome: home, configRevision: 'synthetic', conversationStoreId: 'synthetic' };
  const open = async nativeId => {
    const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'low' }, env, account, workerPool: pool, stateDir: root });
    runtimes.push(runtime); const rpc = runtime.rpc.bind(runtime);
    runtime.rpc = (method, ...args) => { assert.ok(['thread/start', 'thread/resume', 'thread/read', 'thread/items/list', 'thread/turns/list', 'windowsSandbox/readiness', 'collaborationMode/list', 'account/read', 'mcpServerStatus/list'].includes(method), `Forbidden native review method: ${method}`); return rpc(method, ...args); };
    await runtime.start(nativeId); return runtime;
  };
  const tools = async runtime => (await runtime.rpc('mcpServerStatus/list', { threadId: runtime.threadId })).data?.find(row => row.name === 'review_fixture')?.tools || {};
  await writeFile(path.join(home, 'config.toml'), config(null));
  const first = await open(), sibling = await open(); assert.equal(sibling.transport, first.transport);
  // Materialize the same empty native ID without an inference turn.
  await first.rpc('thread/read', { threadId: first.threadId, includeTurns: true }).catch(error => {
    if (!error.nativeRejected || !/list_turns is not supported yet/.test(error.message)) throw error;
  });
  const durable = await first.rpc('thread/read', { threadId: first.threadId, includeTurns: false });
  assert.ok(durable.thread.path && await stat(durable.thread.path)); await first.close();
  await writeFile(path.join(home, 'config.toml'), config(true));
  const added = await open(first.threadId);
  assert.equal(added.threadId, first.threadId); assert.notEqual(added.transport, first.transport);
  assert.ok(Object.keys(await tools(added)).some(name => name.includes('synthetic_unity_visibility')));
  await added.close(); const unchanged = await open(first.threadId);
  assert.equal(unchanged.transport, added.transport);
  assert.ok(Object.keys(await tools(unchanged)).some(name => name.includes('synthetic_unity_visibility')));
  await unchanged.close();
  await writeFile(path.join(home, 'config.toml'), config(false));
  const disabled = await open(first.threadId);
  assert.notEqual(disabled.transport, added.transport); assert.deepEqual(await tools(disabled), {});
  assert.equal(sibling.closed, false); assert.equal((await sibling.rpc('thread/read', { threadId: sibling.threadId, includeTurns: false })).thread.id, sibling.threadId);
  assert.doesNotMatch(await readFile(receipt, 'utf8'), /CALL/);
  console.log('PASS actual Codex: same native conversation sees added MCP after close/reopen; unchanged config reuses worker; disabling removes tools; active sibling preserved; zero prompts/tool calls.');
} finally {
  // Pool shutdown proves process exit even if an attachment assertion failed.
  await pool.close(); await Promise.all(runtimes.map(runtime => runtime.close())); await cleanupFixtures();
}
