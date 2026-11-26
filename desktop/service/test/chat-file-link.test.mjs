import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveChatFileLink } from '../chat-file-link.mjs';

test('chat links resolve encoded filenames, file URLs and source positions', () => {
  const cwd = path.resolve('project'), file = path.join(cwd, 'Player movement.cs');
  assert.deepEqual(resolveChatFileLink(cwd, 'Player%20movement.cs:12:3'), { file, line: 12, column: 3 });
  assert.deepEqual(resolveChatFileLink(cwd, `${pathToFileURL(file).href}#L12-L20`), { file, line: 12, column: undefined });
  if (process.platform !== 'win32') return;
  const windowsCwd = 'C:/Hub', windowsFile = 'D:\\Project\\Player.cs';
  for (const href of ['/D:/Project/Player.cs', 'D:/D:/Project/Player.cs', 'file:///D:/D:/Project/Player.cs']) {
    assert.equal(resolveChatFileLink(windowsCwd, href).file, windowsFile);
  }
});
