import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../../../src/desktop/graphicalDiff.ts';

test('diff highlighting preserves headers, literal prefixes, context and malformed text', () => {
  const text = '--- a/source\n+++ b/source\n@@ -1,2 +1,2 @@\n context\n--- old text\n\\ No newline at end of file\n+++ new text\n--- a/other\n+++ b/other\n@@ -0,0 +1 @@\n+first';
  const lines = diffLines(text);
  assert.deepEqual(lines.map(value => value.kind), [undefined, undefined, 'hunk', undefined, 'removed', undefined, 'added', undefined, undefined, 'hunk', 'added']);
  assert.equal(lines.map(value => value.line).join('\n'), text);
  assert.deepEqual(diffLines('+added\n-removed\nplain <script>').map(value => value.kind), ['added', 'removed', undefined]);
  assert.doesNotThrow(() => diffLines('@@ invalid @@\n+++ header\n\n'));
});
