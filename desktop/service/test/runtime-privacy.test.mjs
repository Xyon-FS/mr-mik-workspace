import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('startup diagnostics omit tokens and authenticated URLs; private ready pipe still initializes native windows', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-runtime-'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../main.mjs', import.meta.url)), '--repo', repo], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', ready = false;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Service readiness timed out')), 10000);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('\n')) { clearTimeout(timeout); const value = JSON.parse(output.split('\n')[0]); ready = value.type === 'ready' && !!value.workspace && !!value.chats; resolve(); }
      });
      child.on('error', reject);
      child.once('exit', () => { clearTimeout(timeout); if (!ready) reject(new Error('Service stopped before readiness')); });
    });
    assert.equal(ready, true);
    const diagnostic = JSON.parse(await readFile(path.join(repo, '.mrmak/runtime.json'), 'utf8'));
    assert.deepEqual(Object.keys(diagnostic).sort(), ['origin', 'pid']);
    assert.equal(diagnostic.pid, child.pid);
    assert.doesNotMatch(JSON.stringify(diagnostic), /token|auth|#/i);
  } finally {
    const exited = once(child, 'exit'); child.stdin.write('quit\n'); await exited;
    output = ''; // Never print the private startup message.
  }
});
