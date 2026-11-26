const clip = (value, limit = 8000) => typeof value === 'string' ? value.slice(0, limit) : '';
const key = value => typeof value === 'string' && /^[\w:.-]{1,200}$/.test(value);
const terminal = new Set(['completed', 'failed', 'stopped', 'unavailable', 'idle']);

// Observation only: no task/message controls and no reads of arbitrary output_file paths.
export class ClaudeSubagents {
  constructor(runtime) { this.runtime = runtime; this.records = new Map(); this.tools = new Map(); this.tasks = new Map(); }
  reconcileIdle() {
    if (this.nativeBusy === false && !this.nativeBackground) for (const record of this.records.values()) if (!terminal.has(record.status)) { record.status = 'idle'; record.message = 'Native session is idle; the final task outcome was not reported.'; }
  }
  register(block, parentId = null) {
    if (!['Agent', 'Task'].includes(block.name) || !key(block.id)) return;
    let record = this.tools.get(block.id);
    if (!record) {
      if (this.records.size >= 40) {
        const retired = [...this.records.values()].find(record => terminal.has(record.status));
        if (!retired) return;
        this.records.delete(retired.id);
        for (const [id, record] of this.tools) if (record === retired) this.tools.delete(id);
        for (const [id, record] of this.tasks) if (record === retired) this.tasks.delete(id);
      }
      record = { id: block.id, parentId, name: clip(block.input?.name || block.input?.description || 'Agent', 120), role: clip(block.input?.subagent_type, 120), task: clip(block.input?.prompt, 4000), status: 'running', message: '', items: [], sequence: 0 };
      this.records.set(record.id, record); this.tools.set(block.id, record);
    } else {
      record.name = clip(block.input?.name || block.input?.description || record.name, 120);
      record.role = clip(block.input?.subagent_type || record.role, 120); record.task = clip(block.input?.prompt || record.task, 4000);
    }
    this.runtime.changed();
  }
  observe(message) {
    const parent = message.parent_tool_use_id;
    const owner = parent && this.tools.get(parent);
    if (parent && !owner) return;
    if (owner && message.session_id) {
      if (owner.streamSessionId && owner.streamSessionId !== message.session_id) return;
      owner.streamSessionId = message.session_id;
    }
    if (!parent && message.session_id && message.session_id !== this.runtime.session.nativeId) return;
    if (!parent && message.type === 'system' && message.subtype === 'session_state_changed' && ['idle', 'running', 'requires_action'].includes(message.state)) {
      this.nativeBusy = message.state !== 'idle';
      this.reconcileIdle();
      this.runtime.changed(); return;
    }
    if (!parent && message.type === 'system' && message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
      this.nativeBackground = message.tasks.slice(0, 200).some(task => task.ambient !== true);
      this.reconcileIdle();
      this.runtime.changed(); return;
    }
    if (message.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(message.subtype)) {
      const record = this.tools.get(message.tool_use_id) || this.tasks.get(message.task_id);
      if (!record || !key(message.task_id)) return;
      if (message.run_id && record.runId && message.run_id < record.runId) return;
      if (terminal.has(record.status) && message.subtype === 'task_started' && message.run_id && record.runId && message.run_id === record.runId) return;
      if (message.run_id && record.runId && message.run_id > record.runId && message.subtype !== 'task_started') return;
      if (terminal.has(record.status) && message.subtype !== 'task_started' && !(message.subtype === 'task_notification' && ['idle', 'unavailable'].includes(record.status))) return;
      if (message.run_id) record.runId = clip(message.run_id, 200);
      if (!this.tasks.has(message.task_id) && this.tasks.size >= 200) return;
      this.tasks.set(message.task_id, record); record.nativeId = message.task_id;
      if (key(message.tool_use_id) && this.tools.size < 200) this.tools.set(message.tool_use_id, record);
      record.role = clip(message.subagent_type || record.role, 120);
      record.message = clip(message.summary || message.description || message.last_tool_name || record.message);
      record.status = message.subtype === 'task_notification' ? ['completed', 'failed', 'stopped'].includes(message.status) ? message.status : 'unavailable' : 'running';
      this.runtime.changed(); return;
    }
    const blocks = message.type === 'assistant' ? message.message?.content || [] : message.type === 'stream_event' && message.event?.type === 'content_block_start' ? [message.event.content_block] : [];
    for (const block of blocks) if (block?.type === 'tool_use') this.register(block, owner?.id);
    if (message.type === 'user') for (const block of message.message?.content || []) {
      const child = block.type === 'tool_result' && this.tools.get(block.tool_use_id);
      if (child && (child.parentId || null) === (owner?.id || null)) {
        const background = message.tool_use_result?.isAsync === true;
        if (!(background && terminal.has(child.status))) {
          child.status = block.is_error ? 'failed' : background ? 'running' : 'completed';
          child.message = background ? 'Running in background.' : this.text(block.content);
          this.runtime.changed();
        }
      }
      const item = owner?.items.find(item => item.toolId === block.tool_use_id);
      if (item) { item.text = clip(`${item.tool}\n${this.text(block.content)}`, 4000); item.status = block.is_error ? 'failed' : 'completed'; }
    }
    if (!owner) return;
    if (message.type === 'assistant') {
      for (const [index, block] of (message.message?.content || []).entries()) {
        if (!['text', 'tool_use'].includes(block.type)) continue;
        this.upsert(owner, `${message.message.id}:${index}`, block.type === 'text' ? 'agentMessage' : 'dynamicToolCall', block.type === 'text' ? block.text : block.name, true, block.id);
      }
    } else if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') owner.messageId = clip(event.message?.id, 200);
      const id = `${owner.messageId}:${event.index}`;
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') this.upsert(owner, id, 'agentMessage', event.content_block.text);
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') this.upsert(owner, id, 'dynamicToolCall', event.content_block.name, false, event.content_block.id);
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const item = owner.items.find(item => item.id === id); if (item && !item.final) item.text = clip(item.text + event.delta.text, 4000);
      }
    }
    this.runtime.changed();
    return owner;
  }
  text(content) { return clip(typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''), 8000); }
  upsert(record, id, type, text, final = false, toolId) {
    let item = record.items.find(item => item.id === id);
    if (!item) { item = { id, type, text: '', status: 'completed' }; record.items.push(item); }
    item.text = clip(text, 4000); item.final = final;
    if (type === 'dynamicToolCall') { item.toolId = clip(toolId, 200); item.tool = clip(text, 120); item.status = 'inProgress'; }
    record.items = record.items.slice(-50);
  }
  snapshot() { return [...this.records.values()].map(({ id, parentId, name, role, task, status, message }) => ({ id, parentId, name, role, task, status, message })); }
  get hasActive() { return this.nativeBusy === true || this.nativeBackground === true || [...this.records.values()].some(record => !terminal.has(record.status)); }
  read(id) {
    const record = this.records.get(id); if (!record) throw new Error('Choose a subagent owned by this conversation.');
    return { ...this.snapshot().find(item => item.id === id), items: structuredClone(record.items), limited: true, readOnly: true };
  }
  save() {
    let budget = 2 * 1024 * 1024;
    return [...this.records.values()].reverse().map(({ id, parentId, name, role, task, status, message, items }) => ({ id, parentId, name, role, task, status: terminal.has(status) ? status : 'unavailable', message, items: [...items].reverse().filter(item => { budget -= JSON.stringify(item).length; return budget >= 0; }).reverse() })).reverse();
  }
  restore(records) {
    if (!Array.isArray(records)) return;
    for (const value of records.slice(0, 40)) {
      if (!key(value?.id) || !Array.isArray(value.items)) continue;
      const record = { id: value.id, parentId: key(value.parentId) ? value.parentId : null, name: clip(value.name, 120), role: clip(value.role, 120), task: clip(value.task, 4000), status: terminal.has(value.status) ? value.status : 'unavailable', message: clip(value.message), items: value.items.slice(-50).filter(item => ['agentMessage', 'dynamicToolCall'].includes(item.type)).map(item => ({ id: clip(item.id, 400), type: item.type, text: clip(item.text, 4000), status: ['completed', 'failed'].includes(item.status) ? item.status : 'unavailable', final: true })) };
      this.records.set(record.id, record);
      // Historical identities never authorize routing new live child frames.
    }
  }
}
