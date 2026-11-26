// Native control-plane profiling only: synthetic histories, no login/inference.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {Session as InspectorSession} from 'node:inspector';
import {mkdir, writeFile, stat} from 'node:fs/promises';
import {Sessions} from '../sessions.mjs';
import {CodexChat} from '../codex-chat.mjs';
import {graphicalCodexVersion} from '../codex-chat-binary.mjs';
import {mkdtemp, createService, cleanupFixtures} from './fixtures.mjs';

if (!process.argv.includes('--run')) throw new Error('Use --run for isolated native profiling.');
const root = await mkdtemp(path.join(os.tmpdir(), 'mik-reconnect-profile-'));
const results = {nativeVersion: graphicalCodexVersion, authenticated: false, inferenceCalls: 0, scenarios: [], hydration: []};
const owners = new Set();
const profiler = process.argv.includes('--cpu') ? new InspectorSession() : null;
const inspectorCall = method => new Promise((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result)));
const round = n => Math.round(n * 10) / 10;
const allowed = new Set(['initialize', 'account/read', 'config/read', 'thread/resume', 'thread/read', 'thread/items/list', 'thread/turns/list', 'thread/unsubscribe', 'windowsSandbox/readiness', 'collaborationMode/list']);

async function history(home, turns) {
  const id = randomUUID(), stamp = '2026-11-04T00:00:00Z';
  const folder = path.join(home, 'sessions', '2026', '11', '04');
  await mkdir(folder, {recursive: true});
  const lines = [{timestamp: stamp, type: 'session_meta', payload: {id, timestamp: stamp, cwd: root, originator: 'mr_mik_profile_fixture', cli_version: graphicalCodexVersion, source: 'cli', model_provider: 'openai'}}];
  const add = (type, payload) => lines.push({timestamp: stamp, type, payload});
  for (let n = 0; n < turns; n++) {
    const turn = randomUUID(), text = `Synthetic turn ${n}: ` + 'Fixture text only. '.repeat(30);
    add('event_msg', {type: 'task_started', turn_id: turn, model_context_window: 100000, collaboration_mode_kind: 'default'});
    add('event_msg', {type: 'user_message', message: text, images: [], local_images: [], text_elements: []});
    add('response_item', {type: 'message', role: 'user', content: [{type: 'input_text', text}]});
    add('response_item', {type: 'message', role: 'assistant', phase: 'final_answer', content: [{type: 'output_text', text}]});
    add('event_msg', {type: 'agent_message', message: text, phase: 'final_answer'});
    add('event_msg', {type: 'task_complete', turn_id: turn, last_agent_message: text});
  }
  const file = path.join(folder, `rollout-${id}.jsonl`);
  await writeFile(file, lines.map(value => JSON.stringify(value)).join('\n') + '\n');
  return {id, bytes: (await stat(file)).size};
}

