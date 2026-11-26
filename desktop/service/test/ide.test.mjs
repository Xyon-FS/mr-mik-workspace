import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { mkdtemp } from './fixtures.mjs';
import { installedIde, openIde } from '../ide.mjs';

test('IDE availability is based on a real executable path, not an assumed shell alias', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-ide-'));
  const local = path.join(root, 'local');
  assert.equal(installedIde({ LOCALAPPDATA: local, ProgramFiles: path.join(root, 'programs') }), null);
  const file = path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'fixture');
  assert.deepEqual(installedIde({ LOCALAPPDATA: local, ProgramFiles: path.join(root, 'programs') }), { name: 'Visual Studio Code', file });
  const target = path.join(root, 'Project Source.cs');
  const calls = [];
  const spawnChild = (binary, args) => {
    calls.push([binary, args]);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const env = { LOCALAPPDATA: local, ProgramFiles: path.join(root, 'programs') };
  await openIde(root, { env, spawnChild });
  await openIde(target, { env, spawnChild, line: 12, column: 3 });
  assert.deepEqual(calls, [[file, [root]], [file, ['--goto', `${target}:12:3`]]]);
});
