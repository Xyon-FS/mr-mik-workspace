import { NativeProfileProbe } from './codex-profile-probe.mjs';

// Provision through the canonical home, never through shadow-directory junctions.
// This process initializes RPC only: it neither starts a conversation nor reads auth.
export async function setupSharedSandbox({ cwd, env, binary, spawnChild }) {
  let complete, fail, probe;
  const finished = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // Exit can race initialization; attach a handler before starting any RPC.
  finished.catch(() => {});
  try {
    probe = new NativeProfileProbe(cwd, env, {
      binary, spawnChild,
      onNotification: message => {
        if (message.method === 'windowsSandbox/setupCompleted' && message.params?.mode === 'elevated') complete(message.params);
      },
      onExit: () => fail(new Error('The sandbox setup connection stopped before completion was confirmed. Check local tool diagnostics before retrying.')),
    });
    await probe.initialize();
    let response;
    try { response = await probe.rpc('windowsSandbox/setupStart', { mode: 'elevated', cwd }); }
    catch (error) {
      // An acknowledgement timeout is not proof the native setup stopped.
      if (error.uncertain) return await finished;
      throw error;
    }
    if (!response?.started) throw new Error('Codex did not start shared sandbox setup.');
    // Do not impose a completion timeout or terminate a pending consent dialog.
    return await finished;
  } finally { await probe?.close(); }
}
