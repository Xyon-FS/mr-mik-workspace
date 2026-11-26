// Synthetic stream-json host: never launches Claude, authenticates or runs tools.
import { randomUUID } from 'node:crypto';
export function claudeFixture(sessionId, options = {}) {
  const calls = [], transports = new Set(); let sequence = 0;
  const factory = ({ data, closed, resumeSessionId }) => {
    if (resumeSessionId !== sessionId) throw new Error('Wrong fixture session');
    let open = true, pending;
    const nativeSettings = { effort: options.effort || 'high', mode: options.mode || 'default' };
    const emit = message => { if (open) data(JSON.stringify(message) + '\n'); };
    const complete = (text = 'Synthetic Claude answer.', error = false) => {
      emit({ type: 'assistant', uuid: randomUUID(), session_id: sessionId, message: { id: `${sessionId}:answer-${sequence}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
      emit({ type: 'result', session_id: sessionId, subtype: error ? 'error_during_execution' : 'success', is_error: error, result: text });
    };
    const transport = {
      emit, complete, nativeSettings, isOpen: () => open,
      close() { open = false; transports.delete(transport); },
      disconnect() { this.close(); closed('Synthetic disconnect'); },
      send(line) {
        const message = JSON.parse(line); calls.push(message);
        if (message.type === 'control_request') queueMicrotask(() => {
          const request = message.request;
          if (options.holdSettings && request.subtype === 'get_settings') return;
          if (options.rejectControl === request.subtype || options.noSettings && request.subtype === 'get_settings') {
            emit({ type: 'control_response', response: { request_id: message.request_id, subtype: 'error', error: 'Synthetic policy restriction' } }); return;
          }
          if (request.subtype === 'apply_flag_settings') nativeSettings.effort = options.clampEffort || request.settings.effortLevel;
          if (request.subtype === 'set_permission_mode') nativeSettings.mode = request.mode;
          const models = options.models || [
            { value: 'default', displayName: 'Default model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
            { value: 'fixture-sonnet', displayName: 'Fixture Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
          ];
          const response = request.subtype === 'initialize' ? { claude_code_version: options.version || '2.1.311', models, commands: options.commands || [], current_permission_mode: nativeSettings.mode, account: { token: 'NEVER-EXPOSE-FIXTURE-ACCOUNT' } }
            : request.subtype === 'get_settings' ? { effective: { effortLevel: nativeSettings.effort }, sources: [], applied: { effort: nativeSettings.effort } }
              : request.subtype === 'set_permission_mode' ? { mode: options.echoMode || nativeSettings.mode }
                : request.subtype === 'get_context_usage' ? options.contextUsage || {}
                  : request.subtype === 'get_usage' ? options.usage || {} : {};
          emit({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response } });
          if (message.request.subtype === 'interrupt') complete('Stopped.', true);
        });
        if (message.type === 'user') {
          if (message.priority === 'now') {
            if (options.holdSteer) return;
            emit({ type: 'command_lifecycle', session_id: sessionId, command_uuid: message.uuid, state: options.refuseSteer ? 'refused' : 'started' });
            if (!options.refuseSteer && !options.holdSteerResult) emit({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false, result: 'Synthetic steered answer.', user_message_uuids: [message.uuid] });
            return;
          }
          sequence++;
          const text = message.message.content[0].text;
          if (text === '/compact') {
            if (options.holdCompact) return;
            if (!options.missingCompactBoundary) emit({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'manual', pre_tokens: 123 } });
            emit({ type: 'result', session_id: sessionId, subtype: options.failCompact ? 'error_during_execution' : 'success', is_error: !!options.failCompact, modelUsage: options.modelUsage }); return;
          }
          if (text === 'slow') return;
          if (text === 'approve' || text === 'question') {
            pending = `approval-${sequence}`;
            const input = text === 'question' ? { questions: [{ question: 'First?', options: [{ label: 'A' }, { label: 'B' }] }, { question: 'Second?', multiSelect: true, options: [{ label: 'C' }, { label: 'D' }] }] } : { command: 'synthetic-no-execution' };
            emit({ type: 'assistant', message: { id: `tool-${sequence}`, content: [{ type: 'tool_use', id: pending, name: text === 'question' ? 'AskUserQuestion' : 'Bash', input }] } });
            emit({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: text === 'question' ? 'AskUserQuestion' : 'Bash', input } });
          } else {
            emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `${sessionId}:answer-${sequence}` } } });
            emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Synthetic ' } } });
            emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { text: 'Claude answer.' } } });
            complete();
          }
        }
        if (message.type === 'control_response') {
          const allowed = message.response.response?.behavior === 'allow';
          emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: pending, content: allowed ? 'Allowed fixture.' : 'Denied fixture.', is_error: !allowed }] } });
          complete(allowed ? 'Synthetic accepted.' : 'Synthetic denied.');
        }
      },
    };
    transports.add(transport); return transport;
  };
  return { factory, calls, transports, close() { for (const transport of transports) transport.close(); } };
}
