import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat, lstat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveJson, within } from './util.mjs';
import { stageCardRemoval } from './card-removal.mjs';

const execute = promisify(execFile);
const invalid = message => Object.assign(new Error(message), { status: 400 });
const privatePath = value => value.split(/[\\/]/).some(part => part.startsWith('.') || /^(auth|credentials|tokens?)\./i.test(part));
const document = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Registry could not be read. Repair its JSON before saving changes.'); }
};

// Portable metadata is deliberately separate from machine-local locations.
export class Projects {
  constructor(repo, stateDir, changed = () => {}) {
    this.repo = repo; this.stateDir = stateDir; this.changed = changed; this.writes = Promise.resolve();
    this.registryPath = path.join(repo, 'projects', 'registry.json');
    this.skillScopesPath = path.join(repo, 'projects', 'skill-scopes.json');
    this.locationsPath = path.join(stateDir, 'project-locations.json');
    this.workspacePath = path.join(repo, 'workspace', 'workspace.json');
    this.inboxPath = path.join(stateDir, 'inbox.json');
  }
  serialize(action) {
    const operation = this.writes.catch(() => {}).then(action);
    this.writes = operation; return operation;
  }
  async metadata() { const registry = await document(this.registryPath, { projects: [] }); if (!Array.isArray(registry.projects)) throw invalid('Invalid project registry.'); return registry; }
  async list() {
    const { projects } = await this.metadata(), locations = await document(this.locationsPath, {});
    return Promise.all(projects.map(async project => {
      const saved = locations[project.id] || {};
      const descriptors = Array.isArray(project.repositories) ? project.repositories : [{ id: 'primary', name: 'Repository' }];
      const repositories = await Promise.all(descriptors.map(async item => {
        const repositoryPath = saved.repositories?.[item.id] || (item.id === 'primary' ? saved.repositoryPath : null) || null;
        return { id: item.id, name: item.id === 'primary' && item.name === 'Repository' ? 'Main project' : item.name, repositoryPath, available: !!repositoryPath && !!(await stat(repositoryPath).catch(() => null))?.isDirectory() };
      }));
      return { ...project, repositories, repositoryPath: repositories[0]?.repositoryPath || null, available: !repositories.length || repositories.some(item => item.available) };
    }));
  }
  async get(id) {
    const project = (await this.list()).find(item => item.id === id);
    if (!project) throw invalid('Project is not registered.');
    return project;
  }
  async root(id, repositoryId) {
    const project = await this.get(id);
    const repository = repositoryId ? project.repositories.find(item => item.id === repositoryId) : project.repositories.find(item => item.available) || project.repositories[0];
    if (!repository) throw invalid('Repository is not linked to this project.');
    if (!repository.available) throw invalid('Repository folder is missing. Relink it before opening a chat.');
    return realpath(repository.repositoryPath);
  }
  async createSkill({ target, agent, projectId, repositoryId, name, description, instructions }) {
    if (!['hub', 'linked'].includes(target) || !['codex', 'claude'].includes(agent) || typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) || typeof description !== 'string' || !description.trim() || description.length > 500 || /[\r\n]/.test(description) || typeof instructions !== 'string' || !instructions.trim() || instructions.length > 64 * 1024) throw invalid('Provide a skill name, one-line description and instructions.');
    if (target === 'linked' && (!projectId || !repositoryId)) throw invalid('Choose a linked project before adding a native skill.');
    const base = target === 'hub' ? await realpath(this.repo) : await this.root(projectId, repositoryId);
    let folder = base;
    for (const segment of [agent === 'codex' ? '.agents' : '.claude', 'skills', name]) {
      folder = path.join(folder, segment);
      const existing = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw invalid('Skill destination is not a regular folder.');
      if (!existing) await mkdir(folder);
      if (!within(base, await realpath(folder))) throw invalid('Skill destination leaves its selected root.');
    }
    const file = path.join(folder, 'SKILL.md');
    const source = `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${instructions.trim()}\n`;
    try { await writeFile(file, source, { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw invalid('A skill with this name already exists.'); throw error; }
    this.changed(); return { target, agent, name, path: file, repositoryId: target === 'linked' ? repositoryId : null };
  }
  async save({ id, name, repositoryPath, type }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw invalid('Choose a project name of up to 100 characters.');
    if (repositoryPath && (typeof repositoryPath !== 'string' || !path.isAbsolute(repositoryPath))) throw invalid('Choose an absolute repository folder.');
    const root = repositoryPath ? await realpath(repositoryPath) : null;
    const hub = await realpath(this.repo);
    if (root && (!(await stat(root)).isDirectory() || path.dirname(root) === root || within(hub, root) || within(root, hub))) throw invalid('Choose an external project folder, not the hub or a parent of it.');
    return this.serialize(async () => {
      const registry = await this.metadata(), locations = await document(this.locationsPath, {});
      if (root && Object.entries(locations).some(([key, value]) => key !== id && Object.values(value.repositories || { primary: value.repositoryPath }).some(folder => folder?.toLowerCase() === root.toLowerCase()))) throw invalid('This folder is already registered.');
      if (id && !registry.projects.some(item => item.id === id)) throw invalid('Project is not registered.');
      const previous = registry.projects.find(item => item.id === id);
      const repositories = previous?.repositories?.length ? previous.repositories : root ? [{ id: 'primary', name: 'Main project' }] : previous?.repositories || [];
      const project = { ...previous, id: id || randomUUID(), name: name.trim(), type: String(type || previous?.type || 'other').slice(0, 40), status: previous?.status || 'active', repositories };
      registry.projects = [...registry.projects.filter(item => item.id !== project.id), project];
      if (root) { const mainId = project.repositories[0].id; locations[project.id] = { ...locations[project.id], repositoryPath: root, repositories: { ...locations[project.id]?.repositories, [mainId]: root } }; }
      await saveJson(this.locationsPath, locations); await saveJson(this.registryPath, registry);
      await Promise.all(['knowledge', 'processes'].map(folder => mkdir(path.join(this.repo, folder, 'projects', project.id), { recursive: true })));
      this.changed(); return this.get(project.id);
    });
  }
  async saveRepository({ projectId, id, name, repositoryPath }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw invalid('Choose a repository name of up to 100 characters.');
    if (typeof repositoryPath !== 'string' || !path.isAbsolute(repositoryPath)) throw invalid('Choose an absolute repository folder.');
    const root = await realpath(repositoryPath), hub = await realpath(this.repo);
    if (!(await stat(root)).isDirectory() || path.dirname(root) === root || within(hub, root) || within(root, hub)) throw invalid('Choose an external repository folder.');
    return this.serialize(async () => {
      const registry = await this.metadata(), locations = await document(this.locationsPath, {});
      const project = registry.projects.find(item => item.id === projectId);
      if (!project) throw invalid('Project is not registered.');
      const repositories = Array.isArray(project.repositories) ? project.repositories : [{ id: 'primary', name: 'Repository' }];
      if (id && !repositories.some(item => item.id === id)) throw invalid('Repository is not registered.');
      if (Object.entries(locations).some(([key, value]) => Object.entries(value.repositories || { primary: value.repositoryPath }).some(([repoId, folder]) => folder?.toLowerCase() === root.toLowerCase() && (key !== projectId || repoId !== id)))) throw invalid('This folder is already registered.');
      const repository = { id: id || randomUUID(), name: name.trim() };
      project.repositories = id ? repositories.map(item => item.id === id ? repository : item) : [...repositories, repository];
      locations[projectId] ||= {};
      locations[projectId].repositories = { ...locations[projectId].repositories, [repository.id]: root };
      if (repository.id === project.repositories[0].id) locations[projectId].repositoryPath = root;
      await saveJson(this.locationsPath, locations); await saveJson(this.registryPath, registry);
      this.changed(); return { ...repository, repositoryPath: root, available: true };
    });
  }
  async removeRepository({ projectId, repositoryId, replacementId = null, cardAction = 'keep', expectedCardIds }) {
    if (typeof projectId !== 'string' || typeof repositoryId !== 'string') throw invalid('Choose a linked project to remove.');
    return this.serialize(async () => {
      const registry = await this.metadata(), locations = await document(this.locationsPath, {});
      const project = registry.projects.find(item => item.id === projectId);
      if (!project) throw invalid('Workspace is not registered.');
      const repositories = project.repositories || [];
      if (!repositories.some(item => item.id === repositoryId)) throw invalid('Linked project is not registered.');
      if (repositories.length < 2) throw invalid('A workspace needs one linked project. Add another before removing this one.');
      const isMain = repositories[0].id === repositoryId;
      if (isMain && (!replacementId || replacementId === repositoryId || !repositories.some(item => item.id === replacementId))) throw invalid('Choose another linked project as the main project.');
      if (!isMain && replacementId) throw invalid('A replacement is only needed for the main linked project.');
      const workspace = await document(this.workspacePath, { entities: [] });
      if (!Array.isArray(workspace.entities)) throw invalid('Workspace cards are invalid.');
      const affected = workspace.entities.filter(card => card.projectId === projectId && card.repositoryId === repositoryId);
      this.checkCardChoice(cardAction, affected, expectedCardIds);
      const previous = { workspace: await readFile(this.workspacePath, 'utf8'), registry: await readFile(this.registryPath, 'utf8'), locations: await readFile(this.locationsPath, 'utf8') };
      if (JSON.stringify(JSON.parse(previous.workspace)) !== JSON.stringify(workspace)) throw new Error('Cards changed on disk. Review the selection again.');
      const staged = cardAction === 'delete' ? await stageCardRemoval(this.repo, this.stateDir, workspace, affected) : null;
      const date = new Date().toISOString().slice(0, 10);
      let affectedCards = 0, removedArtifacts = 0, removedDocuments = 0;
      for (const card of workspace.entities) {
        if (card.projectId === projectId && card.repositoryId === repositoryId) { card.repositoryId = null; card.updated = date; if (cardAction === 'archive') { card.status = 'archived'; card.pinned = false; } affectedCards++; }
        if (Array.isArray(card.artifacts)) {
          const before = card.artifacts.length;
          card.artifacts = card.artifacts.filter(item => !(item.projectId === projectId && (item.repositoryId || 'primary') === repositoryId));
          removedArtifacts += before - card.artifacts.length;
          if (before !== card.artifacts.length) card.updated = date;
        }
      }
      if (Array.isArray(workspace.resources)) {
        const before = workspace.resources.length;
        workspace.resources = workspace.resources.filter(item => !(item.repositoryProjectId === projectId && (item.repositoryId || 'primary') === repositoryId));
        removedDocuments = before - workspace.resources.length;
      }
      const remaining = repositories.filter(item => item.id !== repositoryId);
      project.repositories = isMain ? [remaining.find(item => item.id === replacementId), ...remaining.filter(item => item.id !== replacementId)] : remaining;
      const saved = locations[projectId] || {};
      saved.repositories = { ...(saved.repositories || (saved.repositoryPath ? { primary: saved.repositoryPath } : {})) };
      delete saved.repositories[repositoryId];
      saved.repositoryPath = saved.repositories[project.repositories[0].id] || null;
      locations[projectId] = saved;
      if (cardAction === 'delete') workspace.entities = workspace.entities.filter(card => !affected.some(item => item.id === card.id));
      let committing = false;
      try {
        if (await readFile(this.workspacePath, 'utf8') !== previous.workspace || await readFile(this.registryPath, 'utf8') !== previous.registry || await readFile(this.locationsPath, 'utf8') !== previous.locations) throw new Error('Registrations changed on disk. Review the selection again.');
        committing = true;
        await saveJson(this.workspacePath, workspace);
        await saveJson(this.locationsPath, locations);
        await saveJson(this.registryPath, registry);
      } catch (error) {
        try { if (committing) { await saveJson(this.workspacePath, JSON.parse(previous.workspace)); await saveJson(this.locationsPath, JSON.parse(previous.locations)); await saveJson(this.registryPath, JSON.parse(previous.registry)); } }
        finally { await staged?.rollback(); } throw error;
      }
      const disposal = await staged?.finish(file => this.recycleCardFolder(file));
      this.changed();
      return { removed: true, folderUntouched: true, mainRepositoryId: project.repositories[0].id, affectedCards, removedArtifacts, removedDocuments, cardAction, cardIds: affected.map(card => card.id), ...disposal };
    });
  }
  async remove(id, { cardAction = 'keep', expectedCardIds } = {}) {
    return this.serialize(async () => {
      const registry = await this.metadata();
      if (!registry.projects.some(item => item.id === id)) throw invalid('Workspace is not registered.');
      const workspace = await document(this.workspacePath, { entities: [] });
      const affected = workspace.entities.filter(card => card.projectId === id);
      this.checkCardChoice(cardAction, affected, expectedCardIds);
      const previous = { workspace: JSON.parse(JSON.stringify(workspace)), registry: JSON.parse(JSON.stringify(registry)), locations: await document(this.locationsPath, {}) };
      previous.inbox = await document(this.inboxPath, {});
      const discovered = [...await this.resources('knowledge', id, 'project'), ...await this.resources('process', id, 'project')];
      workspace.resources ||= [];
      for (const resource of discovered) if (!workspace.resources.some(item => item.id === resource.id)) workspace.resources.push(resource);
      const staged = cardAction === 'delete' ? await stageCardRemoval(this.repo, this.stateDir, workspace, affected) : null;
      registry.projects = registry.projects.filter(item => item.id !== id);
      const locations = await document(this.locationsPath, {}); delete locations[id];
      if (cardAction === 'delete') workspace.entities = workspace.entities.filter(card => card.projectId !== id);
      else for (const card of affected) { card.projectId = null; card.repositoryId = null; if (cardAction === 'archive') { card.status = 'archived'; card.pinned = false; } }
      // Retain libraries as global content rather than orphaning their scope.
      for (const resource of workspace.resources || []) if (resource.projectId === id) resource.projectId = null;
      const inbox = JSON.parse(JSON.stringify(previous.inbox));
      for (const item of inbox.resources || []) if (item.projectId === id) item.projectId = null;
      let committing = false;
      try {
        if (JSON.stringify(await document(this.workspacePath, {})) !== JSON.stringify(previous.workspace) || JSON.stringify(await this.metadata()) !== JSON.stringify(previous.registry) || JSON.stringify(await document(this.locationsPath, {})) !== JSON.stringify(previous.locations) || JSON.stringify(await document(this.inboxPath, {})) !== JSON.stringify(previous.inbox)) throw new Error('Registrations changed on disk. Review the selection again.');
        committing = true;
        await saveJson(this.workspacePath, workspace); await saveJson(this.registryPath, registry); await saveJson(this.locationsPath, locations); await saveJson(this.inboxPath, inbox);
      }
      catch (error) { try { if (committing) { await saveJson(this.workspacePath, previous.workspace); await saveJson(this.registryPath, previous.registry); await saveJson(this.locationsPath, previous.locations); await saveJson(this.inboxPath, previous.inbox); } } finally { await staged?.rollback(); } throw error; }
      const disposal = await staged?.finish(file => this.recycleCardFolder(file));
      this.changed(); return { removed: true, repositoryUntouched: true, cardAction, cardIds: affected.map(card => card.id), ...disposal };
    });
  }
  checkCardChoice(action, cards, expectedIds) {
    if (!['keep', 'archive', 'delete'].includes(action)) throw invalid('Choose Keep, Archive or Delete cards.');
    if (action === 'delete' && !Array.isArray(expectedIds)) throw invalid('Review and confirm the cards before deleting.');
    if (expectedIds !== undefined && (!Array.isArray(expectedIds) || JSON.stringify([...expectedIds].sort()) !== JSON.stringify(cards.map(card => card.id).sort()))) throw Object.assign(new Error('The affected cards changed. Review the selection again.'), { status: 409 });
  }
  async removeCard(id) {
    return this.serialize(async () => {
      const source = await readFile(this.workspacePath, 'utf8'), registry = JSON.parse(source);
      const card = registry.entities.find(item => item.id === id);
      if (!card) throw invalid('Card was not found.');
      const staged = await stageCardRemoval(this.repo, this.stateDir, registry, [card]);
      try {
        if (await readFile(this.workspacePath, 'utf8') !== source) throw new Error('Cards changed on disk. Retry deletion.');
        registry.entities = registry.entities.filter(item => item.id !== id);
        await saveJson(this.workspacePath, registry);
      } catch (error) { await staged.rollback(); throw error; }
      const disposal = await staged.finish(file => this.recycleCardFolder(file));
      this.changed(); return { removed: true, cardIds: [id], ...disposal };
    });
  }
  async inspect(id) {
    const project = await this.get(id);
    if (!project.available || !project.repositories.length) return project;
    const root = await this.root(id, project.repositories.find(item => item.available)?.id);
    const detected = {};
    for (const relative of ['AGENTS.md', 'CLAUDE.md', '.codex/config.toml', '.agents/skills', 'package.json', 'ProjectSettings/ProjectVersion.txt']) detected[relative] = !!(await stat(path.join(root, relative)).catch(() => null));
    const git = await execute('git', ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, windowsHide: true }).then(({ stdout }) => stdout.trim()).catch(() => null);
    return { ...project, detected, branch: git };
  }
  async listRepositoryFiles(projectId, repositoryId, relative = '') {
    const root = await this.root(projectId, repositoryId);
    if (typeof relative !== 'string' || path.isAbsolute(relative) || (relative && privatePath(relative))) throw invalid('Choose a non-private repository-relative folder.');
    const folder = await realpath(path.resolve(root, relative));
    if (!within(root, folder) || !(await stat(folder)).isDirectory()) throw invalid('Folder leaves the repository.');
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter(item => !privatePath(item.name) && !item.isSymbolicLink()).slice(0, 300).map(item => ({ name: item.name, path: path.relative(root, path.join(folder, item.name)).replaceAll('\\', '/'), directory: item.isDirectory() }));
  }
  async readRepositoryFile(projectId, repositoryId, relative) {
    const root = await this.root(projectId, repositoryId);
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || privatePath(relative)) throw invalid('Choose a non-private repository-relative file.');
    const file = await realpath(path.resolve(root, relative));
    const info = await stat(file);
    if (!within(root, file) || !info.isFile() || info.size > 128 * 1024 || !/\.(md|txt|json|toml|yaml|yml|xml|csv|tsv|js|jsx|ts|tsx|py|cs|shader|hlsl|glsl|html|css|svg)$/i.test(file)) throw invalid('Choose a readable text file inside the repository under 128 KB.');
    return { path: path.relative(root, file).replaceAll('\\', '/'), text: await readFile(file, 'utf8') };
  }
  async hubSkillScopes() {
    const defaults = await document(path.join(this.repo, 'projects/skill-defaults.json'), { skills: {} });
    return document(this.skillScopesPath, defaults);
  }
  async hubSkills(projectId = null, agent = 'codex') {
    if (!['codex', 'claude'].includes(agent)) throw invalid('Choose Codex or Claude skills.');
    if (projectId) await this.get(projectId);
    const scopes = await this.hubSkillScopes();
    const scopeKey = agent === 'codex' ? 'skills' : 'claudeSkills';
    const settings = scopes[scopeKey] || {};
    if (typeof settings !== 'object' || Array.isArray(settings)) throw invalid('Hub skill scopes are invalid.');
    const folder = await realpath(path.join(this.repo, agent === 'codex' ? '.agents' : '.claude', 'skills')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const skills = [];
    if (!folder) return skills;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/i.test(entry.name)) continue;
      const file = path.join(folder, entry.name, 'SKILL.md');
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.size > 128 * 1024 || !within(folder, await realpath(file))) continue;
      const source = await readFile(file, 'utf8');
      const setting = settings[entry.name] || {};
      const global = setting.global === true;
      const storedOverride = projectId ? setting.projects?.[projectId] : undefined;
      const projectOverride = typeof storedOverride === 'boolean' ? storedOverride : null;
      const selected = projectOverride === true;
      skills.push({ id: entry.name, name: /^name:\s*["']?([^\r\n"']+)/m.exec(source)?.[1]?.trim() || entry.name, description: /^description:\s*["']?([^\r\n"']+)/m.exec(source)?.[1]?.trim() || '', global, project: selected, projectOverride, effective: projectOverride ?? global, projectCount: Object.values(setting.projects || {}).filter(value => value === true).length });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }
  async setHubSkillScope({ id, projectId, scope, enabled, agent = 'codex' }) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(id) || !['global', 'project'].includes(scope) || !['codex', 'claude'].includes(agent) || (scope === 'global' ? typeof enabled !== 'boolean' : !projectId || enabled !== null && typeof enabled !== 'boolean')) throw invalid('Choose a Hub skill, scope and enabled state.');
    if (scope === 'project') await this.get(projectId);
    return this.serialize(async () => {
      if (!(await this.hubSkills(null, agent)).some(item => item.id === id)) throw invalid('Hub skill was not found.');
      const registry = await this.hubSkillScopes();
      const scopeKey = agent === 'codex' ? 'skills' : 'claudeSkills';
      registry[scopeKey] ||= {};
      if (typeof registry[scopeKey] !== 'object' || Array.isArray(registry[scopeKey])) throw invalid('Hub skill scopes are invalid.');
      const setting = registry[scopeKey][id] || { global: false, projects: {} };
      if (scope === 'global') setting.global = enabled;
      else { setting.projects ||= {}; if (enabled === null) delete setting.projects[projectId]; else setting.projects[projectId] = enabled; }
      registry[scopeKey][id] = setting;
      await saveJson(this.skillScopesPath, registry); this.changed();
      return (await this.hubSkills(projectId || null, agent)).find(item => item.id === id);
    });
  }
  async readHubSkill(projectId, id, agent = 'codex') {
    const skill = (await this.hubSkills(projectId, agent)).find(item => item.id === id && item.effective);
    if (!skill) throw invalid('Skill is not enabled for this workspace.');
    const root = path.join(this.repo, agent === 'codex' ? '.agents' : '.claude', 'skills');
    const folder = await realpath(path.join(root, id));
    const file = await realpath(path.join(folder, 'SKILL.md'));
    if (!within(await realpath(root), folder) || !within(folder, file)) throw invalid('Skill leaves the Hub.');
    return { id, name: skill.name, text: await readFile(file, 'utf8'), availability: `Mr. Mik Workspace Bridge only; not a native ${agent === 'codex' ? 'Codex' : 'Claude'} skill in the linked project folder.` };
  }
  async editWorkspace(action) {
    return this.serialize(async () => {
      const source = await readFile(this.workspacePath, 'utf8');
      const registry = JSON.parse(source); const result = await action(registry);
      if (await readFile(this.workspacePath, 'utf8') !== source) throw Object.assign(new Error('Workspace changed on disk. Retry your change.'), { status: 409 });
      await saveJson(this.workspacePath, registry); this.changed(); return result;
    });
  }
  async assignCard(id, projectId) {
    if (projectId) await this.get(projectId);
    return this.editWorkspace(registry => {
      const card = registry.entities.find(item => item.id === id);
      if (!card) throw invalid('Card was not found.');
      if (card.projectId !== (projectId || null)) card.repositoryId = null;
      card.projectId = projectId || null; return card;
    });
  }
  async assignCardRepository(id, repositoryId) {
    const card = (await document(this.workspacePath, { entities: [] })).entities.find(item => item.id === id);
    if (!card?.projectId) throw invalid('Choose a project card.');
    if (repositoryId && !(await this.get(card.projectId)).repositories.some(item => item.id === repositoryId)) throw invalid('Repository is not linked to this project.');
    return this.editWorkspace(registry => {
      const current = registry.entities.find(item => item.id === id && item.projectId === card.projectId);
      if (!current) throw invalid('Card association changed.');
      current.repositoryId = repositoryId || null;
      return current;
    });
  }
  async createCard({ projectId, repositoryId = null, title, description = '', category = 'project' }) {
    if (projectId) {
      const project = await this.get(projectId);
      if (repositoryId && !project.repositories.some(item => item.id === repositoryId)) throw invalid('Repository is not linked to this project.');
    } else if (repositoryId) throw invalid('A global card cannot use a project repository.');
    if (typeof title !== 'string' || !title.trim() || title.length > 160) throw invalid('Choose a card title of up to 160 characters.');
    if (!['project', 'dev', 'research', 'game', 'image-gen', 'analytics', 'lead-magnet', 'other'].includes(category)) throw invalid('Choose a supported card category.');
    return this.editWorkspace(registry => {
      const id = randomUUID(), today = new Date().toISOString().slice(0, 10);
      const card = { id, title: title.trim(), description: String(description).slice(0, 2000), projectId: projectId || null, repositoryId: repositoryId || null, type: 'group', category, created: today, updated: today, folder: `${today}_${id}`, steps: [], status: 'active' };
      registry.entities.push(card); return card;
    });
  }
  async addCardNote({ projectId, id, title, text }) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 100000 || typeof title !== 'string' || !title.trim() || title.length > 160) throw invalid('Choose a note title and Markdown text of up to 100 KB.');
    return this.editWorkspace(async registry => {
      const card = registry.entities.find(item => item.id === id && (item.projectId || null) === (projectId || null));
      if (!card) throw invalid('Card is not available to this project.');
      const root = await realpath(path.join(this.repo, 'workspace'));
      const folder = path.resolve(root, card.folder);
      if (!within(root, folder) || privatePath(card.folder)) throw invalid('Invalid card folder.');
      // Check existing ancestors before mkdir, so a link cannot create folders outside the hub.
      let parent = folder;
      while (!(await stat(parent).catch(() => null))) parent = path.dirname(parent);
      if (!within(root, await realpath(parent))) throw invalid('Card folder leaves the workspace.');
      await mkdir(folder, { recursive: true });
      if (!within(root, await realpath(folder))) throw invalid('Card folder leaves the workspace.');
      const note = `note-${randomUUID()}.md`;
      await writeFile(path.join(folder, note), text, { flag: 'wx' });
      card.steps ||= []; card.steps.push({ name: title.trim(), path: note }); card.updated = new Date().toISOString().slice(0, 10);
      return { id: card.id, step: card.steps.length - 1, path: note };
    });
  }
  async addCardPage({ projectId, id, title, html }) {
    if (typeof title !== 'string' || !title.trim() || title.length > 160 || typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024 || !/<html[\s>]/i.test(html)) throw invalid('Choose a page title and a complete HTML document under 2 MB.');
    return this.editWorkspace(async registry => {
      const card = registry.entities.find(item => item.id === id && (item.projectId || null) === (projectId || null));
      if (!card) throw invalid('Card is not available to this project.');
      const root = await realpath(path.join(this.repo, 'workspace'));
      const folder = path.resolve(root, card.folder);
      if (!within(root, folder) || privatePath(card.folder)) throw invalid('Invalid card folder.');
      let parent = folder;
      while (!(await stat(parent).catch(() => null))) parent = path.dirname(parent);
      if (!within(root, await realpath(parent))) throw invalid('Card folder leaves the workspace.');
      await mkdir(folder, { recursive: true });
      if (!within(root, await realpath(folder))) throw invalid('Card folder leaves the workspace.');
      const page = `page-${randomUUID()}.html`;
      await writeFile(path.join(folder, page), html, { flag: 'wx' });
      card.steps ||= []; card.steps.push({ name: title.trim(), path: page }); card.updated = new Date().toISOString().slice(0, 10);
      return { id: card.id, step: card.steps.length - 1, path: page };
    });
  }
  async updateCardPage({ projectId, id, path: pagePath, html }) {
    if (typeof pagePath !== 'string' || !pagePath.trim() || path.isAbsolute(pagePath) || privatePath(pagePath) || path.extname(pagePath).toLowerCase() !== '.html' || typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024 || !/<html[\s>]/i.test(html)) throw invalid('Choose an existing HTML card page and a complete document under 2 MB.');
    return this.editWorkspace(async registry => {
      const card = registry.entities.find(item => item.id === id && (item.projectId || null) === (projectId || null));
      if (!card || !card.steps?.some(step => step.path === pagePath)) throw invalid('HTML page is not registered in this project card.');
      const root = await realpath(path.join(this.repo, 'workspace'));
      const folder = await realpath(path.resolve(root, card.folder));
      const target = path.resolve(folder, pagePath);
      if (!within(root, folder) || !within(folder, target) || !within(folder, await realpath(path.dirname(target))) || !within(folder, await realpath(target)) || !(await stat(target)).isFile()) throw invalid('HTML page leaves the card folder.');
      const temporary = path.join(path.dirname(target), `.mrmak-page-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, html, { flag: 'wx' });
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      card.updated = new Date().toISOString().slice(0, 10);
      return { id: card.id, path: pagePath };
    });
  }
  async importCardAsset({ projectId, id, repositoryId, path: relative }) {
    const card = (await document(this.workspacePath, { entities: [] })).entities.find(item => item.id === id && item.projectId === projectId);
    if (!card) throw invalid('Card is not available to this project.');
    const sourceRoot = await this.root(projectId, repositoryId);
    if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative) || privatePath(relative)) throw invalid('Choose a non-private repository-relative file.');
    const source = await realpath(path.resolve(sourceRoot, relative));
    const info = await stat(source);
    if (!within(sourceRoot, source) || !info.isFile() || info.size > 1024 * 1024 * 1024) throw invalid('Choose a file inside the repository under 1 GB.');
    const root = await realpath(path.join(this.repo, 'workspace'));
    const folder = path.resolve(root, card.folder, 'assets');
    if (!within(root, folder) || privatePath(card.folder)) throw invalid('Invalid card folder.');
    let parent = folder;
    while (!(await stat(parent).catch(() => null))) parent = path.dirname(parent);
    if (!within(root, await realpath(parent))) throw invalid('Card folder leaves the workspace.');
    await mkdir(folder, { recursive: true });
    if (!within(root, await realpath(folder))) throw invalid('Card folder leaves the workspace.');
    const basename = path.basename(source);
    const target = path.join(folder, `${randomUUID()}-${basename}`);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    return { path: `assets/${path.basename(target)}`, size: info.size };
  }
  async linkArtifact({ projectId, id, repositoryId, path: relative, title }) {
    const card = (await document(this.workspacePath, { entities: [] })).entities.find(item => item.id === id && item.projectId === projectId);
    if (!card) throw invalid('Card is not available to this project.');
    const targetRepositoryId = repositoryId || card.repositoryId || (await this.get(projectId)).repositories[0]?.id;
    const root = await this.root(projectId, targetRepositoryId);
    if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative) || privatePath(relative)) throw invalid('Link a repository-relative, non-private file.');
    const actual = await realpath(path.resolve(root, relative)).catch(() => { throw invalid('Artifact was not found in this project.'); });
    if (!within(root, actual) || !(await stat(actual)).isFile()) throw invalid('Artifact leaves this project or is not a file.');
    const normalized = path.relative(root, actual).replaceAll('\\', '/');
    if (privatePath(normalized)) throw invalid('Private files cannot be linked.');
    return this.editWorkspace(registry => {
      const card = registry.entities.find(item => item.id === id && item.projectId === projectId);
      if (!card) throw invalid('Card is not available to this project.');
      card.artifacts ||= [];
      if (card.artifacts.some(item => item.repositoryId === targetRepositoryId && item.path.toLowerCase() === normalized.toLowerCase())) throw invalid('This artifact is already linked.');
      const artifact = { projectId, repositoryId: targetRepositoryId, path: normalized, title: String(title || path.basename(normalized)).slice(0, 160) };
      card.artifacts.push(artifact); card.updated = new Date().toISOString().slice(0, 10);
      return artifact;
    });
  }
  async artifactLocation(projectId, id, relative, repositoryId) {
    const card = (await document(this.workspacePath, { entities: [] })).entities.find(item => item.id === id && item.projectId === projectId);
    const artifact = card?.artifacts?.find(item => item.projectId === projectId && item.path === relative && (!repositoryId || (item.repositoryId || 'primary') === repositoryId));
    if (!artifact || privatePath(relative)) throw invalid('Artifact is not linked to this project card.');
    const root = await this.root(projectId, artifact.repositoryId), actual = await realpath(path.resolve(root, relative));
    if (!within(root, actual) || !(await stat(actual)).isFile()) throw invalid('Artifact leaves this project.');
    return actual;
  }
  async resources(kind, projectId = '', scope = 'all') {
    if (!['knowledge', 'process', 'inbox'].includes(kind)) throw invalid('Choose Knowledge, Processes or Inbox.');
    if (projectId) await this.get(projectId);
    const registry = kind === 'inbox' ? await document(this.inboxPath, { resources: [] }) : await document(this.workspacePath, { resources: [] });
    const indexed = (registry.resources || []).filter(item => item.kind === kind);
    const folder = kind === 'process' ? 'processes' : kind;
    const discovered = [];
    const walk = async (relative, depth = 0) => {
      if (depth > 15) return;
      for (const entry of await readdir(path.join(this.repo, relative), { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const file = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (entry.isFile()) discovered.push(file);
      }
    };
    await walk(folder);
    const items = [...indexed, ...discovered.filter(file => !indexed.some(item => !item.repositoryProjectId && item.path === file)).map(file => ({ id: file, kind, path: file, title: path.basename(file), projectId: /^\w+\/projects\/([^/]+)\//.exec(file)?.[1] || null }))];
    return items.filter(item => scope === 'all' || (scope === 'global' ? !item.projectId : scope === 'project' ? item.projectId === projectId : !item.projectId || item.projectId === projectId));
  }
  async assignResource({ kind, path: relative, projectId, title }) {
    if (projectId) await this.get(projectId);
    const folder = kind === 'process' ? 'processes' : kind;
    if (!['knowledge', 'process', 'inbox'].includes(kind) || typeof relative !== 'string' || !relative.startsWith(folder + '/') || privatePath(relative)) throw invalid('Choose a resource in the shared library.');
    const actual = await realpath(path.resolve(this.repo, relative));
    if (!within(await realpath(path.join(this.repo, folder)), actual) || !(await stat(actual)).isFile()) throw invalid('Resource leaves its library.');
    const update = registry => {
      registry.resources ||= [];
      const existing = registry.resources.find(item => item.kind === kind && !item.repositoryProjectId && item.path === relative);
      const item = { id: existing?.id || randomUUID(), kind, path: relative, title: String(title || existing?.title || path.basename(relative)).slice(0, 160), projectId: projectId || null };
      registry.resources = [...registry.resources.filter(resource => resource !== existing), item]; return item;
    };
    if (kind !== 'inbox') return this.editWorkspace(update);
    return this.serialize(async () => { const registry = await document(this.inboxPath, { resources: [] }); const result = update(registry); await saveJson(this.inboxPath, registry); this.changed(); return result; });
  }
  async unlinkResource(kind, id) {
    if (!['knowledge', 'process', 'inbox'].includes(kind) || typeof id !== 'string') throw invalid('Choose a linked resource.');
    return this.editWorkspace(registry => {
      registry.resources ||= [];
      const item = registry.resources.find(resource => resource.id === id && resource.kind === kind && resource.repositoryProjectId);
      if (!item) throw invalid('This resource is not an external link.');
      registry.resources = registry.resources.filter(resource => resource !== item);
      return { removed: true, sourceUntouched: true };
    });
  }
  async cleanupRecycledResource(value) {
    const actual = path.resolve(value), canonicalHub = await realpath(this.repo);
    const hub = within(canonicalHub, actual) ? canonicalHub : path.resolve(this.repo);
    if (!within(hub, actual)) return { removed: 0 };
    const relative = path.relative(hub, actual).replaceAll('\\', '/');
    const kind = relative.startsWith('knowledge/') ? 'knowledge' : relative.startsWith('processes/') ? 'process' : relative.startsWith('inbox/') ? 'inbox' : null;
    if (!kind) return { removed: 0 };
    if (await lstat(actual).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) throw invalid('The file still exists; its library entry was not removed.');
    return this.serialize(async () => {
      const file = kind === 'inbox' ? this.inboxPath : this.workspacePath;
      const registry = await document(file, { resources: [] });
      const before = registry.resources?.length || 0;
      registry.resources = (registry.resources || []).filter(item => item.repositoryProjectId || item.path !== relative && !item.path.startsWith(relative + '/'));
      const removed = before - registry.resources.length;
      if (removed) { await saveJson(file, registry); this.changed(); }
      return { removed };
    });
  }
  async readResource(kind, id, projectId) {
    const resource = (await this.resources(kind, projectId, 'relevant')).find(item => item.id === id);
    if (!resource || privatePath(resource.path)) throw invalid('Resource is not available to this project.');
    const actual = await this.resourceLocation(resource);
    if (!actual.endsWith('.md') || (await stat(actual)).size > 2 * 1024 * 1024) throw invalid('Choose a Markdown library document smaller than 2 MB.');
    const text = await readFile(actual, 'utf8');
    return { ...resource, text: text.slice(0, 24000), truncated: text.length > 24000, revision: createHash('sha256').update(text).digest('hex') };
  }
  async updateResource({ kind, id, projectId, scope, text, expectedRevision }) {
    if (!['knowledge', 'process'].includes(kind) || typeof text !== 'string' || !text.trim() || text.length > 24000 || typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw invalid('Provide a complete Markdown document under 24,000 characters and its last-read revision.');
    return this.serialize(async () => {
      const resource = (await this.resources(kind, projectId, 'relevant')).find(item => item.id === id);
      if (!resource || resource.repositoryProjectId) throw invalid('Only Hub-owned Knowledge or Processes can be edited here.');
      if (projectId && !resource.projectId && scope !== 'global') throw invalid('Choose Global explicitly before editing a shared document.');
      const actual = await this.resourceLocation(resource);
      if (path.extname(actual).toLowerCase() !== '.md') throw invalid('Only Markdown library documents can be edited here.');
      const current = await readFile(actual, 'utf8');
      if (current.length > 24000 || createHash('sha256').update(current).digest('hex') !== expectedRevision) throw Object.assign(new Error('Resource changed or was truncated. Read it again before editing.'), { status: 409 });
      const temporary = path.join(path.dirname(actual), `.${randomUUID()}.tmp`);
      try { await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, actual); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      this.changed(); return { id, kind, revision: createHash('sha256').update(text).digest('hex') };
    });
  }
  async createResource({ kind, projectId = null, title, text }) {
    if (!['knowledge', 'process'].includes(kind) || typeof title !== 'string' || !title.trim() || title.length > 160 || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 100 * 1024) throw invalid('Choose Knowledge or Processes, a title and Markdown under 100 KB.');
    if (projectId) await this.get(projectId);
    const root = await realpath(path.join(this.repo, kind === 'process' ? 'processes' : 'knowledge'));
    const folder = projectId ? path.join(root, 'projects', projectId) : root;
    await mkdir(folder, { recursive: true });
    if (!within(root, await realpath(folder))) throw invalid('Library folder leaves the Hub.');
    const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'note';
    const file = path.join(folder, `${slug}-${randomUUID().slice(0, 8)}.md`);
    await writeFile(file, text, { flag: 'wx' });
    try {
      const relative = path.relative(await realpath(this.repo), file).split(path.sep).join('/');
      return await this.assignResource({ kind, path: relative, projectId, title: title.trim() });
    } catch (error) { await unlink(file).catch(() => {}); throw error; }
  }
  async contextFiles() {
    const folder = await realpath(path.join(this.repo, 'context'));
    return (await readdir(folder, { withFileTypes: true })).filter(item => item.isFile() && /^[a-z0-9][a-z0-9-]*\.md$/i.test(item.name)).map(item => item.name).sort();
  }
  async readContext(name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*\.md$/i.test(name)) throw invalid('Choose a Context Markdown file.');
    const folder = await realpath(path.join(this.repo, 'context'));
    const file = path.join(folder, name);
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return { name, exists: false, revision: null, text: '' };
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100 * 1024 || !within(folder, await realpath(file))) throw invalid('Context file is not a regular Markdown file under 100 KB.');
    const text = await readFile(file, 'utf8');
    return { name, exists: true, revision: createHash('sha256').update(text).digest('hex'), text };
  }
  async saveContext({ name, text, expectedRevision }) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 100 * 1024 || !(expectedRevision === null || typeof expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(expectedRevision))) throw invalid('Provide Markdown under 100 KB and the revision returned by readContext (null for a new file).');
    return this.serialize(async () => {
      const current = await this.readContext(name);
      if (current.revision !== expectedRevision) throw Object.assign(new Error('Context changed on disk. Read it again before saving.'), { status: 409 });
      const folder = await realpath(path.join(this.repo, 'context'));
      const target = path.join(folder, name);
      if (!current.exists) await writeFile(target, text, { flag: 'wx' });
      else {
        const temp = path.join(folder, `.${randomUUID()}.tmp`);
        try { await writeFile(temp, text, { flag: 'wx' }); await rename(temp, target); }
        catch (error) { await unlink(temp).catch(() => {}); throw error; }
      }
      this.changed();
      return { name, revision: createHash('sha256').update(text).digest('hex') };
    });
  }
  async resourceLocation(resource) {
    if (privatePath(resource.path)) throw invalid('Private files cannot be linked in the library.');
    const root = resource.repositoryProjectId ? await this.root(resource.repositoryProjectId, resource.repositoryId || 'primary') : await realpath(path.join(this.repo, resource.kind === 'process' ? 'processes' : resource.kind));
    const actual = await realpath(path.resolve(resource.repositoryProjectId ? root : this.repo, resource.path));
    if (!within(root, actual) || !(await stat(actual)).isFile()) throw invalid('Resource leaves its source folder.');
    return actual;
  }
  async linkDocument({ projectId, path: relative, title }) {
    const project = await this.get(projectId);
    if (typeof relative !== 'string' || path.isAbsolute(relative) || privatePath(relative) || !relative.endsWith('.md')) throw invalid('Link a repository-relative Markdown document.');
    const resource = { id: randomUUID(), kind: 'knowledge', path: relative, title: String(title || path.basename(relative)).slice(0, 160), projectId, repositoryProjectId: projectId, repositoryId: project.repositories[0]?.id };
    await this.resourceLocation(resource);
    return this.editWorkspace(registry => {
      registry.resources ||= [];
      if (registry.resources.some(item => item.repositoryProjectId === projectId && item.path === relative)) throw invalid('This document is already linked.');
      registry.resources.push(resource); return resource;
    });
  }
  async importResource({ kind, projectId, source }) {
    if (!['knowledge', 'process', 'inbox'].includes(kind)) throw invalid('Choose Knowledge, Processes or Inbox.');
    if (projectId) await this.get(projectId);
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw invalid('Choose a file in Explorer.');
    const actual = await realpath(source);
    const info = await stat(actual);
    if (!info.isFile() || info.size > 1024 * 1024 * 1024 || privatePath(path.basename(actual))) throw invalid('Choose a regular, non-private file under 1 GB.');
    const root = path.join(this.repo, kind === 'process' ? 'processes' : kind);
    const destination = projectId && kind !== 'inbox' ? path.join(root, 'projects', projectId) : root;
    await mkdir(destination, { recursive: true });
    if (!within(await realpath(root), await realpath(destination))) throw invalid('Library folder leaves the Hub.');
    const extension = path.extname(actual), stem = path.basename(actual, extension);
    for (let index = 0; index < 10000; index++) {
      const target = path.join(destination, index ? `${stem} (${index + 1})${extension}` : path.basename(actual));
      try {
        await copyFile(actual, target, constants.COPYFILE_EXCL);
        const relative = path.relative(this.repo, target).replaceAll('\\', '/');
        if (kind === 'inbox' && projectId) return this.assignResource({ kind, path: relative, projectId });
        this.changed();
        return { id: relative, kind, path: relative, title: path.basename(target), projectId: projectId || null };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw invalid('Too many files with this name.');
  }
  async searchResources(kind, projectId, query = '') {
    const term = String(query).trim().toLowerCase().slice(0, 200);
    const matches = [];
    for (const resource of (await this.resources(kind, projectId, 'relevant')).slice(0, 300)) {
      const label = `${resource.title} ${resource.path}`.toLowerCase();
      if (!term || label.includes(term)) { matches.push(resource); continue; }
      try {
        const { text } = await this.readResource(kind, resource.id, projectId);
        const offset = text.toLowerCase().indexOf(term);
        if (offset >= 0) matches.push({ ...resource, excerpt: text.slice(Math.max(0, offset - 100), offset + 240) });
      } catch { /* Missing or private links never become context. */ }
      if (matches.length >= 80) break;
    }
    return matches.slice(0, 80);
  }
}
