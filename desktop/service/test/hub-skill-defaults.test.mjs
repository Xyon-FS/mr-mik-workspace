import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Projects } from '../projects.mjs';
import { defaultHubSkillScopes, coreHubSkills, hubSkillUseRule } from '../hub-skill-defaults.mjs';
import { installMissingGameSkills } from '../skill-pack.mjs';
import { chatOrientation } from '../chat-orientation.mjs';
import { WorkspaceSnapshot } from '../workspace-snapshot.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { Sessions } from '../sessions.mjs';

test('new Hub seed enables only core skills for both agents and supports Off/Inherit', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-core-skills-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await installMissingGameSkills(repo);
  await mkdir(path.join(repo, 'projects'), { recursive: true });
  await writeFile(path.join(repo, 'projects/skill-defaults.json'), JSON.stringify(defaultHubSkillScopes));
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  const workspace = await projects.save({ name: 'Planning' });
  for (const agent of ['codex', 'claude']) {
    const skills = await projects.hubSkills(workspace.id, agent);
    for (const skill of skills) assert.equal(skill.effective, coreHubSkills.includes(skill.id));
    for (const id of coreHubSkills) {
      await projects.setHubSkillScope({ id, agent, projectId: workspace.id, scope: 'project', enabled: false });
      await assert.rejects(projects.readHubSkill(workspace.id, id, agent), /not enabled/);
      assert.equal((await projects.hubSkills(null, agent)).find(skill => skill.id === id).global, true);
      await projects.setHubSkillScope({ id, agent, projectId: workspace.id, scope: 'project', enabled: null });
      assert.ok((await projects.readHubSkill(workspace.id, id, agent)).text);
    }
  }
});

test('existing scopes including explicit Off take precedence over public new-Hub defaults', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-existing-skills-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await installMissingGameSkills(repo);
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  assert.ok((await projects.hubSkills()).every(skill => !skill.effective));
  await mkdir(path.join(repo, 'projects'), { recursive: true });
  await writeFile(path.join(repo, 'projects/skill-defaults.json'), JSON.stringify(defaultHubSkillScopes));
  const original = JSON.stringify({ skills: { 'workspace-authoring': { global: false } }, claudeSkills: {} });
  await writeFile(projects.skillScopesPath, original);
  for (const agent of ['codex', 'claude']) assert.ok((await projects.hubSkills(null, agent)).every(skill => !skill.effective));
  await installMissingGameSkills(repo);
  assert.equal(await readFile(projects.skillScopesPath, 'utf8'), original);
});

test('compact orientation routes relevant skill reads without preloading instructions', () => {
  const text = chatOrientation({ workspaceName: 'Game', cardName: 'Notes', workingProjectName: 'Unity' });
  assert.ok(text.includes(hubSkillUseRule));
  assert.match(text, /Skip disabled skills/);
  assert.match(text, /metadata-only changes/);
  assert.match(text, /reuse instructions/);
  assert.ok(hubSkillUseRule.length < 600);
  assert.doesNotMatch(text, /# Feature handoff|# Workspace authoring/);
});

test('Hub archives retain public defaults and snapshots preserve destination global defaults', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-default-transfer-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const make = async name => {
    const repo = path.join(base, name), state = path.join(repo, '.mrmak');
    for (const folder of ['workspace', 'projects', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [], resources: [] }));
    await installMissingGameSkills(repo);
    await writeFile(path.join(repo, 'projects/skill-defaults.json'), JSON.stringify(defaultHubSkillScopes));
    const projects = new Projects(repo, state);
    const sessions = await new Sessions(repo, state).init();
    return { repo, state, projects, archive: new PortableArchive(repo, state, sessions, projects), snapshot: new WorkspaceSnapshot(repo, state, projects) };
  };
  const source = await make('source'), target = await make('target');
  const project = await source.projects.save({ name: 'Reports' });
  const snapshot = await source.snapshot.exportTo(base, project.id);
  await target.snapshot.importFrom(snapshot.path);
  for (const agent of ['codex', 'claude']) {
    const global = await target.projects.hubSkills(null, agent);
    for (const id of coreHubSkills) assert.equal(global.find(skill => skill.id === id).global, true);
    for (const id of coreHubSkills) assert.equal((await target.projects.hubSkills(project.id, agent)).find(skill => skill.id === id).effective, true);
  }
  for (const chats of ['full', 'light']) {
    const recipient = await make(`recipient-${chats}`);
    const archive = await source.archive.exportTo(base, { chats });
    await recipient.archive.importFrom(archive.path);
    for (const agent of ['codex', 'claude']) for (const id of coreHubSkills) assert.equal((await recipient.projects.hubSkills(null, agent)).find(skill => skill.id === id).effective, true);
  }
});
