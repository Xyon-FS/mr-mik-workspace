// Claude stream-json protocol. Transport and process ownership are injected.
import { modelTokens } from './claude-usage.mjs';
export class ClaudeRuntime {
  constructor(factory, { timeoutMs = 5000, now = () => Date.now(), maxFrameChars = 1_000_000 } = {}) {
    this.factory = factory; this.timeoutMs = timeoutMs; this.now = now; this.maxFrameChars = maxFrameChars;
    this.listeners = new Set(); this.pending = new Map(); this.generation = 0;
    this.state = { status: 'closed', sessionId: null, items: [], requests: [], turns: [], error: '', uncertain: false };
    this.sequence = 0;
  }
  snapshot() { return structuredClone(this.state); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish() { for (const listener of this.listeners) listener(this.snapshot()); }
  id() { return globalThis.crypto.randomUUID(); }
  send(message) { this.transport.send(JSON.stringify(message) + '\n'); }
  async connect() {
    if (!['closed', 'disconnected', 'uncertain', 'error'].includes(this.state.status)) throw new Error('Already connected');
    const generation = ++this.generation;
    this.buffer = ''; this.state.status = 'connecting'; this.state.error = ''; this.publish();
    try {
      this.transport = this.factory({ resumeSessionId: this.state.sessionId,
        data: chunk => { if (generation === this.generation) this.feed(chunk); },
        closed: reason => { if (generation === this.generation) this.disconnected(reason || 'Transport closed'); } });
      this.initialization = await this.control({ subtype: 'initialize' });
      if (generation !== this.generation) throw new Error('Connection replaced');
      this.state.status = this.state.uncertain ? 'uncertain' : 'ready'; this.publish();
    } catch (error) { if (generation === this.generation) this.protocolFailure(error.message); throw error; }
  }
  control(request) {
    const request_id = this.id('control');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request_id); reject(new Error('Control request timed out')); }, this.timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      try { this.send({ type: 'control_request', request_id, request }); }
      catch (error) { clearTimeout(timer); this.pending.delete(request_id); reject(error); }
    });
  }
  feed(chunk) {
    // Bound incomplete frames too; never parse an unbounded native output stream.
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      if (end > this.maxFrameChars) { this.protocolFailure('Protocol frame exceeds limit'); return; }
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid envelope');
        this.receive(message);
      } catch { this.protocolFailure('Invalid structured output'); return; }
    }
    if (this.buffer.length > this.maxFrameChars) this.protocolFailure('Protocol frame exceeds limit');
  }
  protocolFailure(message) {
    this.disconnected(message); ++this.generation; this.closeTransport(); this.buffer = '';
  }
  closeTransport() {
    // The process owner awaits shutdown and reports cleanup failures. The parser
    // also requests shutdown on protocol faults, without an unhandled rejection.
    try { this.transport?.close()?.catch?.(() => {}); } catch { /* Owner closes again and reports failure. */ }
  }
  disconnected(message) {
    clearTimeout(this.stopTimer);
    const active = this.state.turns.find(turn => turn.completedAt == null);
    if (active) { active.completedAt = this.now(); active.status = 'uncertain'; this.state.uncertain = true; }
    if (this.state.compaction?.status === 'running') this.state.compaction.status = 'uncertain';
    this.state.requests = []; this.state.status = this.state.uncertain ? 'uncertain' : 'disconnected';
    this.state.error = message;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    this.pending.clear(); this.publish();
  }
  submit(text, { content, attachments = [], composerContext = [], operation } = {}) {
    if (this.state.status !== 'ready' || this.state.uncertain) throw new Error('Conversation is not ready');
    if (typeof text !== 'string' || !text.trim() && !attachments.length && !composerContext.length || text.length > 100_000) throw new Error('Invalid message');
    if (content && (!Array.isArray(content) || !content.length || content.length > 101)) throw new Error('Invalid message content');
    if (this.state.items.length >= 2000) throw new Error('Conversation display limit reached. Start a new conversation in History.');
    const id = this.id('user'), turnId = this.id('turn');
    if (!operation) this.state.items.push({ id, turnId, type: 'userMessage', text, ...(attachments.length ? { attachments } : {}), ...(composerContext.length ? { composerContext } : {}) });
    this.state.turns.push({ id: turnId, startedAt: this.now(), completedAt: null, status: 'running', ...(operation ? { kind: operation } : {}) });
    this.state.status = 'running'; this.state.error = ''; this.publish();
    try { this.send({ type: 'user', uuid: id, session_id: this.state.sessionId || '', parent_tool_use_id: null, message: { role: 'user', content: content || [{ type: 'text', text }] } }); }
    catch (error) { this.disconnected(error.message); throw error; }
  }
  steer(text, { expectedTurnId, id, content, attachments = [], composerContext = [] }) {
    const turn = this.state.turns.at(-1);
    if (this.state.status !== 'running' || this.state.uncertain || this.state.requests.length || turn?.id !== expectedTurnId || turn.completedAt != null || turn.kind) throw new Error('The active Claude turn changed before guidance was sent.');
    if (this.state.items.length >= 1990) throw new Error('Conversation display limit reached.');
    this.pendingSteer = { id, turnId: turn.id };
    this.state.items.push({ id, nativeUuid: id, turnId: turn.id, type: 'userMessage', inputIntent: 'steer', text, ...(attachments.length ? { attachments } : {}), ...(composerContext.length ? { composerContext } : {}) });
    this.publish();
    try { this.send({ type: 'user', uuid: id, session_id: this.state.sessionId, parent_tool_use_id: null, origin: { kind: 'human' }, priority: 'now', message: { role: 'user', content } }); }
    catch (error) { this.disconnected(error.message); throw error; }
  }
  item(id, type) {
    let item = this.state.items.find(value => value.id === id);
    if (!item) {
      if (this.state.items.length >= 2000) throw new Error('Transcript limit exceeded');
      item = { id, type, turnId: this.state.turns.at(-1)?.id, text: '', status: 'running' };
      this.state.items.push(item);
    }
    return item;
  }
  receive(message) {
    if (message.type === 'control_response') {
      const response = message.response, pending = this.pending.get(response?.request_id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(response.request_id);
      if (response.subtype === 'success') pending.resolve(response.response);
      else pending.reject(Object.assign(new Error('Claude rejected this session setting.'), { nativeRejected: true }));
      return;
    }
    const childOwner = this.observeSubagent?.(message);
    // Child sessions must not replace the parent's identity or transcript.
    if (message.parent_tool_use_id && !(childOwner && ['control_request', 'control_cancel_request'].includes(message.type))) return;
    if (message.session_id && !message.parent_tool_use_id) {
      if (this.state.sessionId && this.state.sessionId !== message.session_id) throw new Error('Session changed');
      this.state.sessionId = message.session_id;
    }
    this.steerObserver?.(message);
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.state.compactionBoundary = { at: this.now(), trigger: message.compact_metadata?.trigger === 'manual' ? 'manual' : 'auto' };
      const turn = this.state.turns.at(-1);
      if (turn?.kind === 'compact' && turn.completedAt == null && message.compact_metadata?.trigger === 'manual') turn.boundaryObserved = true;
      this.publish();
    }
    if (message.type === 'system' && typeof message.permissionMode === 'string') {
      this.state.permissionMode = message.permissionMode; this.publish();
    }
    if (message.type === 'control_cancel_request') {
      this.state.requests = this.state.requests.filter(item => item.id !== message.request_id);
      if (this.state.status === 'waiting' && !this.state.requests.length) this.state.status = 'running';
      this.publish(); return;
    }
    if (message.type === 'control_request') {
      const request = message.request;
      if (request?.subtype !== 'can_use_tool' || !['running', 'waiting'].includes(this.state.status)) {
        this.send({ type: 'control_response', response: { request_id: message.request_id, subtype: 'error', error: 'Unsupported or inactive request' } }); return;
      }
      if (!message.request_id || this.state.requests.some(item => item.id === message.request_id)) return;
      if (this.state.requests.length >= 20) throw new Error('Too many pending requests');
      this.state.requests.push({ id: message.request_id, turnId: this.state.turns.at(-1)?.id, ...(childOwner ? { agentLabel: childOwner.name } : {}), tool: request.tool_name, input: request.input,
        kind: request.tool_name === 'AskUserQuestion' ? 'question' : 'permission' });
      this.state.status = 'waiting'; this.publish(); return;
    }
    // Subagent streams require a separate ownership model; never merge into parent text.
    if (message.parent_tool_use_id) return;
    if (!['running', 'waiting', 'stopping'].includes(this.state.status)) return;
    if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') this.messageId = event.message?.id;
      if (event.type === 'content_block_start') {
        const block = event.content_block || {}, id = `${this.messageId}:${event.index}`;
        if (!['text', 'thinking', 'tool_use'].includes(block.type)) return;
        const item = this.item(id, block.type === 'tool_use' ? 'tool' : block.type === 'thinking' ? 'reasoning' : 'agentMessage');
        item.text = block.text || block.thinking || ''; item.tool = block.name; item.toolId = block.id; item.input = block.input;
      }
      if (event.type === 'content_block_delta') {
        const item = this.state.items.find(value => value.id === `${this.messageId}:${event.index}`);
        if (item && !item.final) {
          item.text += event.delta?.text || event.delta?.thinking || event.delta?.partial_json || '';
          if (item.text.length > 200_000) throw new Error('Content exceeds limit');
        }
      }
    }
    if (message.type === 'assistant') for (const [index, block] of (message.message?.content || []).entries()) {
      if (!['text', 'thinking', 'tool_use'].includes(block.type)) continue;
      const item = this.item(`${message.message.id}:${index}`, block.type === 'tool_use' ? 'tool' : block.type === 'thinking' ? 'reasoning' : 'agentMessage');
      if (/^[a-f0-9-]{36}$/i.test(message.uuid || '')) item.nativeUuid = message.uuid;
      item.text = block.text || block.thinking || ''; item.tool = block.name; item.toolId = block.id; item.input = block.input; item.final = true;
      if (item.type === 'agentMessage') item.phase = ['end_turn', 'stop_sequence'].includes(message.message.stop_reason) ? 'final_answer' : message.message.stop_reason === 'tool_use' ? 'commentary' : item.phase;
    }
    if (message.type === 'user') for (const block of message.message?.content || []) {
      if (block.type !== 'tool_result') continue;
      const item = this.state.items.find(value => value.toolId === block.tool_use_id);
      if (item) {
        item.text = this.toolResult?.(item, block, message) ?? (typeof block.content === 'string' ? block.content : (Array.isArray(block.content) ? block.content.map(part => part.type === 'text' ? part.text : `[${part.type || 'Unknown'} tool result]`).join('\n') : 'Unsupported tool result'));
        item.text = item.text.slice(0, 200000); item.status = block.is_error ? 'failed' : 'completed';
      }
    }
    if (message.type === 'result') {
      const ids = Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [message.user_message_uuid];
      if (this.pendingSteer && !ids.includes(this.pendingSteer.id)) {
        // Native priority=now may cut a request and emit its own intermediate
        // result before starting guidance. Keep the logical turn open until the
        // result covering the guidance UUID; never drain the queue in between.
        for (const item of this.state.items) if (item.turnId === this.pendingSteer.turnId && item.status === 'running') item.status = 'interrupted';
        const tokens = modelTokens(message.modelUsage); if (tokens) this.state.usageTokens = tokens;
        this.publish(); return;
      }
      const known = this.state.items.find(item => item.type === 'userMessage' && ids.includes(item.nativeUuid || item.id));
      if (known && known.turnId !== this.state.turns.at(-1)?.id) return;
      this.pendingSteer = null;
      clearTimeout(this.stopTimer);
      const turn = this.state.turns.at(-1);
      const tokens = modelTokens(message.modelUsage);
      if (tokens) this.state.usageTokens = tokens;
      if (turn?.kind === 'compact' && this.state.compaction?.status === 'running') {
        this.state.compaction.status = message.is_error || message.subtype !== 'success' ? 'failed' : turn.boundaryObserved ? 'completed' : 'uncertain';
        this.state.compaction.completedAt = this.now();
      }
      if (turn && turn.completedAt == null) { turn.completedAt = this.now(); turn.status = this.state.status === 'stopping' ? 'interrupted' : message.is_error || message.subtype !== 'success' ? 'failed' : 'completed'; }
      for (const item of this.state.items) if (item.turnId === turn?.id && item.status === 'running') item.status = turn.status;
      if (message.result && !this.state.items.some(item => item.turnId === turn?.id && item.type === 'agentMessage' && item.text === message.result)) {
        this.item(this.id('result'), 'agentMessage').text = message.result;
      }
      this.state.requests = []; this.state.status = 'ready';
      if (turn?.status === 'failed') this.state.error = 'Claude reported an unsuccessful turn';
    }
    this.publish();
  }
  answer(id, allow, answers) {
    const request = this.state.requests.find(item => item.id === id);
    if (!request || this.state.status !== 'waiting') throw new Error('Request is no longer active');
    const updatedInput = structuredClone(request.input || {});
    if (allow && request.kind === 'question') {
      const questions = updatedInput.questions;
      if (!Array.isArray(questions) || !questions.length || questions.some(q => typeof answers?.[q.question] !== 'string' || !answers[q.question].trim())) throw new Error('Answers are required');
      updatedInput.answers = answers;
    }
    this.state.requests = this.state.requests.filter(item => item.id !== id);
    this.state.status = this.state.requests.length ? 'waiting' : 'running';
    try { this.send({ type: 'control_response', response: { subtype: 'success', request_id: id,
      response: allow ? { behavior: 'allow', updatedInput } : { behavior: 'deny', message: 'User declined' } } }); }
    catch (error) { this.disconnected(error.message); throw error; }
    this.publish();
  }
  async interrupt() {
    if (!['running', 'waiting'].includes(this.state.status)) throw new Error('No active turn');
    this.state.status = 'stopping'; this.state.requests = []; this.publish();
    this.stopTimer = setTimeout(() => { if (this.state.status === 'stopping') this.protocolFailure('Interrupted turn did not finish'); }, this.timeoutMs);
    try { await this.control({ subtype: 'interrupt' }); }
    catch (error) { this.protocolFailure(error.message); }
    // A successful control response only acknowledges receipt. Await the final result.
  }
  acknowledgeUncertain() {
    if (this.state.status !== 'uncertain' || !this.transport?.isOpen()) throw new Error('Reconnect first');
    this.state.uncertain = false; this.state.status = 'ready'; this.state.error = ''; this.publish();
  }
  close() {
    ++this.generation; this.closeTransport();
    this.disconnected('Claude connection closed'); this.state.status = 'closed'; this.publish();
  }
}
