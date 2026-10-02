import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { portableLauncher } from '../../../scripts/portable-layout.mjs';

test('desktop isolates the launch profile before plugins and keeps portable Hub discovery independent', async () => {
  const main = await readFile(new URL('../../../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.ok(main.indexOf('context.config_mut().identifier = launch_profile::identifier') < main.indexOf('let result = tauri::Builder::default()'));
  assert.match(main, /\.build\(context\)/);
  assert.match(main, /portable\.as_deref\(\)\.map\(launch_profile::portable_hub\)/);
});

test('native launch profile policies distinguish installer, portable and explicit Hub launches', { skip: spawnSync('rustc', ['--version'], { windowsHide: true }).status !== 0 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-launch-policy-test-'));
  try {
    const binary = path.join(root, process.platform === 'win32' ? 'policy.exe' : 'policy');
    const source = new URL('../../../src-tauri/src/launch_profile.rs', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const compile = spawnSync('rustc', ['--edition=2021', '--test', fileURLToPath(source), '-o', binary], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(compile.status, 0, compile.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('portable launcher selects new, legacy or explicit Hub without copying or modifying data', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-layout-'));
  try {
    const launcher = path.join(root, 'Start Mr. Mik.cmd');
    // Replace only process launch with a fixture receipt; never launch the app.
    await writeFile(launcher, portableLauncher.replace('start "" "%~dp0App\\mrmak-workspace.exe" --repo "%MRMIK_HUB%"', 'echo %MRMIK_HUB%'));
    const select = args => {
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}"${args ? ` "${args}"` : ''}"`], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    assert.equal(select(), path.join(root, 'MyHub'));
    await mkdir(path.join(root, 'Hub/workspace'), { recursive: true });
    await writeFile(path.join(root, 'Hub/workspace/workspace.json'), 'legacy-marker');
    assert.equal(select(), path.join(root, 'Hub'));
    await mkdir(path.join(root, 'MyHub/workspace'), { recursive: true });
    await writeFile(path.join(root, 'MyHub/workspace/workspace.json'), 'user-marker');
    assert.equal(select(), path.join(root, 'MyHub'));
    const external = path.join(root, 'External Hub');
    assert.equal(select(external), external);
    assert.equal(await readFile(path.join(root, 'MyHub/workspace/workspace.json'), 'utf8'), 'user-marker');
    assert.equal(await readFile(path.join(root, 'Hub/workspace/workspace.json'), 'utf8'), 'legacy-marker');
  } finally { await rm(root, { recursive: true, force: true }); }
});
