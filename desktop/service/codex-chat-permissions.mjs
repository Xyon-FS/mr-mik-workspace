import { NativeProfileProbe } from './codex-profile-probe.mjs';
import { isDeepStrictEqual } from 'node:util';

const same = isDeepStrictEqual;
const matches = (actual, desired) => actual?.approvalPolicy === desired.approvalPolicy && actual?.approvalsReviewer === desired.approvalsReviewer && same(actual?.sandboxPolicy, desired.sandboxPolicy);

// Graphical-only settings. RPC acknowledgement queues the native update; the
// settings notification is the evidence that it was applied. Never restart a
// worker or infer success from an empty RPC response.
export class GraphicalPermissions {
  constructor(runtime) { this.runtime = runtime; this.busy = false; this.uncertain = false; this.policy = null; }
  observe(settings) {
    if (!settings?.sandboxPolicy || !settings.approvalPolicy || !settings.approvalsReviewer) return;
    this.policy = { approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, sandboxPolicy: settings.sandboxPolicy };
    const r = this.runtime;
    r.effective = { ...r.effective, approvalPolicy: settings.approvalPolicy, reviewer: settings.approvalsReviewer, sandbox: settings.sandboxPolicy.type };
    r.emit('permission-settings', this.policy);
  }
  initialize(result) {
    this.observe({ approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer, sandboxPolicy: result.sandbox });
    if (result.sandbox?.type === 'workspaceWrite') this.workspacePolicy = structuredClone(result.sandbox);
  }
  async nativePolicy(overrides = []) {
    const r = this.runtime;
    // Resolve native project/config requirements without the managed permission
    // overrides. This empty temporary thread performs no inference, login or
    // sandbox provisioning and is closed with its isolated probe worker.
    const probe = new NativeProfileProbe(r.session.cwd, r.env, { binary: { ...r.nativeSettingsBinary, args: [...r.nativeSettingsBinary.args, ...overrides] }, spawnChild: r.spawnChild });
    try {
      await probe.initialize();
      const result = await probe.rpc('thread/start', { cwd: r.session.cwd });
      if (!result.sandbox || !result.approvalPolicy || !result.approvalsReviewer) throw new Error('Native permission settings were not reported.');
      return { approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer, sandboxPolicy: result.sandbox };
    } finally { await probe.close(); }
  }
  async apply(mode, timeout = 5000) {
    const r = this.runtime;
    if (!r.idle({ settings: true }) || this.busy || r.advanced.queue.length) throw new Error('Finish the current request and clear the queue before changing permissions.');
    this.busy = true; r.changed();
    let listener, exitListener, timer, submitted = false;
    try {
      const full = ['bypass', 'full-access'].includes(mode);
      const desired = mode === 'native' ? await this.nativePolicy() : {
        approvalPolicy: mode === 'bypass' ? 'never' : 'on-request',
        approvalsReviewer: mode === 'auto-review' ? 'auto_review' : 'user',
        sandboxPolicy: full ? { type: 'dangerFullAccess' } : this.workspacePolicy || (await this.nativePolicy(['-c', 'sandbox_mode="workspace-write"'])).sandboxPolicy,
      };
      // Even an unchanged policy needs RPC validation, but may not produce a
      // settings event. A previously observed exact match is sufficient then.
      let confirmed = matches(this.policy, desired), resolveChange, rejectChange;
      const notification = new Promise((resolve, reject) => { resolveChange = resolve; rejectChange = reject; });
      notification.catch(() => {});
      listener = policy => { if (matches(policy, desired)) { confirmed = true; resolveChange(); } };
      exitListener = () => rejectChange(new Error('Codex disconnected before confirming permissions.'));
      r.on('permission-settings', listener); r.on('exit', exitListener);
      timer = setTimeout(() => rejectChange(new Error('Codex has not confirmed the applied permissions. Select permissions again to check; no worker was restarted.')), timeout);
      submitted = true;
      await r.rpc('thread/settings/update', { threadId: r.threadId, ...desired }, timeout);
      if (!confirmed) await notification;
      this.uncertain = false;
      if (desired.sandboxPolicy.type === 'workspaceWrite') this.workspacePolicy = structuredClone(desired.sandboxPolicy);
    } catch (error) { this.uncertain ||= submitted && !error.nativeRejected; throw error; }
    finally { clearTimeout(timer); if (listener) r.off('permission-settings', listener); if (exitListener) r.off('exit', exitListener); this.busy = false; r.changed(); }
  }
}
