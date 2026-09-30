import { open } from 'node:fs/promises';

// Read one complete record, with a bounded allocation; never accept partial JSON.
export async function codexMetadata(file, { allowCompleteEof = false } = {}) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const chunks = [];
    for (let offset = 0; offset < 2 * 1024 * 1024;) {
      const buffer = Buffer.alloc(Math.min(16384, 2 * 1024 * 1024 - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) {
        if (!allowCompleteEof || !chunks.length) return null;
        const record = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
        return record.type === 'session_meta' && /^[a-f0-9-]{36}$/i.test(record.payload?.id || '') ? record : null;
      }
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end));
      if (end >= 0) {
        const record = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
        return record.type === 'session_meta' && /^[a-f0-9-]{36}$/i.test(record.payload?.id || '') ? record : null;
      }
      offset += bytesRead;
    }
  } catch { return null; }
  finally { await handle.close(); }
  return null;
}
