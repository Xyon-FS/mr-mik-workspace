import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Command-construction tests need discovery, not a real CLI, account or process.
// The npm entry wins over PATH so installed Codex cannot mask missing fixtures.
export async function codexCommandFixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-command-fixture-'));
  const previous = process.env.APPDATA;
  const script = path.join(folder, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, 'throw new Error("Command fixture must never be executed");\n');
  process.env.APPDATA = folder;
  t.after(async () => {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    await rm(folder, { recursive: true, force: true });
  });
  return { file: process.execPath, script };
}
