import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from './fixtures.mjs';
import { bundleHtml } from '../html-bundle.mjs';
test('local HTML bundles inline bounded CSS/classic JS/images and reject external or escaping assets', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-html-bundle-')), root = path.join(base, 'project'); await mkdir(root);
  await writeFile(path.join(root, 'style.css'), 'body{color:red}'); await writeFile(path.join(root, 'app.js'), 'document.body.dataset.ready="yes"'); await writeFile(path.join(root, 'image.png'), Buffer.from('synthetic-image')); await writeFile(path.join(base, 'outside.js'), 'private');
  const result = await bundleHtml('<link rel="stylesheet" href="style.css"><script src="app.js"></script><img src="image.png">', root);
  assert.match(result, /<style>body/); assert.match(result, /dataset.ready/); assert.match(result, /data:image\/png;base64/);
  await writeFile(path.join(root, 'literal.js'), 'const pattern="$&";'); assert.match(await bundleHtml('<script src="literal.js"></script>', root), /const pattern="\$&"/);
  assert.match(await bundleHtml('<link href="style.css" rel="stylesheet">', root), /<style>body/);
  await mkdir(path.join(root, '.private')); await writeFile(path.join(root, '.private', 'secret.js'), 'private'); await assert.rejects(bundleHtml('<script src=".private/secret.js"></script>', root), /private configuration/);
  for (const reference of ['../outside.js', 'https://example.test/a.js', '/outside.js']) await assert.rejects(bundleHtml(`<script src="${reference}"></script>`, root));
  await assert.rejects(bundleHtml('<script type="module" src="app.js"></script>', root), /classic JavaScript/);
  await writeFile(path.join(root, 'large.js'), 'x'.repeat(200001)); await assert.rejects(bundleHtml('<script src="large.js"></script>', root), /200 KB/);
});
