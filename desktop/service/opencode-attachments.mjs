import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCodeMembers } from './opencode-transfer.mjs';
import { isV2Transfer, validateV2Transfer } from './opencode-v2-transfer.mjs';

const maxFile = 16 * 1024 ** 2;
const maxTotal = 32 * 1024 ** 2;
const sensitive = /(?:^|[\\/])(?:\.env(?:[.\\/]|$)|\.(?:codex|claude|ssh|aws|azure|gnupg)(?:[\\/]|$)|\.(?:npmrc|netrc)$|id_(?:rsa|ed25519)(?:[.]|$)|auth(?:[.\\/-]|$)|credentials?(?:[.\\/-]|$)|tokens?(?:[.\\/-]|$)|[^\\/]*\.(?:pem|key|pfx|p12|kdbx)$)/i;
const identity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');

export function attachmentSlots(data) {
  if (isV2Transfer(data)) {
    validateV2Transfer(data, data.info?.id, { portable: false });
    return openCodeMembers(data).flatMap(member => member.messages.flatMap(message => [
      ...(message.files || []).map(file => ({ mime: file.mime,
        get url() { return `data:${file.mime};base64,${file.data}`; },
        set url(value) { file.data = value.slice(value.indexOf(',') + 1); file.source = { type: 'inline' }; },
        normalize() { file.source = { type: 'inline' }; },
      })),
      ...(message.content || []).flatMap(content => content.type === 'tool' ? (content.state?.content || []).filter(item => item.type === 'file').map(item => ({ mime: item.mime, get url() { return item.uri; }, set url(value) { item.uri = value; } })) : []),
    ]));
  }
  return openCodeMembers(data).flatMap(member => member.messages.flatMap(message => message.parts.flatMap(part => [
    ...(part.type === 'file' ? [part] : []),
    ...(part.type === 'tool' ? (part.state?.attachments || []) : []),
  ])));
}

async function localFile(url) {
  let file;
  try {
    if (typeof url !== 'string') throw new Error();
    if (/^file:/i.test(url)) {
      const parsed = new URL(url);
      if (parsed.hostname || parsed.search || parsed.hash) throw new Error();
      file = fileURLToPath(parsed);
    } else if (path.isAbsolute(url)) file = url;
    else throw new Error();
  } catch { throw new Error('Unsupported OpenCode attachment URL. Only local files can be reviewed; use light export.'); }
  file = path.resolve(file);
  if (/^[\\/]{2}/.test(file) || /:[^\\/]/.test(file.slice(2)) || sensitive.test(file)) throw new Error('An OpenCode attachment points to a private or unsupported location. Use light export.');
  // Reject symlinks/junctions in every component, including directory parents.
  for (let current = file; ; current = path.dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked OpenCode attachment paths are not transferable. Use light export.');
    if (path.dirname(current) === current) break;
  }
  // Windows TEMP commonly uses an 8.3 alias (ADMINI~1). Canonicalize only after
  // inspecting every component; also check the resolved spelling for secrets.
  file = await realpath(file);
  if (sensitive.test(file)) throw new Error('An OpenCode attachment points to a private location. Use light export.');
  const info = await lstat(file);
  if (!info.isFile() || info.size > maxFile) throw new Error('OpenCode attachments must be regular files up to 16 MB each. Use light export.');
  return { path: file, bytes: info.size, identity: identity(info) };
}

// Review inspects metadata only. File contents are read only after the user's
// explicit confirmation, from a handle checked against the reviewed identity.
export async function reviewAttachments(families) {
  const files = new Map();
  for (const data of families) for (const slot of attachmentSlots(data)) {
    if (/^data:/i.test(slot.url || '')) continue;
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(slot.mime || '') || slot.mime === 'application/x-directory') throw new Error('Unsupported OpenCode attachment media type. Use light export.');
    const item = await localFile(slot.url);
    files.set(item.path.toLowerCase(), item);
  }
  const result = [...files.values()];
  if (result.length > 128 || result.reduce((sum, item) => sum + item.bytes, 0) > maxTotal) throw new Error('OpenCode attachment export is limited to 128 files and 32 MB total. Use light export.');
  return result;
}

export async function embedAttachments(data, approved) {
  const result = structuredClone(data), buffers = new Map();
  let serializedBytes = Buffer.byteLength(JSON.stringify(data));
  for (const slot of attachmentSlots(result)) {
    if (/^data:/i.test(slot.url || '')) { slot.normalize?.(); continue; }
    const current = await localFile(slot.url), expected = approved.find(item => item.path.toLowerCase() === current.path.toLowerCase());
    if (!expected || expected.identity !== current.identity) throw new Error('OpenCode attachment changed or was not approved. Review export again.');
    let bytes = buffers.get(current.path.toLowerCase());
    if (!bytes) {
      const handle = await open(current.path, 'r');
      try {
        if (identity(await handle.stat()) !== expected.identity) throw new Error('OpenCode attachment changed before copying.');
        bytes = Buffer.alloc(expected.bytes);
        let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error('OpenCode attachment changed while copying.'); offset += read.bytesRead; }
        if (identity(await handle.stat()) !== expected.identity || (await localFile(slot.url)).identity !== expected.identity) throw new Error('OpenCode attachment changed while copying.');
      } finally { await handle.close(); }
      buffers.set(current.path.toLowerCase(), bytes);
    }
    const url = `data:${slot.mime};base64,${bytes.toString('base64')}`;
    serializedBytes += Buffer.byteLength(JSON.stringify(url)) - Buffer.byteLength(JSON.stringify(slot.url));
    if (serializedBytes > 64 * 1024 ** 2) throw new Error('Embedded OpenCode family exceeds the supported 64 MB limit. Use light export.');
    slot.url = url;
  }
  if (isV2Transfer(result)) validateV2Transfer(result);
  return result;
}
