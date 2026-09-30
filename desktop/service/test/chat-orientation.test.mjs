import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chatOrientation, codexSessionInstructions } from '../chat-orientation.mjs';
import { claudeBinary, terminalCommand } from '../agents.mjs';

test('chat routing keeps the Hub and linked project distinct without preloading inventories', () => {
  const text = chatOrientation({ workspaceName: 'Exercise Unity', cardName: 'Exercise Unity Develop', workingProjectName: 'Unity' });
  assert.match(text, /selected Hub card "Exercise Unity Develop"/);
  assert.match(text, /HTML page use mrmak_add_card_page/);
  assert.match(text, /never create Hub content in the linked project/);
  assert.match(text, /Knowledge and Processes default to this workspace/);
  assert.match(text, /If the Bridge is unavailable/);
  assert.ok(text.length < 2200);
  const global = chatOrientation({});
  assert.match(global, /global Hub/);
  assert.match(global, /no selected card/);
  assert.match(global, /Knowledge and Processes are global/);
});

test('Codex session instruction override preserves the effective native instruction and does not edit configs', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-orientation-'));
  const home = path.join(base, 'codex'), cwd = path.join(base, 'project');
  await mkdir(path.join(cwd, '.codex'), { recursive: true });
  await mkdir(home);
  const userFile = path.join(home, 'config.toml'), projectFile = path.join(cwd, '.codex', 'config.toml');
  await writeFile(userFile, 'developer_instructions = "User instruction"\n');
  await writeFile(projectFile, 'developer_instructions = "Project instruction"\n');
  const result = await codexSessionInstructions('Hub routing', home, cwd);
  assert.equal(result, 'Project instruction\n\nHub routing');
  assert.equal(await readFile(userFile, 'utf8'), 'developer_instructions = "User instruction"\n');
  assert.equal(await readFile(projectFile, 'utf8'), 'developer_instructions = "Project instruction"\n');
  const launch = terminalCommand('codex', { bridge: { script: path.join(base, 'bridge-mcp.mjs'), instructions: result } });
  assert.ok(launch.args.includes(`developer_instructions=${JSON.stringify(result)}`));
});

test('Claude terminal command appends the Hub rule without replacing its native prompt', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-command-'));
  const executable = path.join(base, process.platform === 'win32' ? 'claude.exe' : 'claude');
  await writeFile(executable, 'fixture');
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${base}${path.delimiter}${previous || ''}`;
    const command = terminalCommand('claude', { bridge: { script: path.join(base, 'bridge.mjs'), orientation: 'Hub routing' } });
    assert.equal(command.file, executable);
    const config = JSON.parse(command.args[command.args.indexOf('--mcp-config') + 1]);
    assert.deepEqual(config.mcpServers.mrmak_workspace.args, [path.join(base, 'bridge.mjs')]);
    assert.equal(config.mcpServers.mrmak_workspace.env.MRMAK_BRIDGE_TOKEN, '${MRMAK_BRIDGE_TOKEN}');
    const encoded = command.file === 'powershell.exe' ? command.args.at(-1) : null;
    const argumentText = encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : command.args.join(' ');
    assert.match(argumentText, /--append-system-prompt/);
    assert.match(argumentText, /Hub routing/);
    assert.doesNotMatch(argumentText, /--system-prompt(?:\s|$)/);
  } finally { process.env.PATH = previous; }
});

test('Claude npm wrappers resolve to Node and keep JSON out of PowerShell', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-npm-'));
  const npm = path.join(base, 'npm');
  const script = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, '// fixture');
  await writeFile(path.join(npm, 'claude.cmd'), '@echo off');
  assert.deepEqual(claudeBinary({ PATH: npm, APPDATA: base }), { file: process.execPath, args: [script] });
});
