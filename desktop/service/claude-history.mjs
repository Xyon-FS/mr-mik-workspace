import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const execute = promisify(execFile);
export class ClaudeHistory {
  constructor(runtime) { this.runtime = runtime; }
  async call(action, anchor) {
    const runtime = this.runtime, env = { ...(runtime.env || process.env) };
    env.CLAUDE_CONFIG_DIR ||= path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude');
    try {
      const result = await execute(process.execPath, [fileURLToPath(new URL('./claude-history-worker.mjs', import.meta.url)), action, runtime.session.nativeId, runtime.session.cwd, ...(anchor ? [anchor] : [])], { env, cwd: runtime.session.cwd, windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
      return JSON.parse(result.stdout);
    } catch { throw new Error('Claude native history could not be verified. The source is preserved; no message was sent.'); }
  }
  read() { return this.call('read'); }
  fork(anchor) { return this.call('fork', anchor); }
  page(options = {}) { return this.call('page', JSON.stringify(options)); }
}
