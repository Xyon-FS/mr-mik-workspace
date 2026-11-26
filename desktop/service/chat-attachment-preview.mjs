import path from 'node:path';
import { open } from 'node:fs/promises';
import { isDevelopmentFile } from './development-files.mjs';
const textExtensions = new Set('txt md markdown json csv tsv js jsx ts tsx css html htm xml yaml yml toml ini log mjs cjs py cs cpp h hpp sh ps1 sql svg mermaid mmd'.split(' '));
export async function attachmentPreview(actual, info, original) {
  const extension = path.extname(actual).slice(1).toLowerCase();
  const value = { name: path.basename(actual), kind: 'file', live: true, size: info.size, modifiedAt: info.mtime.toISOString(), identity: `${actual}:${info.mtimeMs}:${info.size}` };
  if (info.isDirectory()) return { ...value, kind: 'folder', message: 'Folder reference. Files remain in their original location.' };
  if (!info.isFile()) return { ...value, message: 'This reference has no file preview.' };
  if (original?.mtimeMs && (original.mtimeMs !== info.mtimeMs || original.size !== info.size)) value.message = 'This file changed since it was attached. The preview shows current contents.';
  if (textExtensions.has(extension) || isDevelopmentFile(actual)) {
    const handle = await open(actual, 'r');
    try { const buffer = Buffer.alloc(Math.min(info.size, 200000)), {bytesRead} = await handle.read(buffer, 0, buffer.length, 0); return { ...value, kind: 'text', text: buffer.subarray(0,bytesRead).toString('utf8'), truncated: info.size > bytesRead }; }
    finally { await handle.close(); }
  }
  if (info.size > 10 * 1024 * 1024) return { ...value, message: 'This local reference exceeds the 10 MB preview limit. The attached path is unchanged.' };
  return value;
}
