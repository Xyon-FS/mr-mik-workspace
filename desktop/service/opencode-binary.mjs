import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Resolve only the installation selected by PATH. An old npm package elsewhere
// must never shadow the selected V2 installation. Explicit paths are for isolated
// development tests, not a user-facing version preference.
export function resolveOpenCodeBinary(executable, { explicit, exists = existsSync, read = readFileSync, node = process.execPath } = {}) {
  if (explicit) {
    if (!path.isAbsolute(explicit) || !exists(explicit)) throw new Error('The explicit OpenCode executable does not exist.');
    executable = explicit;
  }
  if (!executable) return { file: null, args: [] };
  if (!/\.(cmd|bat|ps1)$/i.test(executable)) return { file: executable, args: [] };
  // Standard npm shims identify their own package. Do not choose an adjacent
  // package by existence alone when both generations are installed.
  let shim = '';
  try { shim = read(executable, 'utf8').slice(0, 16384).replaceAll('\\', '/'); } catch { /* Keep the literal shell wrapper. */ }
  const folder = path.dirname(executable);
  for (const [marker, relative, native] of [
    ['node_modules/@opencode/cli/bin/opencode.exe', 'node_modules/@opencode/cli/bin/opencode.exe', true],
    ['node_modules/@opencode/cli/bin/opencode.cjs', 'node_modules/@opencode/cli/bin/opencode.cjs', false],
    ['node_modules/opencode-ai/bin/opencode', 'node_modules/opencode-ai/bin/opencode.exe', true],
    ['node_modules/opencode-ai/bin/opencode', 'node_modules/opencode-ai/bin/opencode', false],
  ]) {
    const target = path.join(folder, relative);
    if (shim.includes(marker) && exists(target)) return native ? { file: target, args: [] } : { file: node, args: [target] };
  }
  return { file: executable, args: [] };
}
