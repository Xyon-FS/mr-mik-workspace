// Coordinator delivery differs from manual terminal input: never approve a
// native dialog or interrupt the entire OpenCode process with generic keys.
export function workerControls(sessions, openCodePicker) {
  return {
    async prepare(id) {
      const chat = sessions.get(id);
      if (chat.agent !== 'opencode') return;
      if (chat.activity !== 'idle' || chat.attention) throw new Error('Handle native prompts and wait for an idle OpenCode chat before sending.');
      await openCodePicker.command(id, 'prepare');
    },
    async send(id, text) {
      const chat = sessions.get(id);
      if (chat.agent !== 'opencode') return sessions.input(id, text, { coordinator: true, submit: true });
      if (typeof text !== 'string' || !text.trim() || text.length > 64000) throw new Error('Provide a non-empty worker message of at most 64000 characters.');
      if (chat.activity !== 'idle' || chat.attention) throw new Error('Handle native prompts and wait for an idle OpenCode chat before sending.');
      const process = chat.process, lastInputAt = chat.lastInputAt;
      await this.prepare(id);
      if (chat.process !== process || chat.lastInputAt !== lastInputAt || chat.activity !== 'idle' || chat.attention) throw new Error('This worker changed. Read its current terminal again before sending.');
      sessions.input(id, text, { coordinator: true, submit: false });
      // Let the native paste handler settle. Submit revalidates native scope,
      // idle status and dialogs; on failure leave the draft for manual review.
      await new Promise(resolve => setTimeout(resolve, 500));
      if (chat.process !== process || chat.lastInputAt !== lastInputAt) throw new Error('The worker changed after pasting. Review its draft directly; do not resend automatically.');
      try { await openCodePicker.command(id, 'submit'); }
      catch { throw new Error('The task was pasted but native submission was not confirmed. Review the terminal draft; do not resend automatically.'); }
      chat.hasConversation = true; chat.updatedAt = new Date().toISOString(); sessions.changed(chat);
      return { delivered: true, sessionId: id, name: chat.name, note: 'Native submit dispatched. Inspect the worker for acceptance and progress; this does not prove task completion.' };
    },
    async interrupt(id) {
      if (sessions.get(id).agent === 'opencode') { await openCodePicker.command(id, 'interrupt'); return { interrupted: true, sessionId: id, note: 'Native abort requested; the chat remains open. Inspect its state afterwards.' }; }
      sessions.input(id, '\x03'); return { delivered: 'Ctrl+C', sessionId: id };
    },
  };
}
