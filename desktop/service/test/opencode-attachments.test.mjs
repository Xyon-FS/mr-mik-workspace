import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { reviewAttachments, embedAttachments, attachmentSlots } from '../opencode-attachments.mjs';
import { validateV2Transfer } from '../opencode-v2-transfer.mjs';

function v2Fixture(uri) {
  return { format: 'opencode-v2', info: { id: 'ses_media', location: { directory: '/fixture' }, time: { created: 1, updated: 2 } }, messages: [
    { id: 'msg_user', type: 'user', text: 'Fixture', time: { created: 1 }, files: [{ mime: 'image/png', name: 'original.png', data: 'AQIDBA==', source: { type: 'uri', uri: 'file:///missing-original.png' } }] },
    { id: 'msg_answer', type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'tool', name: 'fixture', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'Fixture' }, { type: 'file', mime: 'image/png', uri }] } }] },
  ] };
}

test('V2 keeps historical prompt bytes and explicitly reviews external tool files without mutating native content', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-media-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'tool.png'); await writeFile(file, Buffer.from([5, 6, 7]));
  const data = v2Fixture(pathToFileURL(file).href), before = JSON.stringify(data);
  assert.throws(() => validateV2Transfer(data), /provenance/);
  validateV2Transfer(data, data.info.id, { portable: false });
  const approved = await reviewAttachments([data]); assert.equal(approved.length, 1); assert.equal(approved[0].bytes, 3);
  await assert.rejects(embedAttachments(data, []), /not approved/);
  const result = await embedAttachments(data, approved); validateV2Transfer(result);
  assert.equal(result.messages[0].files[0].data, 'AQIDBA==');
  assert.deepEqual(result.messages[0].files[0].source, { type: 'inline' });
  assert.equal(result.messages[1].content[0].state.content[1].uri, 'data:image/png;base64,BQYH');
  assert.equal(JSON.stringify(data), before); assert.deepEqual(await reviewAttachments([result]), []);
  await writeFile(file, 'changed'); await assert.rejects(embedAttachments(data, approved), /changed/);
});

test('V2 rejects unsafe external tool locations, malformed media and unknown content', async () => {
  for (const uri of ['https://example.test/file.png', 'file://server/share/a.png', 'relative.png', 'file:///fixture/.env']) await assert.rejects(reviewAttachments([v2Fixture(uri)]), /unsupported|private|Only local/i);
  const data = v2Fixture('data:image/png;base64,AQIDBA==');
  data.messages[0].files[0].data = 'malformed!'; assert.throws(() => validateV2Transfer(data), /attachment/);
  const tool = v2Fixture('data:image/png;base64,bad!'); assert.throws(() => validateV2Transfer(tool, tool.info.id, { portable: false }), /embedded/);
  tool.messages[1].content[0].state.content[1].type = 'unknown'; assert.throws(() => validateV2Transfer(tool, tool.info.id, { portable: false }), /attachment/);
});

function fixture(url) {
  const member = id => ({ info: { id }, messages: [{ parts: [{ type: 'file', mime: 'image/png', filename: 'sample.png', url }, { type: 'tool', state: { attachments: [{ mime: 'image/png', url }] } }] }] });
  const root = member('ses_root'); root.children = [{ ...member('ses_child'), info: { id: 'ses_child', parentID: 'ses_root' } }]; return root;
}
test('attachment review covers file/tool parts and children, deduplicates paths, embeds only approved bytes and leaves originals intact', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-attachments-')), file = path.join(folder, 'sample.png'), bytes = Buffer.from([1, 2, 3, 4]);
  await writeFile(file, bytes);
  const data = fixture(pathToFileURL(file).href), before = JSON.stringify(data), files = await reviewAttachments([data]);
  assert.equal(files.length, 1); assert.equal(files[0].bytes, 4);
  await assert.rejects(embedAttachments(data, []), /not approved/);
  const embedded = await embedAttachments(data, files);
  assert.equal(attachmentSlots(embedded).length, 4);
  for (const slot of attachmentSlots(embedded)) assert.equal(slot.url, 'data:image/png;base64,AQIDBA==');
  assert.equal(JSON.stringify(data), before); assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await reviewAttachments([embedded]), []);
  await writeFile(file, 'changed'); await assert.rejects(embedAttachments(data, files), /changed/);
});
test('attachment review refuses remote URLs, credentials, missing files, directories, oversized files and parent junctions', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-attachments-security-'));
  for (const url of ['https://example.test/file.png', 'file://server/share/a.png', 'relative.png', pathToFileURL(path.join(folder, '.env')).href, pathToFileURL(path.join(folder, '.codex/auth.json')).href]) await assert.rejects(reviewAttachments([fixture(url)]), /unsupported|private|Only local/i);
  await assert.rejects(reviewAttachments([fixture(pathToFileURL(path.join(folder, 'missing.png')).href)]));
  await assert.rejects(reviewAttachments([fixture(pathToFileURL(folder).href)]), /regular/);
  const big = path.join(folder, 'large.png'); await writeFile(big, Buffer.alloc(16 * 1024 ** 2 + 1));
  await assert.rejects(reviewAttachments([fixture(pathToFileURL(big).href)]), /16 MB/);
  const actual = path.join(folder, 'actual'); await mkdir(actual); await writeFile(path.join(actual, 'sample.png'), 'fixture');
  const linked = path.join(folder, 'linked'); await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(reviewAttachments([fixture(pathToFileURL(path.join(linked, 'sample.png')).href)]), /Linked/);
});

test('repeated references cannot expand embedded native JSON beyond the family limit', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-attachments-size-')), file = path.join(folder, 'image.png');
  await writeFile(file, Buffer.alloc(13 * 1024 ** 2));
  const data = fixture(pathToFileURL(file).href), approved = await reviewAttachments([data]);
  assert.equal(approved.length, 1);
  await assert.rejects(embedAttachments(data, approved), /64 MB/);
});
