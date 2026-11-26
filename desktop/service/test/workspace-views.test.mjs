import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceViews } from '../../../src/desktop/workspaceViewStore.ts';
const view = id => ({ id, title: id, type: 'browser', sessionId: id });
test('Workspace preserves pinned and pending views while bounding tabs and navigation history', () => {
  const views = createWorkspaceViews(); views.open(view('one')); views.pin('one'); views.open(view('two'), true);
  assert.equal(views.read().active, 'one'); assert.equal(views.read().tabs.find(tab => tab.id === 'two').pending, true);
  views.select('two'); assert.equal(views.read().active, 'two'); views.move(-1); assert.equal(views.read().active, 'one'); views.move(1); assert.equal(views.read().active, 'two');
  views.close('two'); assert.equal(views.read().active, 'one'); views.select(null); assert.equal(views.read().active, null);
  for (let index = 0; index < 7; index++) { views.open(view(String(index))); views.pin(String(index)); }
  assert.equal(views.read().tabs.filter(tab => tab.pinned).length, 5);
  for (let index = 7; index < 80; index++) views.open(view(String(index)));
  assert.equal(views.read().tabs.length, 10); assert.equal(views.read().history.length, 50); assert.equal(views.read().active, '79');
});
