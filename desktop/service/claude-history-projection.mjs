// Native records are projected without binary payloads, transport requests or
// invented attachment paths. Unknown blocks remain visible as unavailable context.
export function projectClaudeHistory(messages, textLimit = 200000) {
  const items = [], turns = [], tools = new Map(); let turn;
  for (const row of messages) {
    const content = row.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (row.type === 'user') {
      const input = blocks.filter(block => block.type !== 'tool_result');
      if (input.length) {
        turn = { id: `native-${row.uuid}`, status: 'completed', startedAt: null, completedAt: 0, durationMs: null, timingSource: 'unavailable', historical: true };
        turns.push(turn);
        const text = input.map(block => block.type === 'text' ? block.text : `[${block.type || 'Unknown'} context retained in native history; original local reference unavailable]`).join('\n');
        items.push({ id: row.uuid, nativeUuid: row.uuid, turnId: turn.id, type: 'userMessage', text: text.slice(0, textLimit), status: 'completed', historical: true });
      }
      for (const block of blocks) if (block.type === 'tool_result') {
        const item = tools.get(block.tool_use_id);
        if (item) { item.text = resultText(block.content, textLimit); item.status = block.is_error ? 'failed' : 'completed'; }
      }
    }
    if (row.type !== 'assistant') continue;
    for (const [index, block] of blocks.entries()) {
      const item = { id: `${row.message?.id || row.uuid}:${index}`, nativeUuid: row.uuid, turnId: turn?.id, status: 'completed', historical: true };
      if (block.type === 'text' || block.type === 'thinking') Object.assign(item, { type: block.type === 'text' ? 'agentMessage' : 'reasoning', text: String(block.text || block.thinking || '').slice(0, textLimit) });
      else if (block.type === 'tool_use') {
        Object.assign(item, { type: 'tool', text: '', tool: block.name, toolId: block.id, input: safeInput(block.input) }); tools.set(block.id, item);
      } else Object.assign(item, { type: 'contextCompaction', text: `[${block.type || 'Unknown'} native output is unavailable in this view]` });
      if (item.type === 'agentMessage') item.phase = ['end_turn', 'stop_sequence'].includes(row.message?.stop_reason) ? 'final_answer' : row.message?.stop_reason === 'tool_use' ? 'commentary' : null;
      items.push(item);
    }
  }
  return { items, turns };
}
function safeInput(input) {
  const text = JSON.stringify(input || {}, (key, value) => ['data', 'blob', 'signature'].includes(key) ? undefined : typeof value === 'string' ? value.slice(0, 200000) : value);
  return text.length > 1000000 ? { unavailable: 'Native tool input exceeds the display limit' } : JSON.parse(text);
}
function resultText(content, limit) {
  if (typeof content === 'string') return content.slice(0, limit);
  return (Array.isArray(content) ? content.map(block => block.type === 'text' ? block.text : `[${block.type || 'Unknown'} tool result]`).join('\n') : '').slice(0, limit);
}
export function claudeDisplayItem(item) {
  if (item.changes?.length) return { ...item, type: 'fileChange', changes: item.changes, text: item.tool || 'File changes', details: '' };
  return { ...item, type: item.type === 'tool' ? 'dynamicToolCall' : item.type, text: item.type === 'tool' ? item.tool || 'Tool' : item.text, details: item.type === 'tool' ? JSON.stringify(item.input || {}, null, 2) + (item.text ? '\n' + item.text : '') : '' };
}
