import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHub } from '../create-hub.mjs';
import { buildStarterHub } from '../../../scripts/starter-hub.mjs';
import { sourceFiles } from '../../../scripts/source-files.mjs';
import { spawnSync } from 'node:child_process';

test('first-use Hub seeds clean defaults, preserves existing Hubs and rejects an invalid starter', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-onboarding-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const template = path.join(folder, 'template');
  await buildStarterHub(fileURLToPath(new URL('../../../', import.meta.url)), template);
  const destination = path.join(folder, 'custom', 'MyHub');
  await createHub(template, destination);
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const instructions = await readFile(path.join(destination, name), 'utf8');
    assert.equal(instructions, await readFile(path.join(sourceRoot, 'templates/hub', name), 'utf8'));
    assert.notEqual(instructions, await readFile(path.join(sourceRoot, name), 'utf8'), 'Development instructions must never be copied into a user Hub');
    assert.doesNotMatch(instructions, /npm run|src-tauri|desktop\/service\/test|docs\/getting-started\.md/);
    assert.equal(await readFile(path.join(template, name), 'utf8'), instructions, 'Installer and portable share the same Hub instructions');
  }
  assert.match(await readFile(path.join(destination, 'AGENTS.md'), 'utf8'), /mrmak_hub_destination/);
  assert.match(await readFile(path.join(destination, 'CLAUDE.md'), 'utf8'), /\[AGENTS\.md\]\(AGENTS\.md\)/);
  assert.equal(await lstat(path.join(destination, 'templates')).catch(() => null), null);
  const sources = await sourceFiles(sourceRoot);
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'templates/hub/AGENTS.md', 'templates/hub/CLAUDE.md']) assert.ok(sources.includes(name), `Source archives must retain ${name}`);
  assert.equal(JSON.parse(await readFile(path.join(destination, 'workspace/workspace.json'))).entities.length, 4);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'projects/skill-defaults.json'))), JSON.parse(await readFile(path.join(template, 'projects/skill-defaults.json'))));
  await readFile(path.join(destination, '.agents/skills/workspace-authoring/SKILL.md'));
  await readFile(path.join(destination, '.claude/skills/feature-handoff/SKILL.md'));
  assert.equal(await lstat(path.join(destination, '.codex')).catch(() => null), null);
  await writeFile(path.join(destination, 'my-notes.txt'), 'Keep my work');
  await writeFile(path.join(destination, 'AGENTS.md'), 'My custom Hub instructions');
  await writeFile(path.join(destination, 'CLAUDE.md'), 'My custom Claude instructions');
  await assert.rejects(createHub(template, destination), /already exists/);
  assert.equal(await readFile(path.join(destination, 'my-notes.txt'), 'utf8'), 'Keep my work');
  assert.equal(await readFile(path.join(destination, 'AGENTS.md'), 'utf8'), 'My custom Hub instructions');
  assert.equal(await readFile(path.join(destination, 'CLAUDE.md'), 'utf8'), 'My custom Claude instructions');
  const empty = path.join(folder, 'empty'); await mkdir(empty);
  await assert.rejects(createHub(template, empty), /already exists/);
  const invalidTemplate = path.join(folder, 'invalid-template'); await mkdir(path.join(invalidTemplate, 'workspace'), { recursive: true });
  await writeFile(path.join(invalidTemplate, 'workspace/workspace.json'), '{}');
  const invalidDestination = path.join(folder, 'MyHub');
  await assert.rejects(createHub(invalidTemplate, invalidDestination), /invalid/);
  assert.equal(await lstat(invalidDestination).catch(() => null), null);
});

test('onboarding reuses a valid Hub without requiring a template or changing personal files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-existing-hub-'));
  const hub = path.join(root, 'MyHub');
  await mkdir(path.join(hub, 'workspace'), { recursive: true });
  await mkdir(path.join(hub, '.mrmak'));
  const files = { 'workspace/workspace.json': '{"entities":[{"id":"personal","title":"My card"}]}', '.mrmak/settings.json': '{"defaultAgent":"claude"}', 'AGENTS.md': 'My instructions', 'CLAUDE.md': 'My Claude instructions', 'notes.txt': 'Keep my work' };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(hub, name), bytes);
  assert.equal(await createHub(path.join(root, 'missing-template'), hub, { reuseExisting: true }), hub);
  const initializer = fileURLToPath(new URL('../create-hub.mjs', import.meta.url));
  const reused = spawnSync(process.execPath, [initializer, path.join(root, 'missing-template'), hub, '--reuse-existing'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(reused.status, 0, reused.stderr);
  for (const [name, bytes] of Object.entries(files)) assert.equal(await readFile(path.join(hub, name), 'utf8'), bytes);
  assert.equal(await lstat(path.join(hub, 'MyHub')).catch(() => null), null);
  await assert.rejects(createHub(path.join(root, 'missing-template'), hub), /already exists/);
  for (const marker of [null, '{}', '{invalid']) {
    const folder = path.join(root, `case-${marker === null ? 'empty' : marker === '{}' ? 'wrong' : 'malformed'}`);
    await mkdir(folder);
    if (marker !== null) { await mkdir(path.join(folder, 'workspace')); await writeFile(path.join(folder, 'workspace/workspace.json'), marker); }
    const before = await readdir(folder);
    await assert.rejects(createHub(path.join(root, 'missing-template'), folder, { reuseExisting: true }), /will not be overwritten/);
    assert.deepEqual(await readdir(folder), before);
    if (marker !== null) assert.equal(await readFile(path.join(folder, 'workspace/workspace.json'), 'utf8'), marker);
  }
});
