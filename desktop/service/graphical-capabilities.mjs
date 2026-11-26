// UI/API operations are explicit; a provider name never implies Codex parity.
export const claudeGraphicalCapabilities = Object.freeze({
  messages: true, streaming: true, tools: true, approvals: true, questions: true,
  interrupt: true, resume: true, models: true, permissions: true, plan: true, attachments: true, context: true, steer: true,
  browserPanel: false, review: false, compaction: true, usage: true, messageActions: true, queue: true,
});

export const claudeGraphicalActions = new Set(['steer', 'enqueue', 'queue-edit', 'queue-cancel', 'queue-pause', 'send', 'interrupt', 'answer', 'draft', 'models', 'configure', 'set-permissions', 'reconnect', 'acknowledge-uncertain', 'open-file', 'detach-attachment', 'history', 'search-history', 'search-open', 'skills', 'composer-add', 'composer-remove', 'composer-source', 'usage', 'compact', 'compact-dismiss', 'agent-read', 'prepare-review']);
