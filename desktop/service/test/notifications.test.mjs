import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, createService } from './fixtures.mjs';

test('service routes completion once, honours saved opt-out, and issues scoped card previews', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-notification-test-'));
  await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  await writeFile(path.join(repo, 'ui/index.html'), '<html>Fixture</html>');
  const events = [];
  const service = await createService({ repo, uiDir: path.join(repo, 'ui'), native: event => events.push(event), mcpOptions: { home: path.join(repo, 'native-home'), env: {} } });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const setting = value => fetch(`${service.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ completionNotifications: value }) });
  try {
    const chat = service.sessions.make({ id: 'fixture', agent: 'codex', name: 'Fixture', open: false }); service.sessions.items.set(chat.id, chat);
    const finish = id => { service.sessions.nativeEvent(chat, { kind: 'turn-started' }); service.sessions.nativeEvent(chat, { kind: 'turn-completed', id }); };
    finish('first'); service.sessions.nativeEvent(chat, { kind: 'turn-completed', id: 'first' });
    assert.equal(events.filter(event => event.type === 'completion-notification').length, 1);
    assert.equal((await setting(false)).status, 200); finish('second');
    assert.equal(events.filter(event => event.type === 'completion-notification').length, 1);
    assert.equal(JSON.parse(await readFile(path.join(repo, '.mrmak/settings.json'), 'utf8')).completionNotifications, false);
    assert.notEqual((await setting('false')).status, 200);
    assert.equal((await setting(true)).status, 200); finish('third');
    assert.equal(events.filter(event => event.type === 'completion-notification').length, 2);
    await mkdir(path.join(repo, 'workspace/_shared'), { recursive: true });
    const card = await service.projects.createCard({ title: 'Preview fixture' });
    const token = service.bridge.issue(chat.id, null, card.id);
    const destination = await service.bridge.call(token, 'mrmak_hub_destination', { kind: 'card', title: 'Page' });
    assert.equal(destination.previewUrl, undefined);
    await writeFile(destination.path, '<html><body><h1>Native card preview</h1></body></html>');
    const registered = await service.bridge.call(token, 'mrmak_register_hub_file', { destinationId: destination.destinationId });
    assert.match(registered.previewUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.match(await (await fetch(registered.previewUrl)).text(), /Native card preview/);
    const resolved = await service.bridge.call(token, 'mrmak_hub_destination', { kind: 'card', path: registered.path });
    assert.equal(resolved.previewUrl, registered.previewUrl);
    const cardDir = path.dirname(destination.path);
    const prefix = registered.previewUrl.slice(0, registered.previewUrl.indexOf('/workspace/'));
    const relative = path.relative(repo, cardDir).split(path.sep).join('/');
    const files = [
      [relative + '/asset.txt', 200],
      ['workspace/_shared/style.css', 200],
      ['workspace/sibling/page.html', 403],
      ['context/fixture.md', 403],
      [relative + '/auth.json', 403],
    ];
    for (const [name, status] of files) {
      const file = path.join(repo, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'Synthetic preview asset');
      assert.equal((await fetch(prefix + '/' + name)).status, status);
    }
    const plan = { kind: 'card', folder: cardDir, file: destination.path };
    assert.deepEqual(await service.files.cardPreview({ ...plan, file: path.join(cardDir, 'missing.html') }), {});
    assert.deepEqual(await service.files.cardPreview({ ...plan, kind: 'context' }), {});
    await assert.rejects(service.files.cardPreview({ ...plan, file: path.join(repo, 'workspace/sibling/page.html') }));
  } finally { await service.close(); }
});
