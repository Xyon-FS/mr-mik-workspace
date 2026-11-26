import { randomUUID } from 'node:crypto';
import { claudeAttachmentInput } from './claude-chat-attachments.mjs';
import { projectClaudeHistory } from './claude-history-projection.mjs';

const plainUser = message => message.type === 'user' && (typeof message.message?.content === 'string' || message.message?.content?.some(block => block.type !== 'tool_result'));
const sameContent = (a, b) => a.type === b.type && JSON.stringify(a.message?.content) === JSON.stringify(b.message?.content);
export async function prepareClaudeMessageAction(runtime, itemId, kind) {
  const observedState = runtime.protocol.snapshot(), native = await runtime.history.read();
  const projected = projectClaudeHistory(native), observedItems = new Map([...(runtime.historyMetadata || []), ...observedState.items.map(item => [item.id, item])]);
  const state = { ...observedState, items: projected.items.map(item => ({ ...item, ...(observedItems.get(item.id) || {}), turnId: item.turnId })), turns: projected.turns };
  const item = state.items.find(value => value.id === itemId);
  if (!item && observedItems.has(itemId)) throw new Error('The displayed response and native boundary differ. Reload or continue in CLI.');
  const turn = state.turns.find(value => value.id === item?.turnId), turnIndex = state.turns.indexOf(turn);
  if (!item || turn?.completedAt == null || !['completed', 'failed', 'interrupted'].includes(turn.status) || kind === 'edit' && item.type !== 'userMessage' || kind !== 'edit' && item.type !== 'agentMessage') throw new Error('Choose a settled input or final response.');
  const rows = state.items.filter(value => value.turnId === turn.id);
  if (kind !== 'edit' && rows.filter(value => value.type === 'agentMessage').at(-1)?.id !== item.id) throw new Error('Choose the final response of this turn.');
  const users = rows.filter(value => value.type === 'userMessage');
  if (users.length !== 1) throw new Error('This turn cannot be reproduced as one input.');
  const user = users[0];
  const userUuid = user.nativeUuid || user.id, inputIndex = native.findIndex(value => value.uuid === userUuid && plainUser(value));
  if (inputIndex < 0) throw new Error('This message has no verified native identity. Older display history may need CLI continuation.');
  const next = native.findIndex((value, index) => index > inputIndex && plainUser(value));
  const end = next < 0 ? native.length : next;
  const nativeTurn = native.slice(inputIndex, end);
  const last = nativeTurn.at(-1);
  if (last?.type !== 'assistant' || !['end_turn', 'stop_sequence'].includes(last.message?.stop_reason)) throw new Error('This native turn has no supported settled assistant boundary. Continue in CLI for interrupted, structured-output or tool-ending turns.');
  const final = rows.filter(value => value.type === 'agentMessage').at(-1);
  if (final && !final.nativeUuid && last.message?.id) {
    const blockIndex = Number(final.id.slice(final.id.lastIndexOf(':') + 1));
    if (Number.isInteger(blockIndex) && last.message.content?.[blockIndex]?.type === 'text' && final.id === `${last.message.id}:${blockIndex}`) final.nativeUuid = last.uuid;
  }
  if (!final?.nativeUuid || final.nativeUuid !== last.uuid) throw new Error('The displayed response and native boundary differ. Reload or continue in CLI.');
  // Every ordinary native input must correspond to an observed display turn.
  // Unknown appends/queued inputs cannot silently disappear during a retry.
  const observed = new Set(observedState.items.filter(value => value.type === 'userMessage').map(value => value.nativeUuid || value.id));
  const firstObserved = native.findIndex(value => plainUser(value) && observed.has(value.uuid));
  if (firstObserved < 0 || native.some((value, index) => index >= firstObserved && plainUser(value) && !observed.has(value.uuid))) throw new Error('Native history contains unobserved input. Continue in CLI before branching.');
  const keepCount = kind === 'branch' ? end : inputIndex;
  const kept = native.slice(0, keepCount);
  if (kept.length && kept.at(-1).type !== 'assistant') throw new Error('The previous native turn boundary is unsupported.');
  let text = '', attachments = [];
  if (kind !== 'branch') {
    if (user.composerContext?.length) throw new Error('This input has explicit skill or quoted context. Branch after its response and select context again before editing or retrying.');
    text = user.text; attachments = user.attachments || [];
    const prepared = await claudeAttachmentInput(text, attachments);
    const original = native[inputIndex].message.content;
    if (JSON.stringify(prepared.blocks) !== JSON.stringify(typeof original === 'string' ? [{ type: 'text', text: original }] : original)) throw new Error('The original native input cannot be restored faithfully. Attach changed files or unsupported context manually in a new branch.');
  }
  const turns = state.turns.slice(0, turnIndex + (kind === 'branch' ? 1 : 0)), ids = new Set(turns.map(value => value.id));
  return { native, kept, anchor: kept.at(-1)?.uuid, fresh: !kept.length, seed: { state: { ...state, items: state.items.filter(value => ids.has(value.turnId)), turns, requests: [], uncertain: false, error: '', status: 'closed' }, draft: text, attachments, previewPaths: [...runtime.previewPaths] } };
}

