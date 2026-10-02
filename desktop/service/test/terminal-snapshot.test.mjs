import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { TerminalSnapshotAddon } from '../terminal-snapshot.mjs';
import { Sessions } from '../sessions.mjs';

const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const create = () => {
  const terminal = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const snapshot = new TerminalSnapshotAddon(); terminal.loadAddon(snapshot);
  return { terminal, snapshot };
};

test('clear scrollback preserves the complete active screen, cursor and native fullscreen modes without PTY input', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mrmak-clear-'));
  const sessions = await new Sessions(repo, path.join(repo, 'state')).init();
  try {
    for (const alternate of [false, true]) {
      const session = sessions.make({ id: `clear-${alternate}`, agent: 'opencode', name: 'Clear fixture', open: true, cols: 80, rows: 24 });
      sessions.items.set(session.id, session); await sessions.hydrate(session);
      await write(session.terminal, Array.from({ length: 70 }, (_, index) => `Old history ${index}\r\n`).join(''));
      await write(session.terminal, (alternate ? '\x1b[?1049h' : '') + '\x1b[H\x1b[2JHeader remains\x1b[10;4HInput draft remains\x1b[24;1HFooter remains\x1b[10;23H\x1b[?1003;1006h\x1b[?2004h\x1b[?25l');
      const visible = () => Array.from({ length: 24 }, (_, row) => session.terminal.buffer.active.getLine(session.terminal.buffer.active.baseY + row)?.translateToString(false));
      const before = visible(), buffer = session.terminal.buffer.active;
      const cursor = { x: buffer.cursorX, y: buffer.cursorY }, modes = { ...session.terminal.modes };
      let inputs = 0; session.process = { write() { inputs++ }, kill() {} };
      await sessions.clearScreen(session.id);
      assert.deepEqual(visible(), before); assert.deepEqual({ x: buffer.cursorX, y: buffer.cursorY }, cursor);
      assert.deepEqual(session.terminal.modes, modes); assert.equal(buffer.type, alternate ? 'alternate' : 'normal');
      assert.equal(buffer.baseY, 0); assert.equal(inputs, 0);
      await write(session.terminal, 'X');
      assert.equal(session.terminal.buffer.active.getLine(buffer.baseY + cursor.y).getCell(cursor.x).getChars(), 'X');
      session.process = null;
    }
  } finally { for (const session of sessions.items.values()) session.process = null; await sessions.close(); }
});

test('fullscreen snapshot preserves SGR encoding, tracking and alternate screen across repeated restores', async () => {
  let current = create();
  try {
    await write(current.terminal, '\x1b[?1049h\x1b[?1003;10');
    await write(current.terminal, '06hClaude transcript');
    for (let i = 0; i < 3; i++) {
      const data = current.snapshot.serialize({ scrollback: 1500 });
      assert.ok(data.endsWith('\x1b[?1006h'));
      current.terminal.dispose(); current = create();
      await write(current.terminal, data);
      assert.equal(current.terminal.buffer.active.type, 'alternate');
      assert.equal(current.terminal.modes.mouseTrackingMode, 'any');
      assert.equal(current.terminal.buffer.active.getLine(0).translateToString(true), 'Claude transcript');
    }
  } finally { current.terminal.dispose(); }
});

test('mouse encoding follows resets, parameter order and pixel mode without parsing OSC text as a mode', async () => {
  const { terminal, snapshot } = create();
  try {
    for (const [data, expected] of [
      ['\x1b[?1006;1016h', 1016], ['\x1b[?1016;1006h', 1006],
      ['\x1b[?1003l', 1006], ['\x1b[?1006l', 0],
      ['\x1b]0;Title: [ ?1006h\x07', 0], ['\x1b[?1006h\x1bc', 0],
      ['\x1b[?1016h\x1b[?1016l', 0],
    ]) {
      await write(terminal, data);
      assert.equal(snapshot.serialize().endsWith(expected ? `\x1b[?${expected}h` : '\x1b[?1016l'), true);
    }
    await write(terminal, '\x1b[?1006h');
    assert.doesNotMatch(snapshot.serialize({ excludeModes: true }), /\x1b\[\?10(?:06|16)[hl]/);
  } finally { terminal.dispose(); }
});

test('saved session screens retain the fullscreen mouse protocol after service reload', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mrmak-snapshot-'));
  const state = path.join(repo, 'state');
  let sessions = await new Sessions(repo, state).init();
  try {
    const session = sessions.make({ id: 'claude-sgr', agent: 'claude', name: 'Fullscreen', open: true, cols: 80, rows: 24 });
    sessions.items.set(session.id, session); await sessions.hydrate(session);
    await write(session.terminal, '\x1b[?1049h\x1b[?1003;1006hRestored conversation');
    assert.ok((await sessions.snapshot(session.id)).data.endsWith('\x1b[?1006h'));
    await sessions.persist();
    const saved = JSON.parse(await readFile(path.join(state, 'screen-claude-sgr.json'), 'utf8'));
    assert.ok(saved.data.endsWith('\x1b[?1006h'));
    await sessions.close(); sessions = await new Sessions(repo, state).init();
    const restored = await sessions.snapshot('claude-sgr');
    assert.ok(restored.data.endsWith('\x1b[?1006h'));
    assert.equal(sessions.get('claude-sgr').terminal.buffer.active.type, 'alternate');
  } finally { await sessions.close(); }
});
