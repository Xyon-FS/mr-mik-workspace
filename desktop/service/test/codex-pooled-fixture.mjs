import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

export function pooledCodexFixture({ nativeAccount = null, nativeConfig, holdMethods = [], nativeSandboxStatus = 'ready' } = {}) {
  const children = [], calls = [], threads = new Map(), approvals = new Map(); let requestId = 900;
  const spawnChild = (_file, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: children.length + 1, args, options, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    children.push(child);
    child.holdMethods = new Set(holdMethods); child.heldReplies = new Map();
    child.releaseReplies = method => {
      child.holdMethods.delete(method);
      for (const reply of child.heldReplies.get(method) || []) queueMicrotask(reply);
      child.heldReplies.delete(method);
    };
    const notify = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n');
    child.notify = notify;
    child.approve = threadId => {
      const id = requestId++, thread = threads.get(threadId); approvals.set(id, threadId);
      child.stdout.write(JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: thread.turns.at(-1)?.id, command: 'synthetic' } }) + '\n');
      return id;
    };
    const exit = () => { if (child.closed) return; child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('exit', 0); };
    child.kill = exit; child.stdin.once('finish', exit);
    child.stdin.on('data', buffer => {
      for (const line of buffer.toString().trim().split('\n')) {
        const message = JSON.parse(line); calls.push(message);
        if (!message.method) {
          const threadId = approvals.get(message.id); approvals.delete(message.id);
          if (threadId) notify('serverRequest/resolved', { threadId, requestId: message.id });
          continue;
        }
        const p = message.params || {}; let result = {};
        if (message.method === 'thread/read' && p.includeTurns && child.rejectFullHistory) {
          queueMicrotask(() => { if (!child.closed) child.stdout.write(JSON.stringify({ id: message.id, error: { message: 'list_turns is not supported yet' } }) + '\n'); });
          continue;
        }
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
          const id = message.method === 'thread/resume' ? p.threadId : randomUUID();
          const policy = { approvalPolicy: p.approvalPolicy || 'on-request', approvalsReviewer: p.approvalsReviewer || 'user', sandbox: { type: p.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite', writableRoots: [p.cwd], networkAccess: false } };
          const thread = threads.get(id) || { id, status: { type: 'idle' }, turns: [], historyMode: 'legacy' };
          threads.set(id, thread); thread.params = p; thread.settings = { ...policy, model: p.model || 'fixture-model', effort: 'medium', sandboxPolicy: policy.sandbox };
          result = { ...policy, model: thread.settings.model, thread: { ...thread } };
        } else if (message.method === 'thread/read') result = { thread: { ...threads.get(p.threadId), turns: p.includeTurns ? threads.get(p.threadId)?.turns : undefined } };
        else if (message.method === 'thread/turns/list') result = { data: [...(threads.get(p.threadId)?.turns || [])].reverse() };
        else if (message.method === 'thread/unsubscribe') { threads.get(p.threadId).unsubscribed = true; result = { status: child.rejectDetach ? 'unknown' : 'unsubscribed' }; }
        else if (message.method === 'thread/loaded/list') result = { data: [...threads.values()].filter(thread => !thread.unsubscribed || child.deferUnload && thread.id === child.deferUnload).map(thread => thread.id) };
        else if (message.method === 'windowsSandbox/readiness') result = { status: nativeSandboxStatus };
        else if (message.method === 'collaborationMode/list') result = { data: [{ mode: 'default' }, { mode: 'plan' }] };
        else if (message.method === 'model/list') result = { data: ['fixture-model', 'fixture-alternate'].map(model => ({ model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] })) };
        else if (message.method === 'thread/settings/update') { const thread = threads.get(p.threadId); Object.assign(thread.settings, p); notify('thread/settings/updated', { threadId: p.threadId, threadSettings: thread.settings }); }
        else if (message.method === 'turn/start') {
          const thread = threads.get(p.threadId), turn = { id: randomUUID(), status: 'inProgress', items: [] };
          thread.turns.push(turn); thread.status = { type: 'active' };
          notify('turn/started', { threadId: p.threadId, turn });
          notify('item/completed', { threadId: p.threadId, turnId: turn.id, item: { id: randomUUID(), type: 'userMessage', content: p.input } });
          result = { turn };
        } else if (message.method === 'turn/steer') {
          result = { turnId: p.expectedTurnId };
          notify('item/completed', { threadId: p.threadId, turnId: p.expectedTurnId, item: { id: p.clientUserMessageId, type: 'userMessage', content: p.input } });
        } else if (message.method === 'turn/interrupt') {
          const thread = threads.get(p.threadId), turn = thread.turns.find(turn => turn.id === p.turnId);
          if (turn && !child.ignoreInterrupt) { turn.status = 'interrupted'; thread.status = { type: 'idle' }; notify('turn/completed', { threadId: p.threadId, turn }); }
        } else if (message.method === 'account/read') result = { account: nativeAccount };
        else if (message.method === 'config/read' && nativeConfig) result = { config: nativeConfig(options) };
        else if (message.method === 'skills/list') result = { data: p.cwds.map(cwd => ({ cwd, skills: [], errors: [] })) };
        if (message.id != null && !(child.holdStarts && message.method === 'thread/start')) {
          const reply = () => { if (!child.closed) child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'); };
          if (child.holdMethods.has(message.method)) { if (!child.heldReplies.has(message.method)) child.heldReplies.set(message.method, []); child.heldReplies.get(message.method).push(reply); }
          else queueMicrotask(reply);
        }
      }
    });
    return child;
  };
  return { spawnChild, children, calls, threads };
}