async function scenario(name, counts, alternateAccount = false, servicePreparation = false) {
  const folder = path.join(root, name), home = path.join(folder, 'home'), state = path.join(folder, 'state');
  await mkdir(home, {recursive: true});
  await writeFile(path.join(home, 'config.toml'), 'check_for_update_on_startup=false\nweb_search="disabled"\n[features]\napps=false\n');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) env[key] = value;
  Object.assign(env, {CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: ''});
  const service = servicePreparation ? await createService({repo: root, stateDir: state, uiDir: path.resolve('dist'), mcpOptions: {home, env}}) : null;
  const sessions = service?.sessions || await new Sessions(root, state).init();
  const owner = service || sessions; owners.add(owner);
  // Synthetic system context only; production identity guards remain unchanged.
  sessions.requireExplicitAccount = false;
  const rows = [], phases = [], notifications = [], runtimeOwners = new Map(); let origin;
  const eventLoop = monitorEventLoopDelay({resolution: 10});
  const timed = (phase, id, fn) => async (...args) => {
    const started = performance.now(); let ok = false;
    try { const result = await fn(...args); ok = true; return result; }
    finally { phases.push({id, phase, startMs: round(started-origin), ms: round(performance.now()-started), ok}); }
  };
  if (service) service.sharedBrowsers.tools = timed('browser-tool-catalog', null, service.sharedBrowsers.tools.bind(service.sharedBrowsers));
  sessions.accountContext = session => ({profileId: session.accountProfileId, privateHome: home, sqliteHome: home, sharedHome: home, configRevision: 'synthetic', conversationStoreId: 'synthetic', env});
  sessions.verifyAccount = async session => {
    session.verifyStartupAccount = async runtime => {
      await runtime.rpc('config/read', {cwd: root});
      assert.equal((await runtime.rpc('account/read', {refreshToken: false})).account, null);
    };
  };
  sessions.createGraphicalRuntime = options => {
    const runtime = new CodexChat({...options, workerPool: sessions.codexWorkers});
    runtimeOwners.set(runtime.runtimeId, options.session.id);
    const install = runtime.installTransport.bind(runtime);
    runtime.installTransport = transport => {
      if (!transport.profiled) {
        transport.profiled = true;
        transport.on('message', message => { if (typeof message.method === 'string') notifications.push({method: message.method, ms: round(performance.now()-origin), ...(message.method === 'mcpServer/startupStatus/updated' ? {status: message.params?.status?.type || null} : {})}); });
        const rpc = transport.rpc.bind(transport);
        transport.rpc = (method, ...args) => {
          assert.ok(allowed.has(method), `Profiling must not submit native work: ${method}`);
          return timed(method, runtimeOwners.get(args[2]) || options.session.id, () => rpc(method, ...args))();
        };
      }
      return install(transport);
    };
    // Dedicated-transport fallback must be covered as well.
    runtime.installTransport(runtime.transport);
    return runtime;
  };
  for (const method of ['hydrate', 'nativeBoundary', 'launch', 'launchChat', 'persist', 'accountContext', 'verifyAccount', 'resolveLocation', 'captureTools', 'prepareLaunch', 'prepareBrowser']) {
    if (typeof sessions[method] !== 'function') continue;
    const fn = sessions[method].bind(sessions);
    sessions[method] = (...args) => timed(method, args[0]?.id || null, () => fn(...args))();
  }
  for (const [index, turns] of counts.entries()) {
    const seed = await history(home, turns);
    const session = sessions.make({id: randomUUID(), name: 'Synthetic restore', agent: 'codex', chatInterface: 'chat', accountProfileId: servicePreparation ? 'system' : alternateAccount ? `fixture-${index}` : 'fixture', nativeId: seed.id, hasConversation: true, open: true, status: 'stopped', cwd: root, cols: 90, rows: 32});
    session.profileFixture = {turns, bytes: seed.bytes}; sessions.items.set(session.id, session);
  }
  const resume = sessions.resume.bind(sessions);
  sessions.resume = async id => {
    const started = performance.now(); await resume(id);
    const session = sessions.get(id), runtime = session.graphical;
    assert.equal(runtime.threadId, session.nativeId); assert.equal(session.status, 'running');
    assert.equal(runtime.uncertain, false); assert.equal(runtime.capabilitiesPending, false);
    rows.push({id, ...session.profileFixture, queuedMs: round(started-origin), ownMs: round(performance.now()-started), readyMs: round(performance.now()-origin), historyMode: runtime.historyMode || 'legacy', projectedItems: runtime.items.size, connected: runtime.initialized, worker: [...sessions.codexWorkers.retained].findIndex(worker => worker.transport === runtime.transport)});
  };
  try {
    if (profiler && servicePreparation) await inspectorCall('Profiler.start');
    eventLoop.enable(); origin = performance.now(); await sessions.restore();
    assert.equal(rows.length, counts.length, 'Every synthetic conversation must restore: ' + [...sessions.items.values()].map(item => item.restoreError || '').join('; '));
    eventLoop.disable();
    if (profiler && servicePreparation) { const {profile} = await inspectorCall('Profiler.stop'); await writeFile(path.resolve(`.cache/chat-reconnection-${name}.cpuprofile`), JSON.stringify(profile)); }
    results.scenarios.push({name, rows, phases, notifications, eventLoopMaxMs: round(eventLoop.max/1e6)}); console.log(JSON.stringify({name, rows}));
  } finally { eventLoop.disable(); await owner.close(); owners.delete(owner); }
}

try {
  if (profiler) { profiler.connect(); await inspectorCall('Profiler.enable'); }
  await mkdir(path.join(root, 'workspace'), {recursive: true});
  await writeFile(path.join(root, 'workspace', 'workspace.json'), '{"entities":[]}');
  for (const snapshotLines of [0, 3000]) for (const count of [1, 20, 100]) {
    const state = path.join(root, `hydration-${snapshotLines}-${count}`); await mkdir(state);
    const metadata = [];
    for (let n = 0; n < count; n++) {
      const id = randomUUID(); metadata.push({id, agent: 'codex', chatInterface: 'chat', open: true, name: 'Synthetic hydration', cols: 90, rows: 32});
      await writeFile(path.join(state, `screen-${id}.json`), JSON.stringify({data: ('Synthetic terminal snapshot '.repeat(3)+'\r\n').repeat(snapshotLines)}));
    }
    await writeFile(path.join(state, 'sessions.json'), JSON.stringify(metadata));
    const sessions = new Sessions(root, state); owners.add(sessions);
    const start = performance.now(); await sessions.init();
    results.hydration.push({openGraphicalChats: count, snapshotLinesEach: snapshotLines, ms: round(performance.now()-start)});
    await sessions.close(); owners.delete(sessions);
  }
  await scenario('same-account-short', [1, 1, 1]);
  await scenario('separate-account-short', [1, 1, 1], true);
  await scenario('history-growth', [1, 100, 1000]);
  await scenario('repeat-history-growth', [1, 100, 1000]);
  await scenario('service-preparation', [1, 100, 1000], false, true);
  await scenario('repeat-service-preparation', [1, 100, 1000], false, true);
  for (let n=0; n<3; n++) await scenario('service-variability-'+n, [1, 100, 1000], false, true);
  await writeFile(path.resolve('.cache/chat-reconnection-native-profile.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({hydration: results.hydration, inferenceCalls: 0}));
} finally {
  profiler?.disconnect();
  const closed = await Promise.allSettled([...owners].map(owner => owner.close()));
  if (closed.some(item => item.status === 'rejected')) throw new AggregateError(closed.filter(item => item.status === 'rejected').map(item => item.reason), 'Profiling cleanup failed; fixtures retained.');
  await cleanupFixtures();
}
