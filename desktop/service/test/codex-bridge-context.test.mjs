import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Projects } from '../projects.mjs';
import { Workspace } from '../workspace.mjs';
import { WorkspaceBridge } from '../workspace-bridge.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-codex-bridge-context-')), repo = path.join(root, 'hub'), external = path.join(root, 'external');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(external);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  const project = await projects.save({ name: 'Synthetic workspace', repositoryPath: external });
  const card = await projects.createCard({ projectId: project.id, title: 'Synthetic card', repositoryId: project.repositories[0].id });
  const bridge = new WorkspaceBridge(projects, new Workspace(repo), async () => JSON.parse(await readFile(projects.workspacePath, 'utf8')));
  return { projects, project, card, bridge };
}

test('Codex startup context preserves exact Hub/card/linked-project data without resolving provider tool settings', async () => {
  const { bridge, project, card } = await fixture();
  for (const scope of [null, project.id]) {
    const token = bridge.issue('synthetic-codex', scope, scope ? card.id : null, scope ? project.repositories[0].id : null, 'codex');
    const expected = await bridge.call(token, 'mrmak_chat_context');
    bridge.services.codexForGrant = async () => { throw new Error('Provider tools must not be loaded to read Codex Hub context'); };
    assert.deepEqual(await bridge.call(token, 'mrmak_chat_context'), expected);
    delete bridge.services.codexForGrant;
  }
  let providerReads = 0;
  bridge.services.codexForGrant = async () => { providerReads++; return {}; };
  const token = bridge.issue('synthetic-codex', project.id, null, project.repositories[0].id, 'codex');
  await assert.rejects(bridge.call(token, 'mrmak_chat_context', { unexpected: true }), /Unsupported Bridge operation/);
  bridge.revoke('synthetic-codex'); await assert.rejects(bridge.call(token, 'mrmak_chat_context'), /Bridge access expired/);
  const absent = bridge.issue('missing-project', 'missing', null, null, 'codex');
  await assert.rejects(bridge.call(absent, 'mrmak_chat_context'));
  assert.equal(providerReads, 0);
});
