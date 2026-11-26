import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { codexTranscript, nativeConnectionIssue } from './native-events.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 100;

// Display projection only: never write transcripts or deliver model input.
export function compactMessage(record) {
  const item = record?.type === 'response_item' ? record.payload : null;
  if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) return null;
  if (item.role === 'assistant' && item.channel && !['commentary', 'final'].includes(item.channel)) return null;
  const text = (item.content || []).filter(part => ['input_text', 'output_text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n');
  // Codex serializes injected context as role=user too. Only standalone native
  // envelopes are hidden; mentions/quoted examples in ordinary prose stay visible.
  if (item.role === 'user' && /^(?:\s*<(environment_context|turn_aborted)>[\s\S]*?<\/\1>\s*)+$/.test(text)) return null;
  if (item.role === 'user' && /^# AGENTS\.md instructions for [^\n]+\n[\s\S]*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/.test(text)) return null;
  return text ? { role: item.role, text: text.slice(0, 32000), clipped: text.length > 32000 } : null;
}

export class CompactConversations {
  constructor(resolve = codexTranscript) { this.resolve = resolve; this.cache = new Map(); }
  async read(session) {
    if (session.agent !== 'codex') throw new Error('Compact conversation prototype supports Codex only.');
    if (!session.nativeId) return { messages: [], status: 'waiting', truncated: false };
    const key = `${session.conversationStoreId || 'system'}:${session.nativeId}`;
    let state = this.cache.get(key);
    if (!state) {
      const file = await this.resolve(session.nativeId, session);
      if (!file) throw new Error('Native transcript unavailable. Use the terminal.');
      state = { file, offset: 0, partial: '', decoder: new StringDecoder('utf8'), messages: [], truncated: false, lastUser: null };
      if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, state);
    }
    if (state.reading) { await state.reading; return this.result(state); }
    state.reading = this.update(state);
    try { await state.reading; return this.result(state); }
    finally { state.reading = null; }
  }
  result(state) { return { messages: state.messages, status: 'ready', truncated: state.truncated, ...(state.connectionIssue ? { connectionIssue: state.connectionIssue } : {}) }; }
  async update(state) {
    const size = (await stat(state.file)).size;
    if (size < state.offset) { state.offset = 0; state.partial = ''; state.messages = []; state.decoder = new StringDecoder('utf8'); state.truncated = false; state.lastUser = null; state.connectionIssue = null; }
    if (size === state.offset) return;
    let skipFirst = false;
    if (size - state.offset > MAX_BYTES) {
      state.offset = size - MAX_BYTES; state.partial = ''; state.decoder = new StringDecoder('utf8'); state.messages = []; state.truncated = true; state.lastUser = null; state.connectionIssue = null; skipFirst = true;
    }
    const file = await open(state.file, 'r');
    try {
      const bytes = Buffer.alloc(size - state.offset);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, state.offset);
      state.offset += bytesRead;
      const lines = (state.partial + state.decoder.write(bytes.subarray(0, bytesRead))).split('\n');
      state.partial = lines.pop() || '';
      if (skipFirst) lines.shift();
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const issue = nativeConnectionIssue(record, 'codex');
        if (issue) state.connectionIssue = issue;
        else if (record.type === 'event_msg' && ['task_started', 'task_complete', 'user_message'].includes(record.payload?.type)) state.connectionIssue = null;
        const human = record.type === 'event_msg' && record.payload?.type === 'user_message' && typeof record.payload.message === 'string';
        // A real user event can confirm even a literal pasted context envelope.
        // Pair its response_item duplicate once, without deduplicating repeated turns.
        const message = human ? { role: 'user', text: record.payload.message.slice(0, 32000), clipped: record.payload.message.length > 32000 } : compactMessage(record);
        if (!message) continue;
        if (message.role === 'user') {
          const source = human ? 'event' : 'response';
          if (state.lastUser?.text === message.text && state.lastUser.source !== source) { state.lastUser = null; continue; }
          state.lastUser = { text: message.text, source };
        } else state.lastUser = null;
        state.messages.push({ ...message, id: `${state.offset}:${state.messages.length}:${record.timestamp || ''}` });
      }
      if (state.messages.length > MAX_MESSAGES) { state.messages = state.messages.slice(-MAX_MESSAGES); state.truncated = true; }
    } finally { await file.close(); }
  }
}