export async function createClaudeMessageBranch({ sessions, source, itemId, kind, record, sessionOptions = async value => value }) {
  const runtime = source.graphical;
  if (source.process !== runtime || !runtime.idle() || source.stopping || source.toolUpdating || source.switchingInterface) throw new Error('Wait for this Claude chat to be idle and connected.');
  if (runtime.pending.pending) throw new Error('Clear the Claude queue before branching this conversation.');
  runtime.messageActionBusy = true; runtime.changed();
  try {
    await sessions.verifyIdentity?.(source);
    const plan = await prepareClaudeMessageAction(runtime, itemId, kind);
    if (source.process !== runtime || runtime.closed || runtime.protocol.state.status !== 'ready') throw new Error('The source changed during preflight. Nothing was sent.');
    let nativeId, messages;
    if (plan.fresh) { nativeId = randomUUID(); messages = []; }
    else {
      const result = await runtime.history.fork(plan.anchor); nativeId = result.nativeId; messages = result.messages; plan.seed.nativeFile = result.file;
      await record({ stage: 'native-fork', nativeId });
      if (!/^[a-f0-9-]{36}$/i.test(nativeId || '') || nativeId === source.nativeId || messages.length !== plan.kept.length || !messages.every((message, index) => sameContent(message, plan.kept[index])) || JSON.stringify(await runtime.history.read()) !== JSON.stringify(plan.native)) throw new Error('The native fork boundary was not confirmed. Its receipt is retained; no prompt was sent.');
    }
    const mapping = new Map(plan.kept.map((message, index) => [message.uuid, messages[index].uuid]));
    for (const item of plan.seed.state.items) {
      const uuid = mapping.get(item.nativeUuid || item.id);
      if (uuid) { item.nativeUuid = uuid; if (item.type === 'userMessage') item.id = uuid; }
    }
    plan.seed.state.sessionId = nativeId;
    plan.seed.state.items = plan.seed.state.items.slice(-2000);
    const visibleTurns = new Set(plan.seed.state.items.map(item => item.turnId));
    plan.seed.state.turns = plan.seed.state.turns.filter(turn => visibleTurns.has(turn.id));
    const options = await sessionOptions({ agent: 'claude', chatInterface: 'chat', accountProfileId: source.accountProfileId || 'system', claudeAccountIdentity: source.claudeAccountIdentity, name: `${kind === 'retry' ? 'Retry' : 'Branch'} · ${source.name}`, projectId: source.projectId, repositoryId: source.repositoryId || 'hub', cardId: source.cardId, cwd: source.cwd, graphicalModel: source.graphicalModel, effort: source.effort, bypass: source.bypass, claudePermissionMode: source.claudePermissionMode, claudeBypassAllowed: source.claudeBypassAllowed, ...(plan.fresh ? {} : { resumeId: nativeId }) });
    // A fresh retry needs a specific new ID too; seed launch supplies no resume.
    const created = await sessions.create({ ...options, nativeId, providerSeed: { ...plan.seed, buildPermissionMode: runtime.buildPermissionMode }, forkParent: { sessionId: source.id, threadId: source.nativeId, itemId, kind } });
    const child = sessions.get(created.id).graphical;
    await record({ stage: 'registered', childId: created.id, nativeId: child.session.nativeId });
    let submitted = false, notice = '';
    if (kind === 'retry') {
      await record({ stage: 'delivery-reserved' });
      try { await child.submit(); submitted = true; }
      catch { notice = 'The new chat retains its input or uncertain delivery state. Review it before sending; it will not be resent automatically.'; child.protocol.state.error = notice; child.changed(); }
    }
    sessions.changed(sessions.get(created.id)); await sessions.persist();
    return { session: sessions.list().find(value => value.id === created.id), submitted, notice };
  } finally { runtime.messageActionBusy = false; runtime.changed(); }
}
