import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { installedIde } from '../ide.mjs';

test('IDE availability is based on a real executable path, not an assumed shell alias', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-ide-'));
  const local = path.join(root, 'local');
  assert.equal(installedIde({ LOCALAPPDATA: local, ProgramFiles: path.join(root, 'programs') }), null);
  const file = path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'fixture');
  assert.deepEqual(installedIde({ LOCALAPPDATA: local, ProgramFiles: path.join(root, 'programs') }), { name: 'Visual Studio Code', file });
});
