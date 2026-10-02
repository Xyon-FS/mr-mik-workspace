import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHub } from '../create-hub.mjs';
import { buildStarterHub } from '../../../scripts/starter-hub.mjs';

test('first-use Hub has clean examples and defaults; existing Hubs cannot be overwritten', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-onboarding-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const template = path.join(folder, 'template');
  await buildStarterHub(fileURLToPath(new URL('../../../', import.meta.url)), template);
  const destination = path.join(folder, 'custom', 'MyHub');
  await createHub(template, destination);
  assert.equal(JSON.parse(await readFile(path.join(destination, 'workspace/workspace.json'))).entities.length, 4);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'projects/skill-defaults.json'))), JSON.parse(await readFile(path.join(template, 'projects/skill-defaults.json'))));
  await readFile(path.join(destination, '.agents/skills/workspace-authoring/SKILL.md'));
  await readFile(path.join(destination, '.claude/skills/feature-handoff/SKILL.md'));
  assert.equal(await lstat(path.join(destination, '.codex')).catch(() => null), null);
  await writeFile(path.join(destination, 'my-notes.txt'), 'Keep my work');
  await assert.rejects(createHub(template, destination), /already exists/);
  assert.equal(await readFile(path.join(destination, 'my-notes.txt'), 'utf8'), 'Keep my work');
  const empty = path.join(folder, 'empty'); await mkdir(empty);
  await assert.rejects(createHub(template, empty), /already exists/);
});

test('invalid starter is rejected before creating a destination', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-onboarding-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const template = path.join(folder, 'template'); await mkdir(path.join(template, 'workspace'), { recursive: true });
  await writeFile(path.join(template, 'workspace/workspace.json'), '{}');
  const destination = path.join(folder, 'MyHub');
  await assert.rejects(createHub(template, destination), /invalid/);
  assert.equal(await lstat(destination).catch(() => null), null);
});
