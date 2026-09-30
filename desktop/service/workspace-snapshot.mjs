import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, readFile, readdir, copyFile, writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { saveJson, within } from './util.mjs';

const manifestName = 'mik-workspace.json';
const idPattern = /^[a-f0-9-]{36}$/i;
const safe = name => typeof name === 'string' && name.length < 450 && !/[\\:\x00-\x1f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const privateName = name => name.split('/').some(part => /^(auth|credentials?|tokens?|runtime|node_modules|target|cache)(?:[.-]|$)/i.test(part));
const allowed = name => safe(name) && !privateName(name) && /^(workspace|knowledge|processes|inbox|skills)\//.test(name);
const hash = async file => { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex'); };
const json = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Repair the invalid workspace JSON before transferring it.'); } };

// Resolve every existing component, including Windows junctions. Never follow
// symlinks, or create directories through a link supplied by an imported file.
async function target(root, relative) {
  const base = await realpath(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink() || info && !within(base, await realpath(current))) throw new Error('Transfer destination contains an unsafe link.');
  }
  if (!within(base, current)) throw new Error('Transfer leaves its selected folder.');
  return current;
}
async function walk(root, relative, result) {
  const folder = await target(root, relative);
  const info = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  if (!info.isDirectory()) throw new Error('Expected a regular content folder.');
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (!allowed(name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Content links cannot be transferred. Copy their files into the Hub first.');
    if (entry.isDirectory()) await walk(root, name, result);
    else if (entry.isFile()) result.set(name, { source: await target(root, name) });
  }
}

export class WorkspaceSnapshot {
  constructor(repo, stateDir, projects) { this.repo = repo; this.stateDir = stateDir; this.projects = projects; }

  async contents(projectId) {
    const project = await this.projects.get(projectId);
    if (!idPattern.test(project.id)) throw new Error('Workspace ID is invalid.');
    const registry = await json(this.projects.workspacePath, { entities: [], resources: [] });
    const cards = registry.entities.filter(item => item.projectId === projectId);
    const resources = [];
    for (const kind of ['knowledge', 'process', 'inbox']) resources.push(...(await this.projects.resources(kind, projectId, 'project')));
    const entries = new Map();
    for (const card of cards) {
      if (!safe(card.folder) || card.folder.split('/')[0] === '_shared') throw new Error('Invalid card folder.');
      await walk(this.repo, `workspace/${card.folder}`, entries);
    }
    await walk(this.repo, 'workspace/_shared', entries);
    for (const resource of resources) {
      if (resource.repositoryProjectId) continue; // Preserve the link, never the external file.
      if (!allowed(resource.path) || !/^(knowledge|processes|inbox)\//.test(resource.path)) throw new Error('Invalid resource path.');
      const source = await target(this.repo, resource.path);
      if (!(await lstat(source)).isFile()) throw new Error('An associated resource is missing.');
      entries.set(resource.path, { source });
    }
    // Only project-effective skills are materialized. Global settings and other
    // workspaces' overrides are not exported or changed by importing a snapshot.
    const skills = {};
    for (const agent of ['codex', 'claude']) {
      const scopes = await this.projects.hubSkills(projectId, agent);
      skills[agent] = scopes.map(item => ({ id: item.id, enabled: item.effective }));
      for (const skill of scopes.filter(item => item.effective)) {
        const prefix = agent === 'codex' ? '.agents' : '.claude';
        const skillRoot = await target(this.repo, `${prefix}/skills/${skill.id}`);
        const visit = async (folder, relative = '') => {
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            const name = `skills/${agent}/${skill.id}/${relative}${entry.name}`;
            if (!allowed(name)) continue;
            if (entry.isSymbolicLink()) throw new Error('Skill contains an unsafe link.');
            if (entry.isDirectory()) await visit(path.join(folder, entry.name), `${relative}${entry.name}/`);
            else if (entry.isFile()) entries.set(name, { source: path.join(folder, entry.name) });
          }
        };
        await visit(skillRoot);
      }
    }
    const manifest = { format: 'mr-mik-workspace', schema: 1, appVersion: '0.2.7', exportedAt: new Date().toISOString(), project: { id: project.id, name: project.name, type: project.type, status: project.status, ...(project.exampleKey ? { exampleKey: project.exampleKey } : {}), repositories: project.repositories.map(({ id, name }) => ({ id, name })) }, cards, resources, skills, files: [] };
    for (const [name, entry] of entries) manifest.files.push({ name, sha256: await hash(entry.source), bytes: (await lstat(entry.source)).size });
    manifest.files.sort((a, b) => a.name.localeCompare(b.name));
    return { manifest, entries };
  }

  async load(folder) {
    const root = await realpath(folder);
    const file = await target(root, manifestName);
    if ((await lstat(file)).size > 8 * 1024 * 1024) throw new Error('Snapshot manifest is too large.');
    const manifest = await json(file);
    if (manifest?.format !== 'mr-mik-workspace' || manifest.schema !== 1 || !idPattern.test(manifest.project?.id) || typeof manifest.project?.name !== 'string' || !Array.isArray(manifest.files) || manifest.files.length > 20000 || !Array.isArray(manifest.cards) || !Array.isArray(manifest.resources) || !Array.isArray(manifest.project.repositories)) throw new Error('Unsupported or invalid workspace snapshot.');
    const names = new Set();
    const linked = new Set(manifest.project.repositories.map(item => item.id));
    if (manifest.project.repositories.some(item => !/^[a-z0-9-]{1,64}$/i.test(item.id) || typeof item.name !== 'string') || linked.size !== manifest.project.repositories.length) throw new Error('Invalid linked project descriptors.');
    const cardIds = new Set(), folders = new Set();
    for (const card of manifest.cards) {
      if (typeof card.id !== 'string' || !safe(card.id) || !safe(card.folder) || card.folder.split('/')[0] === '_shared' || card.projectId !== manifest.project.id || cardIds.has(card.id) || folders.has(card.folder.toLowerCase()) || card.repositoryId && !linked.has(card.repositoryId) || !Array.isArray(card.steps) || card.steps.some(step => !safe(step.path))) throw new Error('Invalid card associations.');
      cardIds.add(card.id); folders.add(card.folder.toLowerCase());
      for (const artifact of card.artifacts || []) if (!safe(artifact.path) || artifact.projectId !== manifest.project.id || !linked.has(artifact.repositoryId || 'primary')) throw new Error('Invalid external artifact link.');
    }
    for (const resource of manifest.resources) {
      if (resource.projectId !== manifest.project.id || !['knowledge', 'process', 'inbox'].includes(resource.kind) || !safe(resource.path) || resource.repositoryProjectId && resource.repositoryProjectId !== manifest.project.id || !resource.repositoryProjectId && !/^(knowledge|processes|inbox)\//.test(resource.path)) throw new Error('Invalid resource associations.');
    }
    for (const item of manifest.files) {
      const lower = item.name?.toLowerCase();
      if (!allowed(item.name) || names.has(lower) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error('Invalid or duplicate snapshot file.');
      names.add(lower);
      if (item.name.startsWith('workspace/') && !item.name.startsWith('workspace/_shared/') && !manifest.cards.some(card => item.name.startsWith(`workspace/${card.folder}/`))) throw new Error('File belongs to an unrelated card.');
      if (/^(knowledge|processes|inbox)\//.test(item.name) && !manifest.resources.some(resource => !resource.repositoryProjectId && resource.path === item.name)) throw new Error('File belongs to an unrelated resource.');
      if (item.name.startsWith('skills/') && !/^skills\/(codex|claude)\/[a-z0-9][a-z0-9-]{0,63}\//.test(item.name)) throw new Error('Invalid skill file.');
      const actual = await target(root, item.name), info = await lstat(actual);
      if (!info.isFile() || info.size !== item.bytes || await hash(actual) !== item.sha256) throw new Error('Snapshot content has changed. Export again before importing.');
    }
    return { root, manifest };
  }

  destination(name) { return name.replace(/^skills\/(codex|claude)\//, (_, agent) => `${agent === 'codex' ? '.agents' : '.claude'}/skills/`); }

  async preview(folder) {
    const { root, manifest } = await this.load(folder);
    const registry = await json(this.projects.workspacePath, { entities: [], resources: [] });
    const inbox = await json(this.projects.inboxPath, { resources: [] });
    for (const card of manifest.cards) {
      if (registry.entities.some(item => item.projectId !== manifest.project.id && (item.id === card.id || item.folder.toLowerCase() === card.folder.toLowerCase() || item.folder.toLowerCase().startsWith(card.folder.toLowerCase() + '/') || card.folder.toLowerCase().startsWith(item.folder.toLowerCase() + '/')))) throw new Error('A card ID or folder belongs to another workspace. Import into a separate Hub instead.');
    }
    for (const resource of manifest.resources.filter(item => !item.repositoryProjectId)) {
      if ([...(registry.resources || []), ...(inbox.resources || [])].some(item => item.path === resource.path && item.projectId !== manifest.project.id)) throw new Error('A resource is assigned to another workspace. Import into a separate Hub instead.');
    }
    const files = [];
    for (const item of manifest.files) {
      const file = await target(this.repo, this.destination(item.name));
      const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && !info.isFile()) throw new Error('Import target is not a regular file.');
      files.push({ name: item.name, status: info ? await hash(file) === item.sha256 ? 'identical' : 'conflict' : 'new' });
    }
    const metadata = await this.projects.metadata();
    const localProject = metadata.projects.find(item => item.id === manifest.project.id);
    const localCards = registry.entities.filter(item => item.projectId === manifest.project.id);
    const metadataConflict = !!localProject && JSON.stringify({ project: localProject, cards: localCards, resources: [...(registry.resources || []).filter(item => item.projectId === manifest.project.id), ...(inbox.resources || []).filter(item => item.projectId === manifest.project.id)] }) !== JSON.stringify({ project: manifest.project, cards: manifest.cards, resources: manifest.resources });
    return { path: root, manifest, files, metadataConflict };
  }

  async exportTo(parent, projectId) {
    const root = await realpath(parent), hub = await realpath(this.repo);
    if (within(hub, root)) throw new Error('Choose an export folder outside the Hub.');
    const { manifest, entries } = await this.contents(projectId);
    const folder = path.join(root, `mik-${projectId.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
    await mkdir(folder);
    for (const [name, entry] of entries) { const file = await target(folder, name); await mkdir(path.dirname(file), { recursive: true }); await copyFile(entry.source, file); }
    await saveJson(path.join(folder, manifestName), manifest);
    await writeFile(path.join(folder, '.gitignore'), '.mik-backups/\n');
    return { path: folder, files: manifest.files.length };
  }

  async updatePreview(folder, projectId) {
    const { root, manifest: previous } = await this.load(folder);
    if (previous.project.id !== projectId || within(await realpath(this.repo), root)) throw new Error('Choose a snapshot of the selected workspace outside the Hub.');
    const { manifest } = await this.contents(projectId);
    const incoming = new Map(manifest.files.map(item => [item.name, item.sha256]));
    return { path: root, projectId, removed: previous.files.filter(item => !incoming.has(item.name)).map(item => item.name), changed: manifest.files.filter(item => previous.files.find(old => old.name === item.name)?.sha256 !== item.sha256).map(item => item.name) };
  }

  async update(folder, projectId) {
    const preview = await this.updatePreview(folder, projectId);
    const { manifest, entries } = await this.contents(projectId);
    const changes = manifest.files.map(item => ({ relative: item.name, source: entries.get(item.name).source, sha256: item.sha256 }));
    for (const relative of preview.removed) changes.push({ relative, remove: true });
    changes.push({ relative: manifestName, data: manifest });
    return this.commit(preview.path, changes, path.join(preview.path, '.mik-backups'));
  }

  async importFrom(folder, { replaceFiles = [], replaceMetadata = false, relinks = {} } = {}) {
    const preview = await this.preview(folder);
    if (preview.metadataConflict && !replaceMetadata) throw new Error('Confirm replacement of workspace metadata before importing this update.');
    if (preview.files.some(item => item.status === 'conflict' && !replaceFiles.includes(item.name))) throw new Error('Resolve all file conflicts before importing. No partial workspace is imported.');
    return this.projects.serialize(async () => {
      const { manifest } = preview;
      const metadata = await this.projects.metadata();
      const registry = await json(this.projects.workspacePath, { entities: [], resources: [] });
      const inbox = await json(this.projects.inboxPath, { resources: [] });
      const scopes = await this.projects.hubSkillScopes();
      const locations = await json(this.projects.locationsPath, {});
      const id = manifest.project.id;
      for (const [repositoryId, folder] of Object.entries(relinks)) {
        if (!manifest.project.repositories.some(item => item.id === repositoryId) || typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose an existing linked project folder.');
        const linked = await realpath(folder), hub = await realpath(this.repo);
        if (!(await lstat(linked)).isDirectory() || within(hub, linked) || within(linked, hub)) throw new Error('Linked projects must remain outside the Hub.');
        if (Object.entries(locations).some(([otherId, value]) => otherId !== id && Object.values(value.repositories || { primary: value.repositoryPath }).some(other => other?.toLowerCase() === linked.toLowerCase()))) throw new Error('This linked folder is already registered to another workspace.');
        locations[id] ||= {}; locations[id].repositories ||= {}; locations[id].repositories[repositoryId] = linked;
      }
      const project = { id, name: manifest.project.name, type: manifest.project.type || 'other', status: manifest.project.status || 'active', ...(manifest.project.exampleKey === 'mik-midnight-workshop-v1' ? { exampleKey: manifest.project.exampleKey } : {}), repositories: manifest.project.repositories.map(({ id, name }) => ({ id, name })) };
      metadata.projects = [...metadata.projects.filter(item => item.id !== id), project];
      registry.entities = [...registry.entities.filter(item => item.projectId !== id), ...manifest.cards];
      registry.resources = [...(registry.resources || []).filter(item => item.projectId !== id), ...manifest.resources.filter(item => item.kind !== 'inbox')];
      inbox.resources = [...(inbox.resources || []).filter(item => item.projectId !== id), ...manifest.resources.filter(item => item.kind === 'inbox')];
      for (const agent of ['codex', 'claude']) {
        const key = agent === 'codex' ? 'skills' : 'claudeSkills'; scopes[key] ||= {};
        for (const skill of manifest.skills?.[agent] || []) {
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.id) || typeof skill.enabled !== 'boolean') throw new Error('Invalid skill scope.');
          scopes[key][skill.id] ||= { global: false, projects: {} }; scopes[key][skill.id].projects ||= {}; scopes[key][skill.id].projects[id] = skill.enabled;
        }
      }
      const changes = preview.files.filter(item => item.status !== 'identical').map(item => ({ relative: this.destination(item.name), source: path.join(preview.path, item.name), sha256: manifest.files.find(file => file.name === item.name).sha256 }));
      const stateRelative = path.relative(this.repo, this.stateDir).replaceAll('\\', '/');
      if (!within(path.resolve(this.repo), path.resolve(this.stateDir))) throw new Error('Hub state must be inside the Hub for workspace transfer.');
      await target(this.repo, stateRelative);
      changes.push({ relative: 'projects/registry.json', data: metadata }, { relative: 'workspace/workspace.json', data: registry }, { relative: 'projects/skill-scopes.json', data: scopes }, { relative: `${stateRelative}/inbox.json`, data: inbox }, { relative: `${stateRelative}/project-locations.json`, data: locations });
      const result = await this.commit(this.repo, changes, path.join(this.stateDir, 'snapshot-backups'));
      this.projects.changed(); return { ...result, projectId: id };
    });
  }

  async commit(root, changes, backupRoot) {
    // All targets are preflighted; original bytes are backed up before the first
    // write. Roll back any written item on failure. No unrelated file is removed.
    const backup = path.join(backupRoot, randomUUID());
    const backupRelative = path.relative(root, backup).replaceAll('\\', '/');
    await target(root, backupRelative); await mkdir(backup, { recursive: true });
    const prepared = [];
    for (const change of changes) {
      const file = await target(root, change.relative);
      const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && !info.isFile()) throw new Error('Transfer target is not a regular file.');
      const previous = path.join(backup, change.relative);
      if (info) { await mkdir(path.dirname(previous), { recursive: true }); await copyFile(file, previous); }
      prepared.push({ ...change, file, previous, existed: !!info });
    }
    const written = [];
    try {
      for (const item of prepared) {
        await target(root, item.relative); await mkdir(path.dirname(item.file), { recursive: true }); written.push(item);
        if (item.remove) { if (item.existed) await unlink(item.file); }
        else if (item.source) {
          await copyFile(item.source, item.file);
          if (item.sha256 && await hash(item.file) !== item.sha256) throw new Error('Source content changed during transfer. The operation was rolled back.');
        }
        else await saveJson(item.file, item.data);
      }
    } catch (error) {
      for (const item of written.reverse()) {
        if (item.existed) await copyFile(item.previous, item.file);
        else await unlink(item.file).catch(() => {});
      }
      throw error;
    }
    return { files: changes.length, backup };
  }
}
