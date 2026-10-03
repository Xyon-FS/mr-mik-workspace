import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appVersion, readAppVersion } from '../app-version.mjs';
import { createService } from '../server.mjs';
import { WorkspaceSnapshot } from '../workspace-snapshot.mjs';

const source = name => readFile(new URL(`../../../${name}`, import.meta.url), 'utf8');

test('current Help describes shipped OpenCode support, core defaults, protected refresh and transfer limits', async () => {
  const guide = await source('docs/user-guide.md');
  assert.doesNotMatch(guide, /unreleased|Full V2 chat transfer remains unfinished|Native skill reload is not part|Published 0\.2\.7 downloads/i);
  for (const text of ['## OpenCode V1/V2', '**V2 conversation transfer:**', 'workspace-authoring and feature-handoff', 'protected same-conversation resume', 'Unavailable conversations: partial full transfer', 'Revert state, cross-folder', 'selected workspace when that ID exists']) assert.ok(guide.includes(text), `Missing current Help topic: ${text}`);
  const integration = await source('docs/opencode-integration.md');
  assert.doesNotMatch(integration, /unreleased|OpenCode settings mean Off|native skill changes still require a new launch/i);
});

test('service health and workspace snapshot identify the current app version', async t => {
  const { version } = JSON.parse(await source('package.json'));
  assert.equal(appVersion, version);
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-version-test-'));
  const repo = path.join(base, 'hub');
  await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: path.join(repo, 'home'), env: {} } });
  t.after(async () => { await service.close(); await rm(base, { recursive: true, force: true }); });
  assert.deepEqual(await (await fetch(`${service.origin}/health`)).json(), { service: 'mrmik', version });
  const project = await service.projects.save({ name: 'Version fixture' });
  const snapshots = new WorkspaceSnapshot(repo, path.join(repo, '.mrmak'), service.projects);
  const snapshot = await snapshots.exportTo(base, project.id);
  assert.equal((await snapshots.load(snapshot.path)).manifest.appVersion, version);
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
