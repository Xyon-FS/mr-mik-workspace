import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installMissingGameSkills, gameSkillPack } from '../skill-pack.mjs';
import { Projects } from '../projects.mjs';

test('new pack is synchronized for both agents, Off by default, with independent overrides', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-skills-'));
  const repo = path.join(base, 'hub');
  await mkdir(repo);
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.equal((await installMissingGameSkills(repo)).length, gameSkillPack.length * 2);
  assert.deepEqual(await installMissingGameSkills(repo), []);
  assert.match(await readFile(path.join(repo, 'knowledge/voice-dictation.md'), 'utf8'), /Optional local dictation/);
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  const externalA = path.join(base, 'a'), externalB = path.join(base, 'b');
  await mkdir(externalA); await mkdir(externalB);
  const a = await projects.save({ name: 'Game A', repositoryPath: externalA }), b = await projects.save({ name: 'Game B', repositoryPath: externalB });
  for (const agent of ['codex', 'claude']) {
    const skills = await projects.hubSkills(a.id, agent);
    assert.equal(skills.length, gameSkillPack.length);
    assert.ok(skills.every(skill => !skill.global && !skill.effective));
    for (const name of gameSkillPack) {
      assert.equal(await readFile(path.join(repo, '.agents/skills', name, 'SKILL.md'), 'utf8'), await readFile(path.join(repo, '.claude/skills', name, 'SKILL.md'), 'utf8'));
      await assert.rejects(projects.readHubSkill(a.id, name, agent), /not enabled/);
    }
    for (const name of ['fal-ai-generation', 'higgsfield-workflow', 'motion-reference-workflow', 'voice-dictation-setup']) {
      await projects.setHubSkillScope({ id: name, scope: 'global', enabled: true, agent });
      assert.equal((await projects.hubSkills(a.id, agent)).find(skill => skill.id === name).effective, true);
      await projects.setHubSkillScope({ id: name, projectId: a.id, scope: 'project', enabled: false, agent });
      assert.equal((await projects.hubSkills(a.id, agent)).find(skill => skill.id === name).effective, false);
      assert.equal((await projects.hubSkills(b.id, agent)).find(skill => skill.id === name).effective, true);
    }
    await projects.setHubSkillScope({ id: gameSkillPack[0], projectId: a.id, scope: 'project', enabled: true, agent });
    assert.ok((await projects.readHubSkill(a.id, gameSkillPack[0], agent)).text.includes('Mr. Mik scope'));
    assert.equal((await projects.hubSkills(b.id, agent)).find(skill => skill.id === gameSkillPack[0]).effective, false);
    await projects.setHubSkillScope({ id: gameSkillPack[1], scope: 'global', enabled: true, agent });
    await projects.setHubSkillScope({ id: gameSkillPack[1], projectId: a.id, scope: 'project', enabled: false, agent });
    assert.equal((await projects.hubSkills(a.id, agent)).find(s => s.id === gameSkillPack[1]).effective, false);
    assert.equal((await projects.hubSkills(b.id, agent)).find(s => s.id === gameSkillPack[1]).effective, true);
  }
});

test('pack install preserves customized folders and existing scope bytes', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-skills-preserve-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const folder = path.join(repo, '.agents/skills', gameSkillPack[0]);
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'SKILL.md'), 'Custom skill');
  await mkdir(path.join(repo, 'projects'));
  const scopes = '{"skills":{"custom":{"global":true}},"claudeSkills":{}}\n';
  await writeFile(path.join(repo, 'projects/skill-scopes.json'), scopes);
  assert.equal((await installMissingGameSkills(repo)).length, gameSkillPack.length * 2 - 1);
  assert.equal(await readFile(path.join(folder, 'SKILL.md'), 'utf8'), 'Custom skill');
  assert.equal(await readFile(path.join(repo, 'projects/skill-scopes.json'), 'utf8'), scopes);
});

test('pack install rejects an external Hub skill junction', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-skills-junction-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'hub'), outside = path.join(base, 'outside');
  await mkdir(repo); await mkdir(outside);
  await symlink(outside, path.join(repo, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installMissingGameSkills(repo), /outside the Hub/);
});
