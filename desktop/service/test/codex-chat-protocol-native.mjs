// Opt-in graphical-chat protocol spike. No user home, login or inference.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { codexBinary } from '../agents.mjs';
import { NativeProfileProbe } from '../codex-profile-probe.mjs';
import { prepareCodexProfileLayout, codexProfileEnvironment } from '../codex-profile-layout.mjs';
import { leaseConversation } from '../conversation-lease.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalCodexVersion } from '../codex-chat-binary.mjs';

const execute = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'mik-chat-spike-'));
const evidence = fileURLToPath(new URL('../../../.cache/codex-chat-spike-20261016/', import.meta.url));
const binary = codexBinary();
const nativeHome = path.join(root, 'home');
await mkdir(nativeHome);
const env = { ...process.env, CODEX_HOME: nativeHome, HOME: root, USERPROFILE: root,
  HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' };
for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BRIDGE_TOKEN/.test(key)) delete env[key];
const run = async args => (await execute(binary.file, [...binary.args, ...args], {
  cwd: root, env, windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024,
})).stdout;
const probes = [];
const graphical = [];
const checks = [];
const notifications = new Set();
const allowed = new Set(['initialize', 'account/read', 'config/read', 'thread/start', 'thread/resume', 'thread/read', 'thread/items/list', 'thread/turns/list', 'thread/fork', 'turn/interrupt', 'mcpServerStatus/list', 'windowsSandbox/readiness']);
const call = (probe, method, params) => {
  assert.ok(allowed.has(method), `Unauthorized spike RPC: ${method}`);
  return probe.rpc(method, params);
};
const record = (name, details = {}) => checks.push({ name, status: 'passed', ...details });
const open = async profile => {
  const probe = new NativeProfileProbe(root, codexProfileEnvironment(env, profile.privateHome, profile.sqliteHome));
  probes.push(probe);
  probe.lines.on('line', line => {
    try { const value = JSON.parse(line); if (value.method) notifications.add(value.method); } catch { /* Never retain raw native diagnostics. */ }
  });
  await probe.initialize();
  assert.equal(await probe.account(), null);
  return probe;
};
try {
  await mkdir(evidence, { recursive: true });
  const version = (await run(['--version'])).trim();
  assert.match(version, /codex/i);
  await writeFile(path.join(evidence, 'native-version.txt'), version + '\n');
  await writeFile(path.join(evidence, 'features.txt'), await run(['features', 'list']));
  for (const [name, args] of [['cli-help.txt', ['--help']], ['app-server-help.txt', ['app-server', '--help']], ['schema-help.txt', ['app-server', 'generate-json-schema', '--help']], ['resume-help.txt', ['resume', '--help']]]) {
    await writeFile(path.join(evidence, name), await run(args));
  }
  const schemas = path.join(evidence, 'schema');
  await run(['app-server', 'generate-json-schema', '--out', schemas]);
  const files = await readdir(schemas);
  assert.ok(files.length > 0);
  const clientSchema = JSON.parse(await readFile(path.join(schemas, 'ClientRequest.json'), 'utf8'));
  const requests = clientSchema.oneOf.map(item => item.properties.method.enum[0]);
  await writeFile(path.join(evidence, 'rpc-methods.json'), JSON.stringify(requests, null, 2) + '\n');
  const serverRequests = JSON.parse(await readFile(path.join(schemas, 'ServerRequest.json'), 'utf8'));
  const serverNotifications = JSON.parse(await readFile(path.join(schemas, 'ServerNotification.json'), 'utf8'));
  const enums = value => value && typeof value === 'object' ? [
    ...(Array.isArray(value.enum) ? value.enum : []), ...Object.values(value).flatMap(enums),
  ] : [];
  const manifest = { clientMethods: requests, serverRequests: serverRequests.oneOf.map(item => item.properties.method.enum[0]),
    serverNotifications: serverNotifications.oneOf.map(item => item.properties.method.enum[0]),
    mediaTypes: [...new Set(enums(serverNotifications).filter(value => /image|browser/i.test(value)))].sort() };
  await writeFile(path.join(evidence, 'capability-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const experimental = path.join(evidence, 'schema-experimental');
  await run(['app-server', 'generate-json-schema', '--experimental', '--out', experimental]);
  const experimentalSchema = JSON.parse(await readFile(path.join(experimental, 'ClientRequest.json'), 'utf8'));
  const experimentalMethods = experimentalSchema.oneOf.map(item => item.properties.method.enum[0]);
  await writeFile(path.join(evidence, 'experimental-capabilities.json'), JSON.stringify({
    methods: experimentalMethods, additionalMethods: experimentalMethods.filter(method => !requests.includes(method)),
    additionalThreadStartFields: Object.keys(experimentalSchema.definitions.ThreadStartParams.properties).filter(key => !Object.hasOwn(clientSchema.definitions.ThreadStartParams.properties, key)),
  }, null, 2) + '\n');
  const schemaHash = createHash('sha256').update(await readFile(path.join(schemas, 'ClientRequest.json'))).digest('hex');
  record('version-matched-schema-generation', { version, schemaFiles: files.length, clientRequestSha256: schemaHash });

  // Synthetic common settings/resources only. No real profile is read or linked.
  const sharedHome = path.join(root, 'shared'), sqliteHome = path.join(root, 'sqlite');
  await mkdir(sharedHome);
  const mcpScript = path.join(root, 'fixture-mcp.mjs');
  const mcpReceipt = path.join(root, 'mcp-receipt.txt');
  await writeFile(mcpScript, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const lines=createInterface({input:process.stdin});
lines.on('line', line=>{const m=JSON.parse(line); if(m.id===undefined)return;
let result={};
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated-fixture',version:'1'}};
else if(m.method==='tools/list'){appendFileSync(process.argv[2],'listed\\n');result={tools:[{name:'fixture_echo',description:'Synthetic local tool; never called by this spike.',inputSchema:{type:'object',properties:{}}}]};}
else if(m.method==='tools/call'){appendFileSync(process.argv[2],'CALLED\\n');result={content:[{type:'text',text:'synthetic'}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const sourceText = `web_search="disabled"\ncheck_for_update_on_startup=false\n[features]\napps=false\n[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([mcpScript, mcpReceipt])}\n`;
  const profiles = [];
  for (const name of ['a', 'b']) profiles.push(await prepareCodexProfileLayout({ privateHome: path.join(root, name), sharedHome, sqliteHome, sourceText, common: true }));
  const a = await open(profiles[0]);
  const effective = (await call(a, 'config/read', { cwd: root })).config;
  const readiness = await call(a, 'windowsSandbox/readiness', null);
  await writeFile(path.join(evidence, 'synthetic-sandbox-readiness.json'), JSON.stringify(readiness, null, 2));
  assert.equal(effective.mcp_servers.fixture.command, process.execPath);
  assert.equal(path.resolve(effective.sqlite_home).toLowerCase(), sqliteHome.toLowerCase());
  record('synthetic-common-mcp-configuration', { account: 'a', authenticated: false });

  for (const [mode, approvalPolicy, sandbox, reviewer] of [
    ['ask', 'on-request', 'workspace-write', 'user'],
    ['auto-review', 'on-request', 'workspace-write', 'auto_review'],
    ['bypass', 'never', 'danger-full-access', 'user'],
  ]) {
    const result = await call(a, 'thread/start', { cwd: root, ephemeral: true, approvalPolicy, sandbox, approvalsReviewer: reviewer });
    assert.ok(result.thread.id);
    assert.equal(result.approvalPolicy, approvalPolicy);
    assert.equal(result.approvalsReviewer, reviewer);
    const actualSandbox = result.sandbox?.type || result.sandbox;
    assert.ok(actualSandbox, 'Native sandbox response must be inspectable');
    await writeFile(path.join(evidence, `synthetic-permission-${mode}.json`), JSON.stringify(result, null, 2));
    const expectedSandbox = { 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[sandbox];
    checks.push({ name: 'permission-configuration-' + mode, status: actualSandbox === expectedSandbox ? 'passed' : 'gap',
      approvalPolicy, reviewer, requestedSandbox: sandbox, sandboxResponse: actualSandbox,
      executionEnforcement: 'not-tested', ...(actualSandbox === expectedSandbox ? {} : { note: 'Native effective sandbox differs from request; configuration acceptance is not parity.' }) });
  }

  const statuses = await call(a, 'mcpServerStatus/list', {});
  const fixture = statuses.data?.find(item => item.name === 'fixture');
  assert.ok(fixture, 'Synthetic server must be listed');
  assert.ok(Object.keys(fixture.tools || {}).some(name => name.includes('fixture_echo')), 'Native MCP discovery must expose the fixture tool');
  assert.ok((await readFile(mcpReceipt, 'utf8')).includes('listed'));
  assert.ok(!(await readFile(mcpReceipt, 'utf8')).includes('CALLED'));
  record('native-mcp-connection-and-tool-discovery', { toolCalls: 0 });

  // A real native parser reads a manufactured legacy conversation; no inference.
  const seed = randomUUID(), turn = randomUUID(), stamp = '2026-10-16T00:00:00Z';
  const folder = path.join(sharedHome, 'sessions', '2026', '10', '16');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `rollout-fixture-${seed}.jsonl`), [
    { timestamp: stamp, type: 'session_meta', payload: { id: seed, timestamp: stamp, cwd: root, originator: 'mr_mik_graphical_spike', cli_version: '0.162.1', source: 'cli', model_provider: 'openai' } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: 10000, collaboration_mode_kind: 'default' } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic continuity marker.', images: [], local_images: [], text_elements: [] } },
    { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic continuity marker.' }] } },
    { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic previous response.' }] } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic previous response.', phase: 'final_answer' } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'Synthetic previous response.' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  let release = await leaseConversation(profiles[0], seed);
  try {
    await assert.rejects(leaseConversation(profiles[1], seed), /already owned/);
    const resumed = await call(a, 'thread/resume', { threadId: seed, cwd: root });
    assert.equal(resumed.thread.id, seed);
    const history = await call(a, 'thread/read', { threadId: seed, includeTurns: true });
    await writeFile(path.join(evidence, 'synthetic-history-shape.json'), JSON.stringify(history, null, 2));
    assert.ok(JSON.stringify(history).includes('Synthetic continuity marker.'));
    record('native-synthetic-cli-transcript-resume');
    const fork = await call(a, 'thread/fork', { threadId: seed, cwd: root });
    assert.notEqual(fork.thread.id, seed);
    record('native-fork-preserves-original-identity');
    await assert.rejects(call(a, 'turn/interrupt', { threadId: seed, turnId: randomUUID() }));
    record('interrupt-rejects-nonexistent-turn', { liveTurnInterruption: 'not-tested' });
  } finally { await a.close(); await release(); }

  const b = await open(profiles[1]);
  release = await leaseConversation(profiles[1], seed);
  try {
    const resumed = await call(b, 'thread/resume', { threadId: seed, cwd: root });
    assert.equal(resumed.thread.id, seed);
    const history = await call(b, 'thread/read', { threadId: seed, includeTurns: true });
    assert.ok(JSON.stringify(history).includes('Synthetic continuity marker.'));
    record('restart-other-profile-resumes-same-synthetic-history', { actualAccountSwitch: 'not-tested' });
    const config = (await call(b, 'config/read', { cwd: root })).config;
    assert.deepEqual(config.mcp_servers.fixture, effective.mcp_servers.fixture);
    record('common-mcp-configuration-across-private-homes');
  } finally { await b.close(); await release(); }
  record('conversation-lease-conflict-and-explicit-transfer');
  const worker = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'medium' }, env: codexProfileEnvironment(env, profiles[0].privateHome, sqliteHome) });
  graphical.push(worker);
  await worker.start(seed);
  assert.equal(worker.threadId, seed);
  assert.ok(worker.snapshot().items.some(item => item.text === 'Synthetic continuity marker.'));
  assert.equal(worker.snapshot().effective.sandbox, 'readOnly');
  await worker.close(); assert.equal(worker.closed, true);
  record('production-graphical-runtime-native-resume-and-history', { modelRequests: 0 });
  // Opening the shared store with the private graphical engine must not prevent
  // the pre-existing CLI from resuming it afterwards. No inference is involved.
  const backToCli = await open(profiles[0]);
  try {
    const returned = await call(backToCli, 'thread/resume', { threadId: seed, cwd: root });
    assert.equal(returned.thread.id, seed);
    const returnedHistory = await call(backToCli, 'thread/read', { threadId: seed, includeTurns: true });
    assert.ok(JSON.stringify(returnedHistory).includes('Synthetic continuity marker.'));
    assert.ok(!backToCli.diagnosticKinds.has('sqlite-initialization'));
    record('existing-CLI-resumes-after-dedicated-graphical-engine', { cliVersion: version, graphicalVersion: graphicalCodexVersion, modelRequests: 0 });
  } finally { await backToCli.close(); }
  await Promise.all(probes.map(probe => probe.close()));
  const result = { version, checks, notificationMethods: [...notifications].sort(), inferenceRequests: 0, logins: 0,
    liveUserProfiles: 0, runtimeChildrenClosed: probes.every(probe => probe.exited),
    unverified: ['authenticated-account-switch', 'live-approval-decisions', 'live-turn-streaming-and-interruption', 'interactive-CLI-handoff', 'image-generation', 'embedded-shared-browser', 'full-slash-command-parity'] };
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.all(graphical.map(runtime => runtime.close()));
  await Promise.all(probes.map(probe => probe.close()));
  await cleanupFixtures();
}
