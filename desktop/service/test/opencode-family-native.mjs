// Native family acceptance: isolated profiles, no provider, account or real chat.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { reviewAttachments, embedAttachments, attachmentSlots } from '../opencode-attachments.mjs';
import { OpenCodeTransfer, openCodeHash, openCodeRelation, openCodeMembers } from '../opencode-transfer.mjs';

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-oc-family-native-')));
const profiles = [];
for (const name of ['pc1', 'pc2']) {
  const cwd = path.join(base, name); await mkdir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) { env[key] = path.join(cwd, key); await mkdir(env[key]); }
  profiles.push(new OpenCodeTransfer(cwd, { env, binary: { file: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe', args: [] } }));
}
const [source, target] = profiles, rootId = 'ses_familyfixture';
function member(suffix, parentID) {
  const id = suffix === 'root' ? rootId : `ses_family${suffix}`;
  return { info: { id, parentID, projectID: 'global', directory: source.repo, slug: suffix, title: `Offline ${suffix}`, version: '1.18.34', time: { created: 1, updated: 1 } }, messages: [{ info: { id: `msg_family${suffix}`, sessionID: id, role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'fixture', modelID: 'unused' } }, parts: [{ id: `prt_family${suffix}`, sessionID: id, messageID: `msg_family${suffix}`, type: 'text', text: `Offline ${suffix}` }] }] };
}
const members = [member('root'), member('child', rootId), member('grandchild', 'ses_familychild')];
for (const data of members) { const file = path.join(base, data.info.id + '.json'); await writeFile(file, JSON.stringify(data)); await source.command(['import', file]); }
console.log('Native source family seeded.');
const original = await source.read(rootId); assert.equal(openCodeMembers(original).length, 3);
await assert.rejects(source.read('ses_familychild'), /main OpenCode conversation/);
await target.write(original, target.repo, null);
const imported = await target.read(rootId); assert.equal(openCodeRelation(imported, original), 'identical');
assert.deepEqual(openCodeMembers(imported).map(member => member.info.parentID), [undefined, rootId, 'ses_familychild']);
assert.ok(openCodeMembers(imported).every(member => member.info.directory === target.repo));
console.log('Native parent/child/grandchild import and relinking passed.');
const config = path.join(target.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'); await mkdir(path.dirname(config), { recursive: true }); await writeFile(config, '{"permission":"ask"}');
const next = structuredClone(original), child = next.children[0], extra = structuredClone(child.messages[0]);
extra.info.id = 'msg_familycontinuation'; extra.info.time.created = 2; extra.parts[0].id = 'prt_familycontinuation'; extra.parts[0].messageID = extra.info.id; extra.parts[0].text = 'New child turn'; child.messages.push(extra);
await source.write(next, source.repo, openCodeHash(original));
const extended = await source.read(rootId); assert.equal(openCodeRelation(imported, extended), 'update');
await target.write(extended, target.repo, openCodeHash(imported));
assert.equal(openCodeRelation(await target.read(rootId), extended), 'identical');
console.log('Child-only continuation update passed.');
const divergent = structuredClone(extended); divergent.children[1].messages[0].parts[0].text = 'Divergent grandchild';
const before = openCodeHash(await target.read(rootId));
await assert.rejects(target.write(divergent, target.repo, before), /cannot replace divergent/);
assert.equal(openCodeHash(await target.read(rootId)), before);
const unrelated = member('unrelated'); delete unrelated.info.parentID;
const file = path.join(base, 'unrelated.json'); await writeFile(file, JSON.stringify(unrelated)); await target.command(['import', file]);
const inspection = await target.database();
try { assert.throws(() => inspection.prepare('DELETE FROM session WHERE id = ?').run(unrelated.info.id), /readonly|read.only/i); } finally { inspection.close(); }
await target.remove(rootId, before);
assert.equal(await target.read(rootId), null); assert.ok(await target.read(unrelated.info.id));
const check = await target.database();
try { for (const member of members) assert.equal(check.prepare('SELECT id FROM session WHERE id = ?').get(member.info.id), undefined); } finally { check.close(); }
assert.equal(await readFile(config, 'utf8'), '{"permission":"ask"}');
const image = path.join(base, 'attachment.png'); await writeFile(image, Buffer.from([1, 2, 3, 4]));
const media = member('media'), owner = media.messages[0];
owner.parts.push({ id: 'prt_mediainput', sessionID: media.info.id, messageID: owner.info.id, type: 'file', mime: 'image/png', filename: 'attachment.png', url: pathToFileURL(image).href });
owner.parts.push({ id: 'prt_mediaoutput', sessionID: media.info.id, messageID: owner.info.id, type: 'tool', tool: 'fixture', callID: 'offline', state: { status: 'completed', input: {}, output: 'Offline fixture', title: 'Fixture', metadata: {}, time: { start: 1, end: 2 }, attachments: [{ id: 'prt_mediatoolfile', sessionID: media.info.id, messageID: owner.info.id, type: 'file', mime: 'image/png', filename: 'attachment.png', url: pathToFileURL(image).href }] } });
const mediaFile = path.join(base, 'media.json'); await writeFile(mediaFile, JSON.stringify(media)); await source.command(['import', mediaFile]);
const external = await source.read(media.info.id), review = await reviewAttachments([external]), embedded = await embedAttachments(external, review);
await target.write(embedded, target.repo, null);
const restored = await target.read(media.info.id);
assert.equal(openCodeRelation(restored, embedded), 'identical');
assert.ok(attachmentSlots(restored).every(slot => slot.url === 'data:image/png;base64,AQIDBA=='));
assert.ok(attachmentSlots(await source.read(media.info.id)).every(slot => slot.url.startsWith('file:')));
assert.deepEqual(await readFile(image), Buffer.from([1, 2, 3, 4]));
console.log('PASS: native family transfer/deletion and approved file/tool media round-trip; unrelated chats, source media and config intact. No account or provider calls.');
