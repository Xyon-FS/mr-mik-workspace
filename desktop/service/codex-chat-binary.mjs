import { createRequire } from 'node:module';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const graphicalCodexVersion = '0.166.0';

// Graphical workers use only this app-owned package. Never fall back to PATH,
// npm's global installation or the desktop app's executable when it is missing.
export function graphicalCodexBinary({ packageRoot } = {}) {
  try {
    const root = packageRoot || path.dirname(require.resolve('@openai/codex-win32-x64/package.json'));
    const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (metadata.name !== '@openai/codex' || metadata.version !== `${graphicalCodexVersion}-win32-x64`) throw new Error('version');
    const vendor = path.join(root, 'vendor/x86_64-pc-windows-msvc');
    const file = path.join(vendor, 'bin/codex.exe');
    for (const target of [file, path.join(vendor, 'codex-resources/codex-windows-sandbox-setup.exe'), path.join(vendor, 'codex-resources/codex-command-runner.exe')]) {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('incomplete');
    }
    return { file, args: [], version: graphicalCodexVersion };
  } catch {
    throw new Error('The dedicated graphical Codex runtime is missing or incomplete. Repair the Mr. Mik installation. The existing CLI installation has not been changed.');
  }
}
