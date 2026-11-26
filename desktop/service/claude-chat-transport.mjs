import { spawn } from 'node:child_process';
import { terminalCommand } from './agents.mjs';
import { claudePermissionOptions } from './claude-chat-settings.mjs';
import { CLAUDE_INPUT_BYTES } from './claude-chat-attachments.mjs';

// Owns only this chat's unmodified local Claude Code process. Authentication,
// project configuration and inference remain native; no token extraction/login.
export function claudeChatTransport({ session, env, bridge, browser, resumeId, resumePath, fork = false, spawnChild = spawn, binary, shutdownMs = 1500 }) {
  let child, ended, closing, timer;
  const factory = ({ data, closed }) => {
    if (child) throw new Error('This Claude transport has already started.');
    const allowBypass = session.claudeBypassAllowed === true || session.bypass === true;
    const permissionMode = session.claudePermissionMode || (session.bypass ? 'bypassPermissions' : 'default');
    if (!claudePermissionOptions(allowBypass).some(item => item.value === permissionMode)) throw new Error('Choose a supported Claude permission mode.');
    const command = binary || terminalCommand('claude', { env, cwd: session.cwd, nativeId: session.nativeId, resumeId, resumePath, fork, effort: session.effort, bypass: permissionMode === 'bypassPermissions', bridge, browser });
    const args = [...command.args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--no-chrome'];
    if (session.graphicalModel) args.push('--model', session.graphicalModel);
    // Explicit session-only default prevents a native print-mode default from
    // silently turning an interactive GUI into an unattended approval path.
    if (allowBypass && permissionMode !== 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
    args.push('--permission-mode', permissionMode);
    child = spawnChild(command.file, args, { cwd: session.cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let open = true, notified = false, queuedBytes = 0;
    const notify = message => { if (!notified) { notified = true; closed(message); } };
    ended = new Promise(resolve => {
      child.once('close', () => { open = false; clearTimeout(timer); notify('Claude process closed.'); resolve(); });
      child.once('error', () => { open = false; notify('Claude process could not start.'); if (!child.pid) resolve(); });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (open) data(chunk); });
    child.stderr.on('data', () => {}); // Native diagnostics can contain credentials.
    child.stdin.on('error', () => { notify('Claude input disconnected.'); void close().catch(() => {}); });
    return {
      isOpen: () => open && !closing && !child.killed && child.exitCode === null,
      close,
      send(line) {
        if (!open || closing || child.exitCode !== null) throw new Error('Claude is disconnected.');
        if (typeof line !== 'string' || Buffer.byteLength(line) > CLAUDE_INPUT_BYTES) throw new Error('Claude input exceeds the message limit.');
        const message = JSON.parse(line);
        if (!['control_request', 'control_response', 'user'].includes(message?.type)) throw new Error('Unsupported Claude input.');
        const frame = JSON.stringify(message) + '\n', length = Buffer.byteLength(frame);
        if (queuedBytes + length > CLAUDE_INPUT_BYTES + 128 * 1024) throw new Error('Claude input is still draining. Wait before sending another message.');
        queuedBytes += length;
        try {
          // false means the frame is queued successfully. It is not a delivery
          // failure; large images routinely exceed the stream high-water mark.
          child.stdin.write(frame, error => {
            queuedBytes = Math.max(0, queuedBytes - length);
            if (error) { notify('Claude input disconnected; delivery may be uncertain.'); void close().catch(() => {}); }
          });
        } catch (error) { queuedBytes = Math.max(0, queuedBytes - length); throw error; }
      },
    };
  };
  async function close() {
    if (closing) return closing;
    if (!child) return;
    closing = (async () => {
      child.stdin.end();
      let killer;
      timer = setTimeout(() => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        // Descendants include this invocation's MCP servers, never other chats.
        if (process.platform === 'win32') {
          killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => { try { child.kill(); } catch { /* Deadline below reports failure. */ } });
        } else { try { child.kill('SIGKILL'); } catch { /* Deadline below reports failure. */ } }
      }, shutdownMs);
      let deadline;
      try {
        await Promise.race([ended, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Claude worker did not exit. Its process is retained for review.')), shutdownMs + 5000); })]);
      } finally { clearTimeout(timer); clearTimeout(deadline); }
      if (killer && killer.exitCode === null) {
        let helperDeadline;
        try { await Promise.race([new Promise(resolve => killer.once('close', resolve)), new Promise((_, reject) => { helperDeadline = setTimeout(() => reject(new Error('Claude shutdown helper did not exit.')), 2000); })]); }
        finally { clearTimeout(helperDeadline); }
      }
    })();
    return closing;
  }
  return { factory, close };
}
