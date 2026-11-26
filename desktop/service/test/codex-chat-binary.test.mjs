import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { graphicalCodexBinary, graphicalCodexVersion } from '../codex-chat-binary.mjs';
import { terminalCommand } from '../agents.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

test('graphical launch requires its private engine even when the terminal has a valid CLI', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-engine-separation-'));
  const cli = path.join(root, 'codex.exe'); await writeFile(cli, 'Synthetic CLI, never executed.');
  const env = { ...process.env, APPDATA: root, PATH: root, Path: root };
  const before = terminalCommand('codex', { env, codexPermissions: 'ask' });
  assert.equal(before.file, cli);
  const transport = graphicalFixture(); let graphicalFile;
  const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask' }, env,
    spawnChild: (file, ...args) => { graphicalFile = file; return transport.spawnChild(file, ...args); },
    bridge: { script: path.join(root, 'bridge.mjs'), instructions: 'Scoped fixture only.', codexWritableRoots: false },
    browser: { serverName: 'fixture_browser', command: process.execPath, args: ['fixture'] } });
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(graphicalFile, graphicalCodexBinary().file);
  assert.notEqual(graphicalFile, cli);
  const child = transport.children[0];
  assert.equal(runtime.snapshot().effective.sandbox, 'readOnly');
  assert.equal(child.options.windowsHide, true);
  assert.ok(child.args.includes('app-server'));
  assert.ok(child.args.includes('mcp_servers.mrmak_workspace.enabled=true'));
  assert.ok(child.args.some(value => value.startsWith('mcp_servers.fixture_browser=')));
  assert.ok(child.args.includes('approvals_reviewer="user"'));
  assert.equal(runtime.ready(), true);
  assert.deepEqual(terminalCommand('codex', { env, codexPermissions: 'ask' }), before);

  const packageRoot = path.join(root, 'incomplete-engine');
  await mkdir(packageRoot);
  const resolve = () => graphicalCodexBinary({ packageRoot });
  assert.throws(resolve, /dedicated graphical Codex runtime/);
  const bin = path.join(packageRoot, 'vendor/x86_64-pc-windows-msvc/bin');
  const resources = path.join(packageRoot, 'vendor/x86_64-pc-windows-msvc/codex-resources');
  await mkdir(bin, { recursive: true }); await mkdir(resources, { recursive: true });
  for (const file of [path.join(bin, 'codex.exe'), path.join(resources, 'codex-command-runner.exe'), path.join(resources, 'codex-windows-sandbox-setup.exe')]) await writeFile(file, 'Synthetic package, never executed.');
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.162.1-win32-x64' }));
  assert.throws(resolve, /dedicated graphical Codex runtime/);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: `${graphicalCodexVersion}-win32-x64` }));
  assert.equal(resolve().file, path.join(bin, 'codex.exe'));
  await unlink(path.join(resources, 'codex-windows-sandbox-setup.exe'));
  assert.throws(resolve, /dedicated graphical Codex runtime/);
});
