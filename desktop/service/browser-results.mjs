// Compact successful MCP observations, never cache/replay browser actions.
// Explicit snapshots and errors always retain their complete native output.
export function compactBrowserResult(record, name, result) {
  if (result.isError) { record.lastSnapshot = null; return result; }
  const explicit = name === 'browser_snapshot';
  return { ...result, content: result.content?.map(item => {
    if (item.type !== 'text') return item;
    let text = item.text.replace(/^### Ran Playwright code\r?\n```[^\n]*\n[\s\S]*?^```\r?\n?/gm, '');
    const snapshot = /^### Snapshot\r?\n[\s\S]*?(?=^### |$(?![\s\S]))/m.exec(text);
    if (snapshot) {
      const signature = item[observationHash] || snapshot[0].replace(/^- \[Snapshot\]\([^\n]+\)\r?\n?/m, '').trim();
      const hasObservation = signature !== '### Snapshot';
      if (!explicit && hasObservation && record.lastSnapshot === signature) {
        const link = /^- \[Snapshot\]\([^\n]+\)/m.exec(snapshot[0])?.[0];
        text = text.replace(snapshot[0], `### Snapshot\nUnchanged from the last returned snapshot; reuse its element references. Use browser_find for a targeted lookup or browser_snapshot for a full observation.\n${link || ''}\n`);
      }
      record.lastSnapshot = hasObservation ? signature : null;
    }
    return { ...item, text: text.trim() };
  }) };
}
import path from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import { within } from './util.mjs';
import { createHash } from 'node:crypto';
const observationHash = Symbol('snapshotContentHash');

export async function inlineBrowserObservation(record, name, result) {
  if (result.isError || name === 'browser_snapshot' || !record.folder) return result;
  const content = [];
  for (const item of result.content || []) {
    const match = item.type === 'text' && /^### Snapshot\r?\n- \[Snapshot\]\(([^\n]+)\)/m.exec(item.text);
    if (!match) { content.push(item); continue; }
    try {
      const file = match[1], root = await realpath(record.folder), info = await lstat(file);
      if (path.extname(file) !== '.yml' || !info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 || !within(root, await realpath(file))) { content.push(item); continue; }
      const handle = await open(file, 'r');
      let snapshot;
      try { const buffer = Buffer.alloc(512 * 1024 + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > 512 * 1024) { content.push(item); continue; } snapshot = buffer.subarray(0, bytesRead).toString('utf8'); }
      finally { await handle.close(); }
      const preview = snapshot.length <= 12000 ? snapshot : snapshot.slice(0, 12000).replace(/\n[^\n]*$/, '');
      const note = snapshot.length > 12000 ? '\nSnapshot preview shortened. Use browser_find for specific elements or browser_snapshot for the full page; the complete snapshot file is linked above.' : '';
      content.push({ ...item, [observationHash]: createHash('sha256').update(snapshot).digest('hex'), text: item.text.replace(match[0], `${match[0]}\n\n${preview}${note}`) });
    } catch { content.push(item); } // Preserve the native file link on read failure.
  }
  return { ...result, content };
}

