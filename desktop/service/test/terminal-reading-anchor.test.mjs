import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../../../src/desktop/terminalReadingAnchor.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { terminalReadingAnchor } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
globalThis.window = { clearTimeout, setTimeout };
const delay = () => new Promise(resolve => setTimeout(resolve, 160));
function fixture() {
  const handlers = {};
  const buffer = { type: 'normal', viewportY: 3, baseY: 15, lines: Array.from({ length: 20 }, (_, n) => `Unique line ${n}`), getLine(row) { return this.lines[row] == null ? undefined : { translateToString: () => this.lines[row] }; } };
  const terminal = { buffer: { active: buffer }, parser: { registerCsiHandler(_selector, fn) { handlers.erase = fn; return { dispose() {} }; }, registerEscHandler(_selector, fn) { handlers.reset = fn; return { dispose() {} }; } }, onWriteParsed(fn) { handlers.parsed = fn; return { dispose() {} }; }, onResize(fn) { handlers.resize = fn; return { dispose() {} }; }, scrollToLine(row) { buffer.viewportY = row; } };
  const guard = terminalReadingAnchor(terminal); guard.setEnabled(true);
  const erase = () => { assert.equal(handlers.erase([3]), false); buffer.lines = []; buffer.viewportY = 0; buffer.baseY = 0; handlers.parsed(); };
  const rebuild = lines => { buffer.lines = lines; buffer.baseY = Math.max(0, lines.length - 5); handlers.parsed(); };
  return { buffer, guard, handlers, erase, rebuild };
}
test('restores a unique reading passage, with inserted rows and repeated erase', async () => {
  const f = fixture(); const original = [...f.buffer.lines];
  try { f.erase(); f.erase(); f.rebuild(['New A', 'New B', ...original]); await delay(); assert.equal(f.buffer.viewportY, 5); } finally { f.guard.dispose(); }
});
test('user cancellation, resize and ambiguous replacement never force scroll', async () => {
  for (const reason of ['user', 'resize', 'reset', 'ambiguous', 'missing']) {
    const f = fixture(); const original = [...f.buffer.lines];
    try {
      f.erase();
      if (reason === 'user') f.guard.cancel();
      if (reason === 'resize') f.handlers.resize();
      if (reason === 'reset') assert.equal(f.handlers.reset(), false);
      f.rebuild(reason === 'ambiguous' ? [...original, ...original] : reason === 'missing' ? ['Unrelated A', 'Unrelated B'] : original);
      await delay(); assert.equal(f.buffer.viewportY, 0);
    } finally { f.guard.dispose(); }
  }
});
