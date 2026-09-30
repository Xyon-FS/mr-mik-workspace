import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameSkillPack } from '../desktop/service/skill-pack.mjs';
import { exampleKey, exampleCards } from '../desktop/service/example-workspace.mjs';
import { Projects } from '../desktop/service/projects.mjs';
import { coreHubSkills } from '../desktop/service/hub-skill-defaults.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'release', version), portable = path.join(release, 'Mr-Mik-portable');
for (const line of (await readFile(path.join(release, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')) {
  const [expected, name] = line.split(/\s{2}/); const digest = createHash('sha256');
  for await (const chunk of createReadStream(path.join(release, name))) digest.update(chunk);
  assert.equal(digest.digest('hex'), expected, 'Release checksum mismatch');
}
for (const file of ['.mrmak', '.codex', '.env', '.claude/settings.local.json', 'projects/skill-scopes.json']) assert.equal(await lstat(path.join(portable, 'Hub', file)).catch(() => null), null);
const exampleRegistry = JSON.parse(await readFile(path.join(portable, 'Hub/workspace/workspace.json'), 'utf8'));
const exampleProjects = JSON.parse(await readFile(path.join(portable, 'Hub/projects/registry.json'), 'utf8')).projects;
assert.equal(exampleProjects.length, 1); assert.equal(exampleProjects[0].exampleKey, exampleKey); assert.deepEqual(exampleProjects[0].repositories, []);
assert.deepEqual(exampleRegistry.entities.map(card => card.title), exampleCards.map(card => card.title));
assert.ok(exampleRegistry.entities.every(card => card.sample && card.projectId === exampleProjects[0].id && card.repositoryId === null));
assert.deepEqual(exampleRegistry.resources, []);
const packagedProjects = new Projects(path.join(portable, 'Hub'), path.join(portable, 'Hub/.mrmak'));
for (const agent of ['codex', 'claude']) {
  const skills = await packagedProjects.hubSkills(exampleProjects[0].id, agent);
  for (const skill of skills) assert.equal(skill.effective, coreHubSkills.includes(skill.id), 'Only core Hub skills default to On');
  for (const name of gameSkillPack) assert.ok(skills.some(skill => skill.id === name));
}
assert.equal(await readFile(path.join(portable, 'Hub/knowledge/voice-dictation.md'), 'utf8'), await readFile(path.join(root, 'knowledge/voice-dictation.md'), 'utf8'));
const expectedSkills = (await readdir(path.join(root, '.agents/skills'))).sort();
assert.deepEqual((await readdir(path.join(portable, 'Hub/.agents/skills'))).sort(), expectedSkills);
assert.deepEqual((await readdir(path.join(portable, 'Hub/.claude/skills'))).sort(), expectedSkills);
for (const name of gameSkillPack) {
  const source = await readFile(path.join(root, '.agents/skills', name, 'SKILL.md'), 'utf8');
  for (const folder of ['Hub/.agents/skills', 'Hub/.claude/skills', 'runtime/service/skill-pack']) {
    assert.equal(await readFile(path.join(portable, folder, name, 'SKILL.md'), 'utf8'), source);
  }
}
await lstat(path.join(portable, 'runtime/service/skill-pack/LICENSE'));
await lstat(path.join(portable, 'runtime/service/skill-pack/NOTICE.md'));
for (const name of ['hub-skill-defaults.mjs', 'projects.mjs', 'workspace-snapshot.mjs', 'chat-orientation.mjs', 'bridge-mcp.mjs', 'coordinator.mjs']) {
  assert.equal(await readFile(path.join(portable, 'runtime/service', name), 'utf8'), await readFile(path.join(root, 'desktop/service', name), 'utf8'), `Bundled service is stale: ${name}`);
}
const node = path.join(portable, 'runtime/node.exe');
const code = `const pty=require('./service/node_modules/node-pty');const t=pty.spawn(process.execPath,['-e', 'console.log("packaged-runtime-ok")'],{cols:80,rows:24});let data='';t.onData(x=>data+=x);t.onExit(e=>{if(!data.includes('packaged-runtime-ok')||e.exitCode!==0)process.exit(1);console.log('Bundled Node + ConPTY passed');process.exit(0)});setTimeout(()=>{t.kill();process.exit(2)},10000)`;
const result = spawnSync(node, ['-e', code], { cwd: path.join(portable, 'runtime'), encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(result.status, 0, 'Bundled terminal runtime failed its isolated smoke test');
console.log(result.stdout.trim());
console.log('Release checksums and clean portable Hub passed. No native agent/account was started.');
