import path from 'node:path';
import { mkdir, lstat, realpath, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { within } from './util.mjs';

const fail = message => { throw new Error(message); };
const revision = bytes => createHash('sha256').update(bytes).digest('hex');
const safeRelative = value => typeof value === 'string' && !!value && !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => !part || part === '..' || part.startsWith('.') || /^(auth|credentials|tokens?)\./i.test(part));

// Directory preparation and metadata registration only. Never writes document bytes.
export class HubFiles {
  constructor(projects, registry) { Object.assign(this, { projects, registry }); }
  async folder(base, relative = '') {
    const root = await realpath(base);
    const hub = await realpath(this.projects.repo);
    if (within(path.resolve(this.projects.repo), path.resolve(base)) && !within(hub, root)) fail('Choose a Hub folder that does not link outside the Hub.');
    let folder = root;
    for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
      if (segment === '..') fail('Choose a destination inside the Hub.');
      folder = path.join(folder, segment);
      let info = await lstat(folder).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!info) { await mkdir(folder); info = await lstat(folder); }
      if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await realpath(folder))) fail('Choose a regular Hub destination folder.');
    }
    return folder;
  }
  async prepare(grant, args) {
    const { kind, title, scope = 'workspace' } = args;
    if (!['card', 'knowledge', 'process', 'context', 'skill'].includes(kind)) fail('Choose a supported Hub content kind.');
    const projectId = scope === 'global' ? null : grant.projectId;
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 160)) fail('Choose a short content title.');
    const plan = { kind, projectId, title, agent: grant.agent };
    if (kind === 'card') {
      const card = (await this.registry()).entities.find(item => item.id === (args.id || grant.cardId) && (item.projectId || null) === grant.projectId);
      if (!card || !safeRelative(card.folder)) fail('Choose a card in this workspace.');
      plan.cardId = card.id; plan.cardFolder = card.folder;
      plan.folder = await this.folder(path.join(this.projects.repo, 'workspace'), card.folder);
      if (!args.path && !title) return { plan: null, value: { path: plan.folder, directory: true, cardId: card.id,
        pages: (card.steps || []).filter(step => safeRelative(step.path)).map(step => ({ title: step.name, path: path.join(plan.folder, step.path), relativePath: step.path })),
        sharedAssets: path.join(this.projects.repo, 'workspace', '_shared'), instruction: 'Browse/read with native CLI tools. Resolve this card again with path for an existing page or title for a new page before writing. Never bypass a permission denial.' } };
      if (args.path) {
        if (!safeRelative(args.path) || !card.steps?.some(step => step.path === args.path)) fail('Choose a registered card page or note.');
        plan.relative = args.path;
      } else {
        if (!title) fail('Choose a title for the new card page or note.');
        plan.relative = `${randomUUID()}.${args.format === 'markdown' ? 'md' : 'html'}`;
      }
    } else if (kind === 'knowledge' || kind === 'process') {
      if (args.id) {
        const resource = (await this.projects.resources(kind, grant.projectId, 'relevant')).find(item => item.id === args.id && !item.repositoryProjectId);
        if (!resource) fail('Choose a Hub-owned resource in this workspace.');
        if (resource.projectId == null && grant.projectId && scope !== 'global') fail('Choose Global explicitly for a shared resource.');
        plan.projectId = resource.projectId || null;
        plan.resourceId = resource.id;
        const file = await this.projects.resourceLocation(resource);
        plan.folder = path.dirname(file); plan.relative = path.basename(file); plan.resourcePath = resource.path;
      } else {
        if (!title) fail('Choose a title for the new resource.');
        const base = path.join(this.projects.repo, kind === 'process' ? 'processes' : 'knowledge');
        plan.folder = await this.folder(base, projectId ? `projects/${projectId}` : '');
        plan.relative = `${randomUUID()}.md`;
        plan.resourcePath = path.relative(await realpath(this.projects.repo), path.join(plan.folder, plan.relative)).split(path.sep).join('/');
      }
    } else if (kind === 'context') {
      if (args.confirmed !== true) fail('Obtain explicit user approval before changing global Context.');
      if (!/^[a-z0-9][a-z0-9-]*\.md$/i.test(args.name || '')) fail('Choose a Context Markdown filename.');
      plan.folder = await this.folder(path.join(this.projects.repo, 'context')); plan.relative = args.name;
    } else {
      if (args.confirmed !== true) fail('Obtain explicit user approval before authoring a skill.');
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.name || '') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(args.name)) fail('Choose a valid skill folder name.');
      plan.name = args.name; plan.target = args.target || 'hub';
      plan.repositoryId = args.repositoryId || grant.repositoryId;
      const base = plan.target === 'linked' ? await this.projects.root(grant.projectId, plan.repositoryId) : this.projects.repo;
      plan.folder = await this.folder(base, `${grant.agent === 'claude' ? '.claude' : grant.agent === 'opencode' && plan.target === 'linked' ? '.opencode' : '.agents'}/skills/${args.name}`);
      plan.relative = 'SKILL.md';
    }
    plan.file = path.join(plan.folder, plan.relative);
    const info = await lstat(plan.file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info && (!info.isFile() || info.isSymbolicLink() || !within(plan.folder, await realpath(plan.file)))) fail('Choose a regular content file inside its destination.');
    if (info && info.size > 2 * 1024 * 1024) fail('Choose a content file under 2 MB.');
    plan.existing = !!info;
    return { plan, value: { path: plan.file, exists: plan.existing, revision: info ? revision(await readFile(plan.file)) : null, maxBytes: kind === 'context' ? 100 * 1024 : kind === 'skill' ? 128 * 1024 : 2 * 1024 * 1024, cardId: plan.cardId, sharedAssets: kind === 'card' ? path.join(this.projects.repo, 'workspace', '_shared') : undefined,
      instruction: 'Read/write this file with native CLI tools. Respect permission denials; do not use a Bridge content-writing fallback. Do not edit internal registries. After a successful write, register the destination ID; no document content is needed.' } };
  }
  async register(grant, plan) {
    const info = await lstat(plan.file);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(plan.folder) !== plan.folder || !within(plan.folder, await realpath(plan.file)) || !info.size || info.size > 2 * 1024 * 1024) fail('Choose a regular authored file under 2 MB.');
    const bytes = await readFile(plan.file);
    if (plan.kind === 'context' && bytes.length > 100 * 1024) fail('Choose a Context file under 100 KB.');
    if (plan.kind === 'card') {
      if (!/\.(html|md)$/i.test(plan.relative) || /\.html$/i.test(plan.relative) && !/<html[\s>]/i.test(bytes.toString('utf8'))) fail('Choose a complete HTML page or Markdown note.');
      return this.projects.editWorkspace(registry => {
        const card = registry.entities.find(item => item.id === plan.cardId && (item.projectId || null) === grant.projectId && item.folder === plan.cardFolder);
        if (!card) fail('Card association changed. Resolve its destination again.');
        card.steps ||= [];
        if (!card.steps.some(step => step.path === plan.relative)) card.steps.push({ name: plan.title, path: plan.relative });
        card.updated = new Date().toISOString().slice(0, 10);
        return { id: card.id, path: plan.relative, registered: true, revision: revision(bytes) };
      });
    }
    if (plan.kind === 'knowledge' || plan.kind === 'process') {
      const current = (await this.projects.resources(plan.kind, grant.projectId, 'all')).find(item => !item.repositoryProjectId && item.path === plan.resourcePath);
      if (current && (current.projectId || null) !== plan.projectId || plan.resourceId && (!current || current.id !== plan.resourceId)) fail('Choose the resource again: its association changed.');
      return this.projects.assignResource({ kind: plan.kind, path: plan.resourcePath, projectId: plan.projectId, title: plan.title });
    }
    if (plan.kind === 'skill') {
      const source = bytes.toString('utf8'), frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      if (!frontmatter || !/^name:\s*\S/m.test(frontmatter) || !/^description:\s*\S/m.test(frontmatter) || bytes.length > 128 * 1024) fail('Choose a SKILL.md under 128 KB with YAML name and description.');
      if (plan.target === 'hub' && !plan.existing) await this.projects.setHubSkillScope({ id: plan.name, agent: plan.agent, scope: plan.projectId ? 'project' : 'global', projectId: plan.projectId, enabled: true });
    }
    this.projects.changed();
    return { kind: plan.kind, path: plan.file, registered: true, revision: revision(bytes) };
  }
}

export async function hubContentDirectories(projects, cards, projectId) {
  const roots = [];
  for (const card of cards.filter(item => (item.projectId || null) === (projectId || null))) {
    if (!safeRelative(card.folder)) continue;
    const workspace = await realpath(path.join(projects.repo, 'workspace'));
    if (!within(await realpath(projects.repo), workspace)) continue;
    const folder = path.resolve(workspace, card.folder);
    const actual = await realpath(folder).catch(() => null);
    if (actual && within(workspace, actual) && (await lstat(folder)).isDirectory() && !(await lstat(folder)).isSymbolicLink()) roots.push(actual);
  }
  // Do not grant the Hub root, registries, authentication or chat state.
  // Newly created destinations outside these existing roots use native approval.
  if (projectId) for (const name of ['knowledge', 'processes']) {
    const base = await realpath(path.join(projects.repo, name)).catch(() => null);
    const folder = base && await realpath(path.join(base, 'projects', projectId)).catch(() => null);
    if (folder && within(await realpath(projects.repo), base) && within(base, folder)) roots.push(folder);
  }
  return [...new Set(roots)];
}
