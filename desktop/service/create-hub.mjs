import { cp, mkdir, readFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createHub(template, destination, { reuseExisting = false } = {}) {
  template = path.resolve(template); destination = path.resolve(destination);
  const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    if (reuseExisting && existing.isDirectory() && !existing.isSymbolicLink()) {
      let registry;
      try { registry = JSON.parse(await readFile(path.join(destination, 'workspace/workspace.json'), 'utf8')); } catch { /* Not a ready Hub. */ }
      if (Array.isArray(registry?.entities)) return destination;
    }
    throw new Error('This folder already exists and will not be overwritten. Select a valid Hub or choose another location.');
  }
  const workspace = JSON.parse(await readFile(path.join(template, 'workspace/workspace.json'), 'utf8'));
  if (!Array.isArray(workspace.entities)) throw new Error('The starter Hub is invalid. Reinstall Mr. Mik.');
  // Exclusive creation: even an existing empty folder must not be overwritten.
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  // Copy the marker last. A failed creation is not mistaken for a ready Hub.
  const options = { recursive: true, dereference: false, errorOnExist: true, force: false, filter: async source => {
    if ((await lstat(source)).isSymbolicLink()) throw new Error('The starter Hub contains an unsafe link.');
    return source !== path.join(template, 'workspace/workspace.json');
  } };
  for (const name of await readdir(template)) await cp(path.join(template, name), path.join(destination, name), options);
  await cp(path.join(template, 'workspace/workspace.json'), path.join(destination, 'workspace/workspace.json'), { errorOnExist: true, force: false });
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 && !(process.argv.length === 5 && process.argv[4] === '--reuse-existing')) throw new Error('Expected starter template, Hub folder and optional --reuse-existing.');
    await createHub(process.argv[2], process.argv[3], { reuseExisting: process.argv[4] === '--reuse-existing' });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
