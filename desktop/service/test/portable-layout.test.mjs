import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { portableLauncher } from '../../../scripts/portable-layout.mjs';

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
