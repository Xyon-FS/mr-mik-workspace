// Complete every independent cleanup before reporting failures. In particular,
// an account/browser cleanup failure must never skip native writer shutdown.
export async function settleCleanup(tasks, errors) {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
  for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
}

// Leave time for bounded native exit, persistence and remaining cleanup before
// the desktop host's final process-tree deadline (35 seconds).
export const SERVICE_SHUTDOWN_MS = 30000;

export function stopService(service, { exit = code => process.exit(code), report = () => {}, timeoutMs = SERVICE_SHUTDOWN_MS } = {}) {
  let stopping;
  return () => {
    if (!stopping) {
      let finished = false;
      const finish = code => {
        if (finished) return;
        finished = true; clearTimeout(deadline);
        if (code) report();
        exit(code);
      };
      const deadline = setTimeout(() => finish(1), timeoutMs);
      deadline.unref?.();
      stopping = Promise.resolve().then(() => service.close()).then(
        () => finish(0),
        () => finish(1),
      );
    }
    return stopping;
  };
}
