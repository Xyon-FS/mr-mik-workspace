import { graphicalCodexBinary } from './codex-chat-binary.mjs';
import { sandboxMode } from './codex-sandbox.mjs';
import { codexWorkerKey } from './codex-worker-pool.mjs';

export function codexWorkerArguments(binary, mode, savedSandbox) {
  // Native default is 30 minutes after the last subscriber leaves. The app
  // explicitly closes roots while retaining only their engine; shutdown must
  // flush history before another account can resume the same conversation.
  return [...binary.args, '-c', 'thread_unload_delay_secs=0', ...(mode === 'native' ? [] : ['-c', `approval_policy=${JSON.stringify(mode === 'bypass' ? 'never' : 'on-request')}`, '-c', `approvals_reviewer=${JSON.stringify(mode === 'auto-review' ? 'auto_review' : 'user')}`, '-c', `sandbox_mode=${JSON.stringify(['bypass', 'full-access'].includes(mode) ? 'danger-full-access' : 'workspace-write')}`]), ...(savedSandbox ? ['-c', `windows.sandbox=${JSON.stringify(savedSandbox)}`] : [])];
}

export async function codexPreparationLaunch({ account, session, sandboxStateDir }) {
  const binary = graphicalCodexBinary();
  const saved = await sandboxMode(sandboxStateDir, { ...account.env, CODEX_HOME: account.sharedHome });
  const args = [...codexWorkerArguments(binary, session.codexPermissions || 'ask', saved), 'app-server', '--stdio'];
  const launch = { file: binary.file, args, cwd: session.cwd, env: account.env, profileId: account.profileId, kind: 'preparation' };
  return { ...launch, key: await codexWorkerKey({ ...launch, account }) };
}
