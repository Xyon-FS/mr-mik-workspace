// V2 events use data/location, not V1 properties/info. Store only bounded state,
// never reasoning, prompts, tool arguments or credentials.
import path from 'node:path';
import { validSessionId } from './observer.mjs';
import { createStateWriter } from './state-writer.mjs';

const sameDirectory = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
export function createV2Observer({ directory, nativeId, forkParent, chatId, launchId, hasConversation = false, startedAt = Date.now(), save }) {
  let state = { chatId, launchId, nativeId: validSessionId(nativeId) ? nativeId : null, activity: 'idle', completion: null, revision: 0, hasConversation };
  let message = null, text = '', final = false;
  const candidates = new Set();
  const dialogs = new Set();
  let executing = false;
  const emit = patch => { state = { ...state, ...patch, revision: state.revision + 1 }; save(state); };
  const observe = event => {
    if (!event || !Number.isFinite(event.created) || event.created < startedAt) return;
    const data = event.type === 'form.created' ? event.data?.form : event.data;
    if (!data || !validSessionId(data.sessionID)) return;
    if (event.location && !sameDirectory(event.location.directory, directory)) return;
    if (event.type === 'session.created' && !state.nativeId && !data.parentID && sameDirectory(data.location?.directory, directory)) {
      if (forkParent) { if (candidates.size < 8 && data.sessionID !== forkParent) candidates.add(data.sessionID); }
      else emit({ nativeId: data.sessionID });
    }
    if (event.type === 'session.forked' && !state.nativeId && data.parentID === forkParent && candidates.has(data.sessionID)) emit({ nativeId: data.sessionID, hasConversation: true });
    if (data.sessionID !== state.nativeId) return;
    const dialogId = event.type === 'permission.replied' ? data.requestID : data.id;
    if (['form.created', 'permission.asked'].includes(event.type)) {
      if (typeof dialogId !== 'string' || dialogId.length > 160) return;
      if (dialogs.size < 128) dialogs.add(`${event.type === 'form.created' ? 'form' : 'permission'}:${dialogId}`);
      emit({ activity: 'waiting' }); return;
    }
    if (['form.replied', 'form.cancelled', 'permission.replied'].includes(event.type)) {
      if (!dialogs.delete(`${event.type === 'permission.replied' ? 'permission' : 'form'}:${dialogId}`)) return;
      emit({ activity: dialogs.size ? 'waiting' : executing ? 'working' : 'idle' }); return;
    }
    if (event.type === 'session.inbox.delivered') emit({ hasConversation: true });
    else if (event.type === 'session.execution.started') { executing = true; message = null; text = ''; final = false; emit({ activity: dialogs.size ? 'waiting' : 'working', hasConversation: true }); }
    else if (event.type === 'session.step.started') { message = data.assistantMessageID; text = ''; final = false; }
    else if (event.type === 'session.text.ended' && data.assistantMessageID === message && typeof data.text === 'string') text = `${text}${text ? '\n' : ''}${data.text.slice(-350)}`.slice(-350);
    else if (event.type === 'session.step.ended' && data.assistantMessageID === message) final = !!data.finish && !['tool-calls', 'unknown'].includes(data.finish);
    else if (event.type === 'session.execution.succeeded') { executing = false; emit({ activity: dialogs.size ? 'waiting' : 'idle', ...(final && typeof message === 'string' ? { completion: message, preview: text } : {}) }); }
    else if (['session.execution.failed', 'session.execution.interrupted'].includes(event.type)) { executing = false; dialogs.clear(); message = null; text = ''; final = false; emit({ activity: 'idle' }); }
    else if (event.type === 'session.status' && ['busy', 'retry'].includes(data.status?.type)) { executing = true; emit({ activity: dialogs.size ? 'waiting' : 'working' }); }
    else if (event.type === 'session.status' && data.status?.type === 'idle') { executing = false; emit({ activity: dialogs.size ? 'waiting' : 'idle' }); }
  };
  observe.owns = id => id === state.nativeId;
  if (state.nativeId) emit({});
  return observe;
}

export function v2ObserverFromEnvironment(directory, env = process.env) {
  const file = env.MRMAK_OPENCODE_STATE;
  if (!file || !path.isAbsolute(file) || !env.MRMAK_OPENCODE_CHAT_ID || !env.MRMAK_OPENCODE_LAUNCH_ID) return Object.assign(() => {}, { owns: () => false });
  const save = createStateWriter(file);
  const observe = createV2Observer({ directory, nativeId: env.MRMAK_OPENCODE_SESSION_ID, forkParent: env.MRMAK_OPENCODE_FORK_PARENT,
    chatId: env.MRMAK_OPENCODE_CHAT_ID, launchId: env.MRMAK_OPENCODE_LAUNCH_ID, hasConversation: env.MRMAK_OPENCODE_HAS_CONVERSATION === '1', startedAt: Number(env.MRMAK_OPENCODE_STARTED_AT) || Date.now(),
    save,
  });
  observe.dispose = save.dispose;
  return observe;
}
