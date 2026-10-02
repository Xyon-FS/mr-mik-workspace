import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveOpenCodeBinary } from '../opencode-binary.mjs';

test('PATH-selected native OpenCode is never replaced by a legacy npm binary', () => {
  const executable = path.resolve('fixture/v2/opencode.exe');
  assert.deepEqual(resolveOpenCodeBinary(executable, { exists: () => true }), { file: executable, args: [] });
});

test('npm V2 shim resolves its own script even when V1 also exists', () => {
  const executable = path.resolve('fixture/npm/opencode.cmd');
  const result = resolveOpenCodeBinary(executable, { exists: () => true, read: () => '%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.cjs', node: 'node-fixture' });
  assert.deepEqual(result, { file: 'node-fixture', args: [path.join(path.dirname(executable), 'node_modules/@opencode/cli/bin/opencode.cjs')] });
});

test('published V2 Windows npm shim resolves the native executable', () => {
  const executable = path.resolve('fixture/npm/opencode.cmd');
  assert.deepEqual(resolveOpenCodeBinary(executable, { exists: () => true, read: () => '%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe' }), { file: path.join(path.dirname(executable), 'node_modules/@opencode/cli/bin/opencode.exe'), args: [] });
});

test('npm V1 shim keeps its native executable and unknown wrappers stay literal', () => {
  const executable = path.resolve('fixture/npm/opencode.cmd');
  assert.deepEqual(resolveOpenCodeBinary(executable, { exists: () => true, read: () => 'node_modules/opencode-ai/bin/opencode' }), { file: path.join(path.dirname(executable), 'node_modules/opencode-ai/bin/opencode.exe'), args: [] });
  assert.deepEqual(resolveOpenCodeBinary(executable, { exists: () => true, read: () => 'custom wrapper' }), { file: executable, args: [] });
});

test('isolated development override must be an existing absolute path', () => {
  const explicit = path.resolve('fixture/v1/opencode.exe');
  assert.deepEqual(resolveOpenCodeBinary(null, { explicit, exists: () => true }), { file: explicit, args: [] });
  assert.throws(() => resolveOpenCodeBinary(null, { explicit: 'relative.exe', exists: () => true }), /explicit/);
  assert.throws(() => resolveOpenCodeBinary(null, { explicit, exists: () => false }), /exist/);
  assert.deepEqual(resolveOpenCodeBinary(null), { file: null, args: [] });
});
