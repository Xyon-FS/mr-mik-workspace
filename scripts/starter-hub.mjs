import { cp, mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { starterFiles } from './source-files.mjs';
import { Projects } from '../desktop/service/projects.mjs';
import { addExampleWorkspace } from '../desktop/service/example-workspace.mjs';

// Only maintained distribution content; never copy personal Hub state or auth.
export async function buildStarterHub(root, destination) {
  await mkdir(destination);
  const filter = source => !['__pycache__', 'node_modules'].includes(path.basename(source));
  for (const folder of ['scripts/video-watch', 'scripts/shared']) await cp(path.join(root, folder), path.join(destination, folder), { recursive: true, filter });
  const names = (await readdir(path.join(root, '.agents/skills'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
  for (const agent of ['.agents', '.claude']) for (const name of names) await cp(path.join(root, agent, 'skills', name), path.join(destination, agent, 'skills', name), { recursive: true, filter });
  for (const [name, value] of Object.entries(starterFiles)) {
    const file = path.join(destination, name); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  for (const folder of ['context', 'knowledge', 'processes', 'inbox', '.agents/skills', '.claude/skills']) await mkdir(path.join(destination, folder), { recursive: true });
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'processes/workspace-authoring.md', 'knowledge/video-watch.md', 'knowledge/voice-dictation.md']) {
    const file = path.join(destination, name); await mkdir(path.dirname(file), { recursive: true }); await copyFile(path.join(root, name), file);
  }
  await cp(path.join(root, 'workspace/_shared'), path.join(destination, 'workspace/_shared'), { recursive: true });
  await addExampleWorkspace(new Projects(destination, path.join(destination, '.mrmak')));
}
