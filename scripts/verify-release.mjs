import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { mkdtemp, cleanupFixtures } from '../desktop/service/test/fixtures.mjs';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameSkillPack } from '../desktop/service/skill-pack.mjs';
import { exampleKey, exampleCards } from '../desktop/service/example-workspace.mjs';
import { Projects } from '../desktop/service/projects.mjs';
import { coreHubSkills } from '../desktop/service/hub-skill-defaults.mjs';
import { portableLauncher } from './portable-layout.mjs';
import { graphicalCodexBinary, graphicalCodexVersion } from '../desktop/service/codex-chat-binary.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const suffix = process.env.MRMIK_RELEASE_SUFFIX || '';
if (suffix && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(suffix)) throw new Error('Invalid development release suffix.');
const release = path.join(root, 'release', suffix ? `${version}-${suffix}` : version), portable = path.join(release, 'Mr-Mik-portable');
assert.ok(!(await readdir(path.join(portable, 'App/runtime/service'))).includes('test-live.mjs'), 'The runtime contains the developer live API diagnostic');
assert.equal(JSON.parse(await readFile(path.join(portable, 'App/runtime/service/app-version.json'), 'utf8')).version, version, 'Bundled app version is stale');
assert.equal(await readFile(path.join(portable, 'Start Mr. Mik.cmd'), 'utf8'), portableLauncher);
await lstat(path.join(portable, 'App/mrmak-workspace.exe'));
const nativeBuild = path.join(process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri/target'), 'release/mrmak-workspace.exe');
if (await lstat(nativeBuild).catch(() => null)) assert.deepEqual(await readFile(path.join(portable, 'App/mrmak-workspace.exe')), await readFile(nativeBuild), 'Packaged native host is stale');
for (const name of ['AGENTS.md', 'CLAUDE.md']) {
  const expected = await readFile(path.join(root, 'templates/hub', name), 'utf8');
  for (const hub of ['MyHub', 'App/runtime/hub-template']) assert.equal(await readFile(path.join(portable, hub, name), 'utf8'), expected, 'Packaged Hub instructions must use the dedicated user template');
}
for (const line of (await readFile(path.join(release, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')) {
  const [expected, name] = line.split(/\s{2}/); const digest = createHash('sha256');
  for await (const chunk of createReadStream(path.join(release, name))) digest.update(chunk);
  assert.equal(digest.digest('hex'), expected, 'Release checksum mismatch');
}
for (const file of ['.mrmak', '.codex', '.env', '.claude/settings.local.json', 'projects/skill-scopes.json']) assert.equal(await lstat(path.join(portable, 'MyHub', file)).catch(() => null), null);
const exampleRegistry = JSON.parse(await readFile(path.join(portable, 'MyHub/workspace/workspace.json'), 'utf8'));
const exampleProjects = JSON.parse(await readFile(path.join(portable, 'MyHub/projects/registry.json'), 'utf8')).projects;
assert.equal(exampleProjects.length, 1); assert.equal(exampleProjects[0].exampleKey, exampleKey); assert.deepEqual(exampleProjects[0].repositories, []);
assert.deepEqual(exampleRegistry.entities.map(card => card.title), exampleCards.map(card => card.title));
assert.ok(exampleRegistry.entities.every(card => card.sample && card.projectId === exampleProjects[0].id && card.repositoryId === null));
assert.deepEqual(exampleRegistry.resources, []);
const packagedProjects = new Projects(path.join(portable, 'MyHub'), path.join(portable, 'MyHub/.mrmak'));
for (const agent of ['codex', 'claude', 'opencode']) {
  const skills = await packagedProjects.hubSkills(exampleProjects[0].id, agent);
  for (const skill of skills) assert.equal(skill.effective, coreHubSkills.includes(skill.id), 'Only core Hub skills default to On for Codex, Claude and OpenCode');
  for (const name of gameSkillPack) assert.ok(skills.some(skill => skill.id === name));
}
assert.equal(await readFile(path.join(portable, 'MyHub/knowledge/voice-dictation.md'), 'utf8'), await readFile(path.join(root, 'knowledge/voice-dictation.md'), 'utf8'));
const expectedSkills = (await readdir(path.join(root, '.agents/skills'))).sort();
assert.deepEqual((await readdir(path.join(portable, 'MyHub/.agents/skills'))).sort(), expectedSkills);
assert.deepEqual((await readdir(path.join(portable, 'MyHub/.claude/skills'))).sort(), expectedSkills);
for (const name of gameSkillPack) {
  const source = await readFile(path.join(root, '.agents/skills', name, 'SKILL.md'), 'utf8');
  for (const folder of ['MyHub/.agents/skills', 'MyHub/.claude/skills', 'App/runtime/service/skill-pack']) {
    assert.equal(await readFile(path.join(portable, folder, name, 'SKILL.md'), 'utf8'), source);
  }
}
await lstat(path.join(portable, 'App/runtime/service/skill-pack/LICENSE'));
await lstat(path.join(portable, 'App/runtime/service/skill-pack/NOTICE.md'));
for (const name of ['main.mjs', 'claude-profiles.mjs', 'account-profiles.mjs', 'native-events.mjs', 'native-delete.mjs', 'conversation-lease.mjs', 'claude-subagents.mjs', 'claude-changes.mjs', 'codex-chat-operations.mjs', 'account-limits.mjs', 'account-limit-probes.mjs', 'shared-browser.mjs', 'shared-browser-entry.mjs', 'model-picker.mjs', 'claude-model-picker.mjs', 'claude-chat-steering.mjs', 'claude-chat-queue.mjs', 'workspace-mcps.mjs', 'workspace-mcp-host.mjs', 'claude-mcp-editor.mjs', 'tool-refresh.mjs', 'agents.mjs', 'codex-chat.mjs', 'claude-usage.mjs', 'native-controls.mjs', 'claude-composer.mjs', 'portable-contract.mjs', 'opencode/tui-controls.mjs', 'opencode/v2-tui-controls.mjs', 'claude-history-projection.mjs', 'claude-history-search.mjs', 'claude-portable-state.mjs', 'claude-history-worker.mjs', 'claude-history.mjs', 'claude-message-actions.mjs', 'provider-message-receipts.mjs', 'opencode-message-actions.mjs', 'claude-chat-attachments.mjs', 'claude-chat-settings.mjs', 'claude-chat.mjs', 'claude-chat-protocol.mjs', 'claude-chat-transport.mjs', 'graphical-capabilities.mjs', 'accounts.mjs', 'sessions.mjs', 'server.mjs', 'chat-card-output.mjs', 'chat-block-preview.mjs', 'chat-results.mjs', 'chat-html-output.mjs', 'claude-platform-mcps.mjs', 'html-bundle.mjs', 'interactive-preview.mjs', 'session-location.mjs', 'hub-skill-defaults.mjs', 'projects.mjs', 'workspace-snapshot.mjs', 'chat-orientation.mjs', 'bridge-mcp.mjs', 'coordinator.mjs', 'opencode.mjs', 'opencode-v2-session.mjs', 'opencode-v2-skills.mjs', 'opencode-v2-transfer.mjs', 'opencode-config-view.mjs', 'native-refresh-snapshot.mjs', 'opencode-settings.mjs', 'opencode-picker.mjs', 'opencode-transfer.mjs', 'opencode-attachments.mjs', 'native-delete.mjs', 'portable-archive.mjs', 'worker-controls.mjs']) {
  assert.equal(await readFile(path.join(portable, 'App/runtime/service', name), 'utf8'), await readFile(path.join(root, 'desktop/service', name), 'utf8'), `Bundled service is stale: ${name}`);
}
for (const name of await readdir(path.join(root, 'desktop/service/opencode'))) {
  if (!(await lstat(path.join(root, 'desktop/service/opencode', name))).isFile()) continue;
  assert.deepEqual(await readFile(path.join(portable, 'App/runtime/service/opencode', name)), await readFile(path.join(root, 'desktop/service/opencode', name)), `Bundled OpenCode plugin is stale: ${name}`);
}
for (const name of ['package.json', 'index.mjs', 'tui.mjs']) {
  assert.deepEqual(await readFile(path.join(portable, 'App/runtime/service/opencode/v2', name)), await readFile(path.join(root, 'desktop/service/opencode/v2', name)), `Bundled V2 entrypoint is stale: ${name}`);
}
const sqlite = spawnSync(path.join(portable, 'App/runtime/node.exe'), ['--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE smoke (id TEXT)'); db.close();"], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert.equal(sqlite.status, 0, 'Bundled Node lacks the SQLite runtime required for OpenCode transfer');
const node = path.join(portable, 'App/runtime/node.exe');
const chatBinary = graphicalCodexBinary({ packageRoot: path.join(portable, 'App/runtime/service/node_modules/@openai/codex-win32-x64') });
assert.equal(chatBinary.version, graphicalCodexVersion);
assert.equal(await readFile(path.join(portable, 'App/runtime/CODEX-APACHE-2.0.txt'), 'utf8'), await readFile(path.join(root, 'desktop/licenses/CODEX-APACHE-2.0.txt'), 'utf8'));
assert.equal(await readFile(path.join(portable, 'App/runtime/UI-DEPENDENCIES.txt'), 'utf8'), await readFile(path.join(root, 'desktop/licenses/UI-DEPENDENCIES.txt'), 'utf8'));
assert.equal(await readFile(path.join(portable, 'App/runtime/service/graphical-sync.mjs'), 'utf8'), await readFile(path.join(root, 'desktop/service/graphical-sync.mjs'), 'utf8'));
assert.equal(await readFile(path.join(portable, 'App/runtime/service/create-hub.mjs'), 'utf8'), await readFile(path.join(root, 'desktop/service/create-hub.mjs'), 'utf8'));
const onboarding = await mkdtemp(path.join(os.tmpdir(), 'mik-release-onboarding-'));
try {
  const destination = path.join(onboarding, 'MyHub');
  const args = [path.join(portable, 'App/runtime/service/create-hub.mjs'), path.join(portable, 'App/runtime/hub-template'), destination];
  const created = spawnSync(node, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(created.status, 0, `Bundled Hub creation failed: ${created.stderr}`);
  const contents = await readFile(path.join(destination, 'workspace/workspace.json'), 'utf8');
  assert.equal(JSON.parse(contents).entities.length, 4);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'projects/skill-defaults.json'), 'utf8')), JSON.parse(await readFile(path.join(portable, 'MyHub/projects/skill-defaults.json'), 'utf8')));
  const repeated = spawnSync(node, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(repeated.status, 1); assert.match(repeated.stderr, /already exists/);
  const reused = spawnSync(node, [...args, '--reuse-existing'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(reused.status, 0, `Bundled existing Hub reuse failed: ${reused.stderr}`);
  assert.equal(await readFile(path.join(destination, 'workspace/workspace.json'), 'utf8'), contents);
} finally { await cleanupFixtures(); }
const code = `const pty=require('./service/node_modules/node-pty');const t=pty.spawn(process.execPath,['-e', 'console.log("packaged-runtime-ok")'],{cols:80,rows:24});let data='';t.onData(x=>data+=x);t.onExit(e=>{if(!data.includes('packaged-runtime-ok')||e.exitCode!==0)process.exit(1);console.log('Bundled Node + ConPTY passed');process.exit(0)});setTimeout(()=>{t.kill();process.exit(2)},10000)`;
const result = spawnSync(node, ['-e', code], { cwd: path.join(portable, 'App/runtime'), encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(result.status, 0, 'Bundled terminal runtime failed its isolated smoke test');
console.log(result.stdout.trim());
console.log('Release checksums and clean portable Hub passed. No native agent/account was started.');
