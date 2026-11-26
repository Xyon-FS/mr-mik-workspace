import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeHistoryWindow} from '../../../src/desktop/graphicalHistoryWindow.ts';
const rows=(...ids)=>ids.map(id=>({id}));
const ids=values=>values.map(item=>item.id);
test('overlapping live pages replace stale content and retain older messages in native order', () => {
  const before = rows('older', 'question', 'old-thought', 'operation', 'answer');
  const answer = { id: 'answer', text: 'Updated response' };
  const incoming = [...rows('question', 'commentary', 'operation', 'image'), answer];
  const merged = mergeHistoryWindow(before, incoming);
  assert.deepEqual(ids(merged), ['older', 'question', 'commentary', 'operation', 'image', 'answer']);
  assert.equal(merged.at(-1), answer);
  assert.equal(mergeHistoryWindow(merged, incoming), merged);
  assert.deepEqual(ids(mergeHistoryWindow(rows('older-page'), rows('live-page'))), ['older-page', 'live-page']);
});
