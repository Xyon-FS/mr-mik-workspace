import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, mkdir, open, unlink, rmdir } from 'node:fs/promises';
import { within } from './util.mjs';
import { resolveConversationMedia } from './conversation-media.mjs';
import { messageResults } from './chat-results.mjs';
import { resolveChatFileLink } from './chat-file-link.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const privatePath = value => value.split(/[\\/]/).some(part => part.startsWith('.') || /^(auth|credentials|tokens?)\./i.test(part));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function resolveChatCardOutput({ repo, projects, session, runtime, input }) {
  if (session.chatInterface !== 'chat' || !runtime || !['codex', 'claude'].includes(session.agent)) throw invalid('Open a Codex or Claude graphical chat first.');
  if (input.runtimeId && input.runtimeId !== runtime.runtimeId) throw invalid('The conversation changed. Reopen this output.');
  if (typeof input.itemId !== 'string' || !input.itemId) throw invalid('Choose a recorded chat output.');
  await runtime.ensureHistoryItem?.(input.itemId);
  const item = runtime.items.get(input.itemId) || runtime.historyItems.get(input.itemId);
  if (!item || item.status === 'inProgress') throw invalid('Wait for this output to finish, then reopen it.');
  const source = { agent: session.agent, sessionId: session.id, itemId: item.id, savedAt: new Date().toISOString() };
  if (input.resultIndex !== undefined) {
    if (!Number.isInteger(input.resultIndex) || input.resultIndex < 0) throw invalid('Choose a recorded output block.');
    const result = messageResults(item).find(result => result.index === input.resultIndex && result.type === 'code');
    if (!result || result.revision !== input.resultRevision) throw invalid('The output changed. Refresh the output list.');
    if (Buffer.byteLength(result.text) > 100000) throw invalid('Choose an output under 100 KB.');
    const fence = '`'.repeat(Math.max(3, ...[...result.text.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const text = `${fence}${result.language || 'text'}\n${result.text}\n${fence}\n`;
    return { name: result.title, mode: 'snapshot', text, revision: digest(text), source };
  }
  if (input.message === true) {
    if (item.type !== 'agentMessage' || typeof item.text !== 'string' || !item.text.trim() || Buffer.byteLength(item.text) > 100000) throw invalid('Choose a completed response under 100 KB.');
    return { name: 'Response note', mode: 'snapshot', text: item.text, revision: digest(item.text), source };
  }
  const reference = typeof input.href === 'string' ? input.href : input.kind === 'change' ? item.changes?.[input.index]?.path : Number.isInteger(input.index) ? item.attachments?.[input.index]?.path : item.path;
  if (typeof reference !== 'string' || reference.length > 8192 || /[\x00-\x1f]/.test(reference) || /^[a-z]+:/i.test(reference) && !/^file:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) throw invalid('Choose a local output file.');
  const resolved = typeof input.href === 'string' ? resolveChatFileLink(session.cwd, reference).file : path.resolve(session.cwd, reference);
  const actual = (session.nativeId ? await resolveConversationMedia(repo, projects.stateDir, session.agent, session.nativeId, resolved) : null) || await realpath(resolved);
  const info = await stat(actual);
  if (!info.isFile() || input.action !== 'open' && info.size > 32 * 1024 * 1024) throw invalid('Choose an output file under 32 MB.');
  const hub = await realpath(repo), cwd = await realpath(session.cwd);
  if (![hub, cwd].some(root => within(root, actual)) && !runtime.previewPaths.has(actual)) throw invalid('This file is outside this chat’s preview locations.');
  if (input.action === 'open') {
    if (/(?:^|[\\/])(?:\.env|auth\.json|credentials)(?:[\\/.]|$)/i.test(actual)) throw invalid('Private files are unavailable for preview.');
    return { name: path.basename(actual), mode: 'live', actual, source };
  }
  if (privatePath(actual)) throw invalid('Save this output in a non-private Hub or project folder before adding it to a card.');
  let location;
  if (within(hub, actual)) location = { scope: 'hub', path: path.relative(hub, actual).replaceAll('\\', '/') };
  else if (session.projectId) {
    const project = await projects.get(session.projectId);
    for (const repository of project.repositories.filter(value => value.available)) {
      const root = await projects.root(project.id, repository.id);
      if (within(root, actual)) { location = { repositoryId: repository.id, path: path.relative(root, actual).replaceAll('\\', '/') }; break; }
    }
  }
  if (!location) throw invalid('Link this file’s folder to the current project before saving it to a card.');
  return { name: path.basename(actual), mode: 'live', actual, location, revision: digest(await readFile(actual)), source };
}

export async function saveChatCardOutput({ projects, session, output, input, assertCurrent = () => {} }) {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw invalid('Choose an output title of up to 160 characters.');
  if (input.revision !== output.revision) throw Object.assign(new Error('This output changed. Reopen it before saving; nothing was added.'), { status: 409 });
  if (input.requestId != null && !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw invalid('Choose a valid save request.');
  const projectId = session.projectId || null;
  if (projectId) await projects.get(projectId);
  let createdFile, createdFolder;
  try {
    return await projects.editWorkspace(async registry => {
      assertCurrent();
      const retried = input.requestId && registry.entities.find(card => (card.projectId || null) === projectId && [...(card.steps || []), ...(card.artifacts || [])].some(value => value.source?.saveId === input.requestId && value.source?.sessionId === session.id));
      if (retried) return { cardId: retried.id, title: retried.title, duplicate: true, mode: output.mode };
      let card = input.cardId && registry.entities.find(value => value.id === input.cardId && (value.projectId || null) === projectId && value.status !== 'archived');
      if (input.cardId && !card) throw invalid('Choose an available card in this project.');
      if (!card) {
        if (typeof input.cardTitle !== 'string' || !input.cardTitle.trim() || input.cardTitle.length > 160) throw invalid('Choose a new card title of up to 160 characters.');
        const id = randomUUID(), today = new Date().toISOString().slice(0, 10);
        card = { id, title: input.cardTitle.trim(), description: '', projectId, repositoryId: null, type: 'group', category: 'project', created: today, updated: today, folder: `${today}_${id}`, steps: [], status: 'active' };
        registry.entities.push(card);
      }
      const provenance = { ...output.source, revision: output.revision, mode: output.mode, ...(input.requestId ? { saveId: input.requestId } : {}) };
      let duplicate = false;
      if (output.mode === 'live') {
        card.artifacts ||= [];
        duplicate = card.artifacts.some(value => (value.scope || 'repository') === (output.location.scope || 'repository') && value.repositoryId === output.location.repositoryId && value.path.toLowerCase() === output.location.path.toLowerCase());
        if (!duplicate) card.artifacts.push({ projectId, ...output.location, title: input.title.trim(), source: provenance });
      } else {
        card.steps ||= [];
        duplicate = card.steps.some(value => value.source?.sessionId === session.id && value.source?.itemId === output.source.itemId && value.source?.revision === output.revision);
        if (!duplicate) {
          const root = await realpath(path.join(projects.repo, 'workspace')), folder = path.resolve(root, card.folder);
          if (!within(root, folder) || privatePath(card.folder)) throw invalid('Invalid card folder.');
          let ancestor = folder;
          while (!(await stat(ancestor).catch(() => null))) ancestor = path.dirname(ancestor);
          if (!within(root, await realpath(ancestor))) throw invalid('Card folder leaves the Workspace.');
          if (await mkdir(folder, { recursive: true })) createdFolder = folder;
          if (!within(root, await realpath(folder))) throw invalid('Card folder leaves the Workspace.');
          const relative = `response-${randomUUID()}.md`;
          const target = path.join(folder, relative), handle = await open(target, 'wx');
          createdFile = target;
          try { await handle.writeFile(output.text); } finally { await handle.close(); }
          card.steps.push({ name: input.title.trim(), path: relative, source: provenance });
        }
      }
      card.updated = new Date().toISOString().slice(0, 10);
      assertCurrent();
      return { cardId: card.id, title: card.title, duplicate, mode: output.mode };
    });
  } catch (error) {
    const cleanupErrors = [];
    if (createdFile) await unlink(createdFile).catch(cleanup => { if (cleanup.code !== 'ENOENT') cleanupErrors.push(cleanup); });
    if (createdFolder) await rmdir(createdFolder).catch(cleanup => { if (cleanup.code !== 'ENOENT') cleanupErrors.push(cleanup); });
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Saving failed and its temporary content could not be completely removed.');
    throw error;
  }
}
