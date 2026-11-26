import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { within } from './util.mjs';

const privateFile = /(?:^|[\\/])(?:\.env(?:\.|$)|auth\.json$|credentials(?:\.|$)|\.ssh(?:[\\/]|$)|\.aws(?:[\\/]|$)|\.codex(?:[\\/]|$))/i;

async function selectedTurn(runtime, item) {
  if (runtime.historyMode !== 'paginated') {
    const result = await runtime.rpc('thread/read', { threadId: runtime.threadId, includeTurns: true });
    return result.thread?.turns?.find(turn => turn.id === item.turnId && turn.items?.some(value => value.id === item.id));
  }
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 30; page++) {
    const result = await runtime.rpc('thread/turns/list', { threadId: runtime.threadId, limit: 100, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    const found = result.data?.find(turn => turn.id === item.turnId && turn.items?.some(value => value.id === item.id));
    if (found) return found;
    if (!result.nextCursor) break;
    if (seen.has(result.nextCursor)) throw new Error('History repeated a page. Reload the conversation before branching.');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
}

export async function prepareMessageAction(runtime, itemId, kind) {
  if (!['branch', 'edit', 'retry'].includes(kind)) throw new Error('Choose branch, edit or retry.');
  const item = runtime.items.get(itemId) || runtime.historyItems.get(itemId);
  if (!item?.turnId || !['userMessage', 'agentMessage'].includes(item.type)) throw new Error('Reload this message with its native turn before branching.');
  if (kind === 'edit' && item.type !== 'userMessage' || kind !== 'edit' && item.type !== 'agentMessage') throw new Error('Choose a matching user message or response.');
  const turn = await selectedTurn(runtime, item);
  if (!turn || !['completed', 'failed', 'interrupted'].includes(turn.status)) throw new Error('This message needs a settled native turn before branching.');
  if (kind !== 'edit' && turn.items.filter(value => value.type === 'agentMessage').at(-1)?.id !== item.id) throw new Error('Branch or retry from the final response of this turn.');
  if (kind === 'branch') return { anchor: { lastTurnId: turn.id }, text: '', paths: [] };
  const users = turn.items.filter(value => value.type === 'userMessage');
  if (users.length !== 1) throw new Error('This turn contains multiple steered inputs. Branch after its final response instead; automatic retry cannot reproduce their timing.');
  const user = users[0];
  if (kind === 'edit' && user.id !== item.id) throw new Error('The selected input is no longer available.');
  if (!Array.isArray(user.content) || user.content.some(part => !['text', 'localImage'].includes(part.type))) throw new Error('This input contains context that cannot be restored faithfully. Branch after the response and attach the context again.');
  let text = user.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (typeof text !== 'string' || text.length > 64000) throw new Error('This input is too large to restore in the composer.');
  const paths = user.content.filter(part => part.type === 'localImage').map(part => part.path);
  const marker = '\n\nAttached paths:\n', offset = text.lastIndexOf(marker);
  if (offset >= 0) {
    let attached;
    try { attached = text.slice(offset + marker.length).split('\n').map(line => JSON.parse(line)); } catch { /* Leave ordinary prose untouched. */ }
    if (attached?.length && attached.every(file => typeof file === 'string' && path.isAbsolute(file))) { paths.push(...attached); text = text.slice(0, offset); }
  }
  const unique = [...new Set(paths)];
  if (unique.length > 100 || !text.trim() && !unique.length) throw new Error('This input cannot be restored as a supported draft.');
  const cwd = await realpath(runtime.session.cwd), checked = [];
  for (const file of unique) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || privateFile.test(file)) throw new Error('A referenced attachment is not available for this branch. Attach it again.');
    const actual = await realpath(file).catch(() => null);
    if (!actual || privateFile.test(actual) || !within(cwd, actual) && !runtime.previewPaths.has(actual) || !(await stat(actual)).isFile()) throw new Error('An attachment is missing or outside the original chat access. Attach it again before retrying.');
    checked.push(actual);
  }
  return { anchor: { beforeTurnId: turn.id }, text, paths: checked };
}

export async function createMessageBranch({ sessions, source, itemId, kind, sessionOptions = async value => value }) {
  const runtime = source.graphical;
  if (source.agent !== 'codex' || source.chatInterface !== 'chat' || source.process !== runtime || !runtime?.idle() || runtime.advanced.queue.length || source.permissionApplying || source.stopping || source.toolUpdating) throw new Error('Wait until this graphical chat is idle and connected before branching.');
  runtime.messageActionBusy = true; runtime.changed();
  try {
    const plan = await prepareMessageAction(runtime, itemId, kind);
    if (source.process !== runtime || runtime.closed || runtime.nativeActive || runtime.turnId || runtime.requests.size) throw new Error('The source chat changed. Retry from its current messages when idle.');
    const options = await sessionOptions({ agent: 'codex', chatInterface: 'chat', graphicalModel: runtime.model || runtime.effective?.model || source.graphicalModel, accountProfileId: source.accountProfileId, name: `${kind === 'retry' ? 'Retry' : 'Branch'} · ${source.name}`, projectId: source.projectId, repositoryId: source.repositoryId || 'hub', cardId: source.cardId, cwd: source.cwd, bypass: source.bypass, codexPermissions: source.codexPermissions, effort: source.effort, resumeId: runtime.threadId, fork: true });
    const created = await sessions.create({ ...options, forkAnchor: plan.anchor, forkParent: { sessionId: source.id, threadId: runtime.threadId, itemId, kind }, initialDraft: plan.text, initialAttachments: plan.paths, initialMode: runtime.advanced.modeIntent || runtime.advanced.modeEffective });
    const child = sessions.get(created.id).graphical;
    let submitted = false, notice = '';
    if (kind === 'retry') {
      try { await child.submit(); submitted = true; }
      catch (error) { child.reportError(error); child.changed(); notice = child.uncertain ? 'Retry delivery is uncertain. Check the new chat; nothing will be resent automatically.' : 'The new chat is ready with the original input. Resolve its error and send when ready.'; }
    }
    sessions.changed(sessions.get(created.id)); await sessions.persist();
    return { session: sessions.list().find(value => value.id === created.id), submitted, notice };
  } finally { runtime.messageActionBusy = false; runtime.changed(); }
}
