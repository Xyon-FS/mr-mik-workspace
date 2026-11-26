import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

export function graphicalFixture({ approval = false, completeBeforeResponse = false, sandboxStatus = 'unavailable', threadStatus = 'idle', modelCatalogue = null, turnHistory = null, echoFullInput = false } = {}) {
  const calls = [], children = [], history = new Map();
  const spawnChild = (_file, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    children.push(child); child.args = args; child.options = options;
    child.notify = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n');
    child.request = (id, method, params) => child.stdout.write(JSON.stringify({ id, method, params }) + '\n');
    let threadId, settings;
    const finish = () => { if (child.closed) return; child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('exit', 0); };
    child.kill = finish; child.stdin.once('finish', finish);
    child.stdin.on('data', buffer => {
      for (const line of buffer.toString().trim().split('\n')) {
        const message = JSON.parse(line); calls.push(message);
        if (message.id === 900 && message.result) {
          child.notify('serverRequest/resolved', { threadId, requestId: 900 }); child.finishTurn?.();
        }
        if (!message.method || message.id == null) continue;
        let result = {};
        if (message.method === 'thread/start' || message.method === 'thread/resume' || message.method === 'thread/fork') {
          const parentTurns = turnHistory?.get(message.params.threadId);
          threadId = message.method === 'thread/resume' ? message.params.threadId : randomUUID();
          history.set(threadId, history.get(threadId) || []);
          if (message.method === 'thread/fork' && parentTurns) {
            const anchor = message.params.beforeTurnId || message.params.lastTurnId;
            const index = parentTurns.findIndex(turn => turn.id === anchor);
            if (anchor && index < 0) { child.stdout.write(JSON.stringify({ id: message.id, error: { message: 'Unknown fork anchor' } }) + '\n'); continue; }
            turnHistory.set(threadId, structuredClone(anchor ? parentTurns.slice(0, index + (message.params.beforeTurnId ? 0 : 1)) : parentTurns));
          }
          result = { thread: { id: threadId, historyMode: 'legacy', status: { type: threadStatus } }, model: message.params.model || 'fixture-model', approvalPolicy: message.params.approvalPolicy || 'on-request', approvalsReviewer: message.params.approvalsReviewer || 'user', sandbox: { type: message.params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'readOnly' } };
          settings = { approvalPolicy: result.approvalPolicy || 'on-request', approvalsReviewer: result.approvalsReviewer || 'user', sandboxPolicy: result.sandbox };
        } else if (message.method === 'thread/read') {
          const id = history.has(message.params.threadId) ? message.params.threadId : threadId;
          result = { thread: { id, status: { type: 'idle' }, agentNickname: id === threadId ? null : 'Fixture agent', agentRole: id === threadId ? null : 'explorer', turns: message.params.includeTurns === false ? undefined : turnHistory?.get(id) || [{ items: history.get(id) || [] }] } };
        }
        else if (message.method === 'windowsSandbox/readiness') result = { status: sandboxStatus };
        else if (message.method === 'windowsSandbox/setupStart') result = { started: true };
        else if (message.method === 'collaborationMode/list') result = { data: [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' }] };
        else if (message.method === 'thread/settings/update') { settings = { ...settings, ...message.params }; child.notify('thread/settings/updated', { threadId, threadSettings: settings }); }
        else if (message.method === 'turn/steer') { result = { turnId: message.params.expectedTurnId }; child.notify('item/completed', { threadId, turnId: message.params.expectedTurnId, item: { id: message.params.clientUserMessageId, type: 'userMessage', content: message.params.input } }); }
        else if (message.method === 'account/rateLimits/read') result = { rateLimits: { limitName: 'Codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null } };
        else if (['thread/compact/start', 'review/start'].includes(message.method)) {
          const turn = { id: randomUUID(), status: 'inProgress' }, compact = message.method === 'thread/compact/start';
          const item = { id: randomUUID(), type: compact ? 'contextCompaction' : 'enteredReviewMode', review: 'Review working changes' };
          child.notify('turn/started', { threadId, turn }); child.notify('item/started', { threadId, turnId: turn.id, item });
          child.finishOperation = status => {
            child.notify('item/completed', { threadId, turnId: turn.id, item: compact ? item : { ...item, type: 'exitedReviewMode', review: 'Fixture review: no actionable findings.' } });
            child.notify('turn/completed', { threadId, turn: { ...turn, status: status || 'completed' } });
          };
          if (completeBeforeResponse) child.finishOperation(); else if (!approval) setTimeout(() => child.finishOperation(), 10);
          result = compact ? {} : { turn, reviewThreadId: threadId };
        }
        else if (message.method === 'turn/interrupt') child.interruptTurn?.();
        else if (message.method === 'model/list') result = { data: modelCatalogue || ['fixture-model', 'fixture-alternate'].map(model => ({ model, displayName: model === 'fixture-model' ? 'Fixture model' : 'Fixture alternate', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] })) };
        else if (message.method === 'turn/start') {
          const turn = { id: randomUUID(), status: 'inProgress' };
          const user = { id: randomUUID(), type: 'userMessage', content: echoFullInput ? message.params.input : [{ type: 'text', text: message.params.input[0].text }] };
          const agent = { id: randomUUID(), type: 'agentMessage', text: 'Fixture streamed answer.', status: 'completed' };
          child.notify('turn/started', { threadId, turn }); child.notify('item/completed', { threadId, turnId: turn.id, item: user });
          child.notify('item/started', { threadId, turnId: turn.id, item: { ...agent, text: '', status: 'inProgress' } });
          child.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: agent.id, delta: agent.text });
          history.set(threadId, [...history.get(threadId), user, agent]);
          if (approval) child.request(900, 'item/commandExecution/requestApproval', { threadId, turnId: turn.id, command: 'fixture-command', reason: 'Synthetic approval check' });
          const complete = () => { child.notify('item/completed', { threadId, turnId: turn.id, item: agent }); child.notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } }); };
          child.finishTurn = complete;
          child.interruptTurn = () => child.notify('turn/completed', { threadId, turn: { ...turn, status: 'interrupted' } });
          if (completeBeforeResponse) complete(); else if (!approval) setTimeout(complete, 10);
          result = { turn };
        }
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
      }
    });
    return child;
  };
  return { spawnChild, calls, children, history, setSandboxStatus(value) { sandboxStatus = value; } };
}
