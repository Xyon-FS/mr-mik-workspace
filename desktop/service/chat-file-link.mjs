import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFileLink } from './development-files.mjs';

export function resolveChatFileLink(cwd, href) {
  const { file, line, column } = splitFileLink(href);
  let requested = /^file:/i.test(file) ? fileURLToPath(file) : decodeURIComponent(file);
  if (process.platform === 'win32') {
    // Markdown links may spell a drive path like a URL pathname.
    requested = requested.replace(/^[\\/](?=[a-z]:[\\/])/i, '').replace(/^([a-z]):[\\/]+(?:\1:[\\/]+)+/i, '$1:/');
  }
  return { file: path.resolve(cwd, requested), line, column };
}
