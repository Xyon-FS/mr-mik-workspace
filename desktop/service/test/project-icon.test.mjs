import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRepositoryGroups } from '../../../src/desktop/chatRepositoryGroups.ts';

test('repository chat groups use explicit associations, retain unlinked chats, and keep order within groups', () => {
  const project = { repositories: [{ id: 'primary', name: 'Main project', available: true }, { id: 'unity', name: 'Multiplayer', available: true }] };
  const items = [{ id: 'main2', repositoryId: 'primary' }, { id: 'workspace' }, { id: 'unity', repositoryId: 'unity' }, { id: 'main1', repositoryId: 'primary' }, { id: 'hub', repositoryId: 'hub' }, { id: 'removed', repositoryId: 'removed' }];
  const groups = chatRepositoryGroups(items, project);
  assert.deepEqual(groups.map(group => [group.id, group.items.map(item => item.id)]), [['hub', ['workspace', 'hub']], ['primary', ['main2', 'main1']], ['unity', ['unity']], ['removed', ['removed']]]);
  assert.equal(groups.at(-1).missing, true); assert.equal(groups.at(-1).name, 'Unlinked project');
  assert.equal(groups.flatMap(group => group.items).length, items.length);
});
