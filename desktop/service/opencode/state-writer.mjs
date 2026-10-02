import { writeFileSync, renameSync } from 'node:fs';
import { rename as renameAsync } from 'node:fs/promises';

export async function replaceControlFile(source, destination, active, { replace = renameAsync, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!active()) throw new Error('The OpenCode chat changed before control delivery.');
    try { await replace(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 39) throw error;
      await pause(30);
    }
  }
}

// Windows readers can briefly prevent atomic replacement. Keep only the newest
// bounded observer state and retry without blocking native events or requests.
export function createStateWriter(file, { write = writeFileSync, rename = renameSync, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let pending = null, timer = null, attempts = 0, disposed = false;
  const flush = () => {
    timer = null;
    if (pending == null) return;
    try {
      write(`${file}.tmp`, pending, { mode: 0o600 });
      rename(`${file}.tmp`, file);
      pending = null; attempts = 0;
    } catch (error) {
      if (!disposed && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code) && ++attempts < 40) {
        timer = schedule(flush, 30); timer?.unref?.();
      } else { pending = null; attempts = 0; }
    }
  };
  const save = state => {
    if (disposed) return;
    pending = JSON.stringify(state);
    attempts = 0;
    if (timer == null) flush();
  };
  save.dispose = () => { disposed = true; if (timer != null) cancel(timer); timer = null; flush(); };
  return save;
}
