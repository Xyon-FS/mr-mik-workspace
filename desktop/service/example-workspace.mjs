import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, copyFile, lstat, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { saveJson, within } from './util.mjs';

export const exampleKey = 'mik-midnight-workshop-v1';
export const exampleName = "Mik’s Midnight Workshop";
export const exampleCards = [
  { asset: 'overview', title: 'Welcome to the workshop', category: 'project', pinned: true, description: 'Meet Mik, tour the Hub and plan a delightfully tiny game.', pages: [['Start here', 'index.html'], ['Field guide', 'field-guide.html']] },
  { asset: 'development', title: 'The midnight espresso engine', category: 'dev', description: 'A feature report, decisions and a practical validation checklist.', pages: [['Feature notebook', 'index.html']] },
  { asset: 'design', title: 'Caps, crumbs & characters', category: 'image-gen', description: 'An art brief and a local, clickable visual reference.', pages: [['Art desk', 'index.html']] },
  { asset: 'marketing', title: 'Operation: one more biscuit', category: 'lead-magnet', description: 'A friendly launch plan with an example handoff and campaign outline.', pages: [['Launch desk', 'index.html']] },
];

// Explicit opt-in for existing Hubs. Packaging calls the same installer on a
// brand-new starter. No native settings, skill scopes or external folders change.
export function addExampleWorkspace(projects) {
  return projects.serialize(async () => {
    const metadata = await projects.metadata();
    const existing = metadata.projects.find(project => project.exampleKey === exampleKey);
    if (existing) return { projectId: existing.id, existing: true };
    const source = await readFile(projects.workspacePath, 'utf8'), registry = JSON.parse(source);
    if (!Array.isArray(registry.entities)) throw new Error('Invalid card registry.');
    const root = await realpath(projects.repo), workspace = await realpath(path.join(root, 'workspace'));
    if (!within(root, workspace)) throw new Error('Example content must remain inside the Hub.');
    const assets = fileURLToPath(new URL('./demo-assets/', import.meta.url));
    const projectId = randomUUID(), date = new Date().toISOString().slice(0, 10), created = [];
    const cards = exampleCards.map(definition => ({ id: randomUUID(), projectId, repositoryId: null, type: 'group', category: definition.category, title: definition.title, description: definition.description, sample: true, pinned: !!definition.pinned, status: 'active', created: date, updated: date, folder: `demo-${definition.asset}-${randomUUID()}`, steps: definition.pages.map(([name, file]) => ({ name, path: file })) }));
    try {
      for (const [index, card] of cards.entries()) {
        const folder = path.join(workspace, card.folder); await mkdir(folder); created.push(folder);
        const files = [...exampleCards[index].pages.map(([, file]) => file), 'demo.css', ...(exampleCards[index].asset === 'design' ? ['espresso-cart.svg'] : [])];
        for (const file of files) await copyFile(path.join(assets, file === 'demo.css' ? file : `${exampleCards[index].asset}/${file}`), path.join(folder, file), constants.COPYFILE_EXCL);
      }
      const shared = path.join(workspace, '_shared');
      const entry = await lstat(shared).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Shared report styles must be an ordinary Hub folder.');
      await mkdir(shared, { recursive: true });
      for (const file of ['report.css', 'report.js']) {
        try { await copyFile(path.join(assets, 'shared', file), path.join(shared, file), constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (await readFile(projects.workspacePath, 'utf8') !== source || JSON.stringify(await projects.metadata()) !== JSON.stringify(metadata)) throw new Error('Hub changed during example creation. Retry.');
      const updated = { ...registry, entities: [...registry.entities, ...cards] };
      await saveJson(projects.workspacePath, updated);
      try { await saveJson(projects.registryPath, { ...metadata, projects: [...metadata.projects, { id: projectId, name: exampleName, exampleKey, type: 'example', status: 'active', repositories: [] }] }); }
      catch (error) { await saveJson(projects.workspacePath, registry); throw error; }
    } catch (error) {
      // Only newly created, validated UUID folders are rolled back. Never clear
      // existing Hub folders or shared styles.
      for (const folder of created) if (within(workspace, folder) && path.dirname(folder) === workspace) await rm(folder, { recursive: true });
      throw error;
    }
    projects.changed(); return { projectId, existing: false, cardIds: cards.map(card => card.id) };
  });
}
