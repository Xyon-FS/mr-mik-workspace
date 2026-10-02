// Event observation adapted from Mr. Mak Workspace v0.4.16 (witnesstodark), MIT.
// Persist IDs/activity and at most a short final-answer History excerpt.
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export const validSessionId = value => typeof value === 'string' && /^ses[a-zA-Z0-9_-]{1,160}$/.test(value);
const sameDirectory = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

export function finalAnswerPreview(data, sessionID, messageID) {
  const info = data?.info;
  if (info?.sessionID !== sessionID || info.id !== messageID || info.role !== 'assistant' || !info.time?.completed || info.error || !info.finish || ['tool-calls', 'unknown'].includes(info.finish)) return '';
  let preview = '';
  for (const part of data.parts || []) {
    if (part.sessionID === sessionID && part.messageID === messageID && part.type === 'text' && typeof part.text === 'string') preview = `${preview}${preview ? '\n' : ''}${part.text.slice(-350)}`.slice(-350);
  }
  return preview;
}

export function createObserver({ directory, nativeId, forkParent, chatId, launchId, startedAt = Date.now(), save, loadPreview }) {
  let state = { chatId, launchId, nativeId: validSessionId(nativeId) ? nativeId : null, activity: 'idle', completion: null, revision: 0, hasConversation: false };
  let finalMessage = null;
  const emit = patch => { state = { ...state, ...patch, revision: state.revision + 1 }; save(state); };
  return event => {
    if (!event || typeof event !== 'object' || typeof event.created === 'number' && event.created < startedAt) return;
    const data = event.properties || {}, info = data.info;
    // CLI 1.18.34 forks are new root sessions (parentID is absent), not
    // subagent children. Bind the invocation's first fresh root, never the
    // source ID or unrelated child sessions; --session/--fork selects source.
    if (event.type === 'session.created' && !state.nativeId && info && (forkParent ? (!info.parentID || info.parentID === forkParent) && info.id !== forkParent : !info.parentID) && validSessionId(info.id) && sameDirectory(info.directory, directory)) {
      emit({ nativeId: info.id, hasConversation: !!forkParent });
    }
    const id = data.sessionID || info?.sessionID;
    if (!state.nativeId || id !== state.nativeId) return;
    if (event.type === 'session.status' && ['busy', 'retry'].includes(data.status?.type)) {
      // OpenCode 1.18.34 emits another busy status after the final assistant
      // message. It is still the same turn; do not erase its completion ID.
      if (state.activity !== 'working') finalMessage = null;
      emit({ activity: 'working', hasConversation: true });
    } else if (event.type === 'message.updated' && info?.role === 'user') {
      emit({ hasConversation: true });
    } else if (event.type === 'message.updated' && info?.role === 'assistant' && info.time?.completed) {
      if (info.error) { finalMessage = null; emit({ activity: 'idle' }); }
      else if (info.finish && !['tool-calls', 'unknown'].includes(info.finish)) finalMessage = info.id;
    } else if (event.type === 'session.idle' || event.type === 'session.status' && data.status?.type === 'idle') {
      if (finalMessage && state.completion !== finalMessage) {
        const messageID = finalMessage, sessionID = state.nativeId;
        emit({ activity: 'idle', completion: messageID, preview: '' });
        // Read only this completed answer. Never enumerate or persist messages,
        // reasoning, tool output or user prompts. Failure cannot break activity.
        if (loadPreview) Promise.resolve().then(() => loadPreview(sessionID, messageID)).then(preview => {
          if (finalMessage === messageID && state.completion === messageID && state.nativeId === sessionID && typeof preview === 'string' && preview) emit({ preview: preview.slice(-350) });
        }).catch(() => {});
      }
      else if (state.activity === 'working') emit({ activity: 'idle' });
    } else if (event.type === 'session.error') { finalMessage = null; emit({ activity: 'idle' }); }
    else if (['permission.asked', 'question.asked'].includes(event.type)) emit({ activity: 'waiting' });
    else if (['permission.replied', 'question.replied', 'question.rejected'].includes(event.type)) emit({ activity: 'working' });
  };
}

export function observerFromEnvironment(directory, env = process.env, loadPreview) {
  const file = env.MRMAK_OPENCODE_STATE;
  if (!file || !path.isAbsolute(file) || !env.MRMAK_OPENCODE_CHAT_ID || !env.MRMAK_OPENCODE_LAUNCH_ID) return () => {};
  return createObserver({ directory, nativeId: env.MRMAK_OPENCODE_SESSION_ID, forkParent: env.MRMAK_OPENCODE_FORK_PARENT, loadPreview,
    chatId: env.MRMAK_OPENCODE_CHAT_ID, launchId: env.MRMAK_OPENCODE_LAUNCH_ID,
    startedAt: Number(env.MRMAK_OPENCODE_STARTED_AT) || Date.now(),
    save: state => {
      try { writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${file}.tmp`, file); }
      catch { /* Observation must never break the native conversation. */ }
    },
  });
}
