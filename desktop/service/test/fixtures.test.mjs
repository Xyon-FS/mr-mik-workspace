import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp as nativeMkdtemp, mkdir, readFile, writeFile, symlink, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';

test('fixture teardown removes nested files and junctions without touching their targets', async () => {
  const external = await nativeMkdtemp(path.join(os.tmpdir(), 'mik-fixture-external-'));
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'mik-fixture-cleanup-'));
  try {
    await writeFile(path.join(external, 'sentinel.txt'), 'Keep external content');
    await mkdir(path.join(fixture, 'nested'));
    await writeFile(path.join(fixture, 'nested/file.txt'), 'temporary');
    await symlink(external, path.join(fixture, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
    let closes = 0;
    const service = await createService({ fixture }, async options => {
      assert.equal(options.fixture, fixture);
      return { close: async () => { await stat(fixture); closes++; } };
    });
    assert.equal(typeof service.close, 'function');
    await cleanupFixtures();
    assert.equal(closes, 1);
    await assert.rejects(stat(fixture), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(external, 'sentinel.txt'), 'utf8'), 'Keep external content');
  } finally { await rm(external, { recursive: true, force: true }); }
});

test('fixture teardown refuses a replaced root and can clean it after restoration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-fixture-replaced-'));
  const retained = `${root}-original`;
  await rename(root, retained);
  try {
    await mkdir(root);
    await writeFile(path.join(root, 'sentinel.txt'), 'Not the original fixture');
    await assert.rejects(cleanupFixtures(), /cleanup failed/);
    assert.equal(await readFile(path.join(root, 'sentinel.txt'), 'utf8'), 'Not the original fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rename(retained, root);
  }
  await cleanupFixtures();
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('script failures and failed node tests both clean their own temporary directories', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-fixture-failure-'));
  for (const nodeTest of [false, true]) {
    const script = `import { mkdtemp } from ${JSON.stringify(new URL('./fixtures.mjs', import.meta.url).href)};
      import { writeFile } from 'node:fs/promises';
      const folder = await mkdtemp(${JSON.stringify(path.join(base, 'child-'))});
      await writeFile(folder + '/fixture.txt', 'temporary');
      console.log('FIXTURE=' + folder);
      ${nodeTest ? "const { default: test } = await import('node:test'); test('intentional failure', () => { throw new Error('expected fixture failure'); });" : "throw new Error('expected fixture failure');"}`;
    const file = path.join(base, nodeTest ? 'failure.test.mjs' : 'failure.mjs');
    await writeFile(file, script);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, nodeTest ? ['--test', file] : [file], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { diagnostic += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 1);
    const created = /FIXTURE=(.*)/.exec(output)?.[1].trim();
    assert.ok(created, output);
    await assert.rejects(stat(created), { code: 'ENOENT' }, `Failure cleanup (${nodeTest}): ${diagnostic}`);
  }
});
