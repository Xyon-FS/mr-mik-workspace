import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { importFile, dragFiles, moveFile, recyclePath } from '../file-transfers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
async function fixture() {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const repo = await mkdtemp(path.join(root, '.cache', 'file-transfer-test-'));
  await mkdir(path.join(repo, 'inbox'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[]}');
  await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'ui', 'index.html'), '<html>Test UI</html>');
  return repo;
}

test('streaming copies preserve bytes and concurrent duplicate names never overwrite', async () => {
  const repo = await fixture(), folder = path.join(repo, 'inbox');
  for (const name of ['../escape.txt', '..\\escape.txt', '.', '..', 'CON.txt', 'C:secret', 'trailing.', 'trailing ', 'a/b.txt']) {
    await assert.rejects(importFile(Readable.from(['bad']), folder, name), /file name/);
  }
  await assert.rejects(importFile(Readable.from([Buffer.from('123'), Buffer.from('456')]), folder, 'Large.bin', 4), /1 GB/);
  async function* interrupted() { yield Buffer.from('partial'); throw new Error('Transfer interrupted'); }
  await assert.rejects(importFile(interrupted(), folder, 'Interrupted.bin'), /interrupted/);
  assert.deepEqual(await readdir(folder), []);
  await assert.rejects(importFile(Readable.from([]), path.join(repo, 'ui', 'index.html'), 'file.txt'), /folder/);
  assert.deepEqual(await dragFiles([folder]), [await realpath(folder)]);
  await assert.rejects(dragFiles([]), /1 and 100/);
  const original = Buffer.from('Existing file must survive');
  await writeFile(path.join(folder, 'My picture.png'), original);
  const payload = Buffer.from(Array.from({ length: 8193 }, (_, i) => i % 256));
  const files = await Promise.all(Array.from({ length: 3 }, () => importFile(Readable.from([payload.subarray(0, 512), payload.subarray(512)]), folder, 'My picture.png')));
  assert.equal(new Set(files.map(file => file.path)).size, 3);
  assert.deepEqual(await readFile(path.join(folder, 'My picture.png')), original);
  for (const file of files) { assert.deepEqual(await readFile(file.path), payload); assert.equal(file.renamed, true); assert.equal(file.size, payload.length); }
  const empty = await importFile(Readable.from([]), folder, 'Empty.txt');
  assert.equal((await readFile(empty.path)).length, 0);
});

test('file import and native drag use authenticated control and a selected folder', async () => {
  const repo = await fixture(), events = [];
  const service = await createService({ repo, uiDir: path.join(repo, 'ui'), native: event => events.push(event) });
  try {
    const folder = path.join(repo, 'inbox');
    const endpoint = `${service.origin}/api/files/import?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent('A space.txt')}`;
    const headers = { Authorization: `Bearer ${service.token}` };
    assert.equal((await fetch(endpoint, { method: 'POST', body: 'blocked' })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: service.contentOrigin }, body: 'blocked' })).status, 403);
    assert.deepEqual(await readdir(folder), []);
    const response = await fetch(endpoint, { method: 'POST', headers, body: 'Copied from Explorer' });
    assert.equal(response.status, 201);
    const file = await response.json();
    assert.equal(await readFile(file.path, 'utf8'), 'Copied from Explorer');
    const listing = await (await fetch(`${service.origin}/api/files?mode=all&path=${encodeURIComponent(folder)}`, { headers })).json();
    assert.deepEqual(listing.entries.map(entry => entry.name), ['A space.txt']);
    const drag = await fetch(`${service.origin}/api/files/drag`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [file.path] }) });
    assert.equal(drag.status, 200);
    assert.deepEqual(events.at(-1), { type: 'drag-files', window: 'workspace', paths: [await realpath(file.path)] });
    assert.equal(await readFile(file.path, 'utf8'), 'Copied from Explorer');

    const requestId = '00000000-0000-4000-8000-000000000001';
    const pick = (body, authorization = headers) => fetch(`${service.origin}/api/files/pick`, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const count = events.length;
    assert.equal((await pick({ requestId }, {})).status, 401);
    assert.equal((await pick({ requestId }, { ...headers, Origin: service.contentOrigin })).status, 403);
    assert.equal((await pick({ requestId: 'invalid ID' })).status, 400);
    assert.equal(events.length, count);
    assert.equal((await pick({ requestId })).status, 200);
    assert.deepEqual(events.at(-1), { type: 'pick-files', window: 'chats', requestId });

    const source = file.path;
    assert.deepEqual(await moveFile(source, folder), { path: source, moved: false });
    assert.deepEqual(await readdir(folder), ['A space.txt']);
    const destination = path.join(repo, 'workspace');
    const target = path.join(destination, 'A space.txt');
    await writeFile(target, 'Destination bytes');
    await assert.rejects(moveFile(source, destination), /already exists/);
    assert.equal(await readFile(source, 'utf8'), 'Copied from Explorer');
    assert.equal(await readFile(target, 'utf8'), 'Destination bytes');
    const empty = path.join(repo, 'Moved'); await mkdir(empty);
    const result = await moveFile(source, empty);
    assert.equal(result.moved, true);
    assert.equal(await readFile(result.path, 'utf8'), 'Copied from Explorer');
    assert.deepEqual(await readdir(folder), []);
    await assert.rejects(recyclePath(repo, repo), /repository/);
    assert.equal(await recyclePath(result.path, repo), result.path);
  } finally { await service.close(); }
});
