import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, unlink, symlink } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Projects } from '../projects.mjs';
import { WorkspaceBridge } from '../workspace-bridge.mjs';
import { CardContentSync } from '../card-content-sync.mjs';

async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-card-sync-'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const stateDir = path.join(repo, '.mrmak'), projects = new Projects(repo, stateDir);
  const registry = async () => JSON.parse(await readFile(projects.workspacePath, 'utf8'));
  const card = await projects.createCard({ title: 'Sync fixture' });
  const events = [], sync = new CardContentSync({ repo, stateDir, registry, projects, changed: pages => events.push(pages), interval: 1000000, settle: 0 });
  const bridge = new WorkspaceBridge(projects, {}, registry, { cardContent: sync });
  const token = bridge.issue('fixture', null, card.id);
  const target = await bridge.call(token, 'mrmak_hub_destination', { kind: 'card', title: 'Page' });
  await writeFile(target.path, '<html>Initial</html>');
  await bridge.call(token, 'mrmak_register_hub_file', { destinationId: target.destinationId });
  await sync.start();
  return { repo, stateDir, projects, registry, card, sync, bridge, token, target, events };
}

test('registered pages synchronize once per stable edit, including after transfer and late registration', async () => {
  const f = await fixture(); let next;
  try {
    const overview = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card' });
    const page = overview.pages[0]; assert.equal(page.autoSync, true); assert.ok(page.destinationId);
    const resolved = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card', path: page.relativePath, knownRevision: page.revision });
    assert.equal(resolved.destinationId, page.destinationId); assert.equal(resolved.unchanged, true);
    await writeFile(f.target.path, '<html>Changed</html>'); await f.sync.scan(); assert.equal(f.events.length, 0);
    await f.sync.scan(); assert.equal(f.events.length, 1); assert.equal(f.events[0][0].status, 'ready');
    await f.sync.scan(); assert.equal(f.events.length, 1);
    await writeFile(path.join(path.dirname(f.target.path), 'unregistered.html'), '<html>Not a page</html>');
    await f.sync.scan(); assert.equal((await f.registry()).entities[0].steps.length, 1);
    const changed = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card', path: page.relativePath, knownRevision: page.revision });
    assert.equal(changed.unchanged, false);
    await f.sync.pause();
    await writeFile(f.target.path, '<html>Transferred content</html>');
    await f.sync.scan(); await f.sync.scan();
    assert.equal(f.events.length, 1);
    f.sync.resume();
    await f.sync.scan(); await f.sync.scan();
    assert.equal(f.events.length, 2);

    const target = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card', title: 'Late page' });
    await writeFile(target.path, '<html>Before preview</html>');
    await f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: target.destinationId });
    await writeFile(target.path, '<html>Changed before first scan</html>');
    await f.sync.scan(); assert.equal(f.events.length, 2);
    await f.sync.scan(); assert.equal(f.events.length, 3);
    assert.equal(f.events.at(-1)[0].page, path.basename(target.path));
    assert.equal(f.events.at(-1)[0].status, 'ready');
    await writeFile(target.path, 'Partial HTML'); await f.sync.scan(); await f.sync.scan();
    assert.equal(f.events.at(-1)[0].status, 'invalid');
    await unlink(target.path); await f.sync.scan(); await f.sync.scan();
    assert.equal(f.events.at(-1)[0].status, 'missing'); assert.equal((await f.registry()).entities[0].steps.length, 2);
    await writeFile(target.path, '<html>Restored</html>');
    await f.projects.editWorkspace(current => { current.entities[0].steps = current.entities[0].steps.filter(step => step.path !== path.basename(target.path)); });
    await f.sync.scan(); assert.equal(f.sync.records.size, 1);
    await assert.rejects(f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: target.destinationId }), /association changed/);
    assert.equal((await f.registry()).entities[0].steps.length, 1);
    await f.sync.close(); await writeFile(f.target.path, '<html>Offline change</html>');
    const events = [];
    next = new CardContentSync({ repo: f.repo, stateDir: f.stateDir, projects: f.projects, registry: f.registry, settle: 0, interval: 1000000, changed: pages => events.push(pages) });
    await next.start(); await next.scan(); assert.equal(events.length, 1); assert.equal(events[0][0].status, 'ready');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'mik-card-sync-outside-'));
    const secret = path.join(outside, 'outside.html'); await writeFile(secret, '<html>Outside</html>');
    await unlink(f.target.path);
    // A directory junction is available without Windows symlink privileges.
    const folder = path.join(path.dirname(f.target.path), 'escape'); await symlink(outside, folder, 'junction');
    await f.projects.editWorkspace(current => { current.entities[0].steps = [{ name: 'Escape', path: 'escape/outside.html' }]; });
    await next.scan(); assert.equal(next.state(f.card.id, 'escape/outside.html').status, 'invalid');
    assert.equal(await readFile(secret, 'utf8'), '<html>Outside</html>');
  } finally { await f.sync.close(); await next?.close(); f.bridge.close(); }
});
