// node-pty's Windows kill closes the native pseudo-console handle. Stop, startup
// cancellation and onExit cleanup can all reach it, including re-entrantly. The
// same owned PTY must never close that native handle a second time.
export function protectTerminalKill(proc) {
  const kill = proc.kill.bind(proc);
  let requested = false;
  proc.kill = (...args) => {
    if (requested) return;
    requested = true;
    try { return kill(...args); }
    catch (error) { requested = false; throw error; }
  };
  return proc;
}
