import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export function partialTransferCases(label, hub, data) {
  test(`${label}: exclude unavailable roots/families explicitly while healthy chats remain importable`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-partial-'));
    const source = await hub(root, 'source'), target = await hub(root, 'target'), alternate = await hub(root, 'alternate');
    try {
      const original = data(), firstId = original.info.id, secondId = 'ses_anotherhealthy', missingId = 'ses_missingcontext';
      const second = JSON.parse(JSON.stringify(original).replaceAll(firstId, secondId).replaceAll('msg_', 'msg_second_').replaceAll('prt_', 'prt_second_'));
      source.store.set(firstId, original); source.store.set(secondId, second);
      for (const [nativeId, name] of [[firstId, 'First healthy'], [secondId, 'Second healthy'], [missingId, 'Missing family']]) {
        const id = randomUUID(); source.sessions.items.set(id, source.sessions.make({ id, agent: 'opencode', nativeId, name, cwd: source.repo, hasConversation: true, open: false }));
      }
      let review = await source.archive.reviewExport(root); assert.equal(review.issues.length, 1);
      await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token }), /explicitly confirm/);
      review = await source.archive.reviewExport(root);
      const archive = await source.archive.exportTo(root, { attachmentToken: review.token, skipNative: review.issues.map(item => item.key) });
      assert.equal(archive.chats, 2); assert.equal(archive.omitted, 1);
      const plan = await target.archive.preview(archive.path); assert.equal(plan.native.filter(item => item.status === 'new').length, 2);
      await assert.rejects(target.archive.importFrom(archive.path), /explicitly confirm/);
      const result = await target.archive.importFrom(archive.path, { reviewHash: plan.reviewHash, skipNative: plan.native.filter(item => item.status === 'unavailable').map(item => item.key) });
      assert.equal(result.nativeImported, 2); assert.equal(result.nativeUnavailable, 1);
      assert.equal(target.store.size, 2); assert.ok(target.sessions.list().find(item => item.nativeId === missingId).nativeUnavailable);
      const entries = unzipSync(await readFile(archive.path)), manifest = JSON.parse(strFromU8(entries['manifest.json']));
      const broken = manifest.native.find(item => item.id === firstId); entries[broken.name] = strToU8('{}');
      const declaration = manifest.files.find(item => item.name === broken.name); declaration.size = entries[broken.name].length; declaration.sha256 = createHash('sha256').update(entries[broken.name]).digest('hex'); broken.sha256 = declaration.sha256;
      entries['manifest.json'] = strToU8(JSON.stringify(manifest)); const damaged = path.join(root, 'isolated-invalid-chat.mrmak.zip'); await writeFile(damaged, zipSync(entries));
      const partial = await alternate.archive.preview(damaged); assert.equal(partial.native.filter(item => item.status === 'unavailable').length, 2);
      const partialResult = await alternate.archive.importFrom(damaged, { reviewHash: partial.reviewHash, skipNative: partial.native.filter(item => item.status === 'unavailable').map(item => item.key) });
      assert.equal(partialResult.nativeImported, 1); assert.equal(alternate.store.size, 1); assert.ok(alternate.store.has(secondId)); assert.ok(!alternate.store.has(firstId));
      assert.ok(alternate.sessions.list().find(item => item.nativeId === firstId).nativeUnavailable);
    } finally { await source.sessions.close(); await target.sessions.close(); await alternate.sessions.close(); }
  });
}
