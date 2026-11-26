import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { codexExecutionDiagnostics } from '../codex-execution-diagnostics.mjs';
import { connectionIssue } from '../connection-errors.mjs';

test('sandbox diagnostics identify the locked runtime without returning logs or secrets', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mik-sandbox-diagnostics-'));
  assert.equal((await codexExecutionDiagnostics(home)).status, 'unavailable');
  await mkdir(path.join(home, '.sandbox'));
  await writeFile(path.join(home, '.sandbox/setup_error.json'), JSON.stringify({ code: 'helper_unknown_error', message: 'setup refresh had errors', token: 'never-return-this' }));
  await writeFile(path.join(home, '.sandbox/sandbox.2026-10-16.log'), 'runtime read/execute validation failed: node_repl.exe: file in use (os error 32)\nSECRET=never-return-this');
  const result = await codexExecutionDiagnostics(home);
  assert.equal(result.status, 'recorded-failure'); assert.equal(result.lockedRuntime, true);
  assert.match(result.message, /Windows error 32/); assert.match(result.note, /not a new execution test/);
  assert.doesNotMatch(JSON.stringify(result), /never-return-this|SECRET/);
  assert.equal(connectionIssue('helper_unknown_error: setup refresh had errors').category, 'sandbox-helper');

  const linkedHome = await mkdtemp(path.join(os.tmpdir(), 'mik-sandbox-diagnostics-link-'));
  await symlink(path.join(home, '.sandbox'), path.join(linkedHome, '.sandbox'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await codexExecutionDiagnostics(linkedHome)).status, 'unavailable');
});
