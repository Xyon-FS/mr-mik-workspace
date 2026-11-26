import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appVersion, readAppVersion } from '../app-version.mjs';

const source = name => readFile(new URL(`../../../${name}`, import.meta.url), 'utf8');

test('bundled Help entries point to substantive local guides without unsupported Markdown links', async () => {
  const help = await source('src/desktop/HelpSite.tsx');
  for (const document of ['user-guide', 'workspace-snapshots']) {
    assert.ok(help.includes('docs/' + document + '.md?raw'), document);
    const content = await source('docs/' + document + '.md');
    assert.match(content, /^#{1,3}\s+\S/m);
    assert.doesNotMatch(content, /\]\((?!https?:|#)[^)]*\.md(?:#[^)]*)?\)/);
  }
});

test('packaged version survives relocation without a source tree and rejects invalid build metadata', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-version-runtime-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const module = path.join(repo, 'app-version.mjs'), metadata = path.join(repo, 'app-version.json');
  await copyFile(new URL('../app-version.mjs', import.meta.url), module);
  await writeFile(metadata, JSON.stringify({ version: appVersion }));
  assert.equal((await import(pathToFileURL(module))).appVersion, appVersion);
  await writeFile(metadata, '{"version":""}');
  await assert.rejects(readAppVersion(pathToFileURL(metadata)), /Invalid application version/);
});
