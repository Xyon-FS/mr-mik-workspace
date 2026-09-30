import { mkdir, copyFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, starterFiles } from './source-files.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv[2];
if (!argument) throw new Error('Usage: npm run source:clean -- <new empty destination folder>');
const destination = path.resolve(argument), parent = await realpath(path.dirname(destination));
if (destination.toLowerCase().startsWith((await realpath(root)).toLowerCase() + path.sep)) throw new Error('Source copy must be outside the source tree.');
if (await lstat(destination).catch(() => null)) throw new Error('Destination already exists; choose a new folder. Nothing was overwritten.');
await mkdir(path.join(parent, path.basename(destination)));
for (const name of await sourceFiles(root)) {
  if (Object.hasOwn(starterFiles, name)) continue;
  const to = path.join(destination, name); await mkdir(path.dirname(to), { recursive: true }); await copyFile(path.join(root, name), to);
}
for (const [name, value] of Object.entries(starterFiles)) { const to = path.join(destination, name); await mkdir(path.dirname(to), { recursive: true }); await writeFile(to, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
for (const folder of ['inbox', 'knowledge', 'processes', 'context']) { await mkdir(path.join(destination, folder), { recursive: true }); await writeFile(path.join(destination, folder, '.gitkeep'), '', { flag: 'wx' }); }
await writeFile(path.join(destination, 'context/preferences.md'), '# Preferences\n\nAdd your own global preferences here.\n');
await writeFile(path.join(destination, 'context/goals.md'), '# Goals\n\nAdd your own goals here.\n');
console.log(`Clean source created at ${destination}. No personal Hub, chats, credentials, linked project folders or generated builds were copied.`);
