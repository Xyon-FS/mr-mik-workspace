import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { within } from './util.mjs';
import { transferTarget } from './import-transaction.mjs';

const extensions = /\.(png|jpe?g|webp|gif|bmp|svg|mp3|wav|ogg|m4a|flac|mp4|webm|mov|pdf|txt|md|csv|tsv|json|docx|xlsx|pptx)$/i;
const privatePath = /(?:^|[\\/])(?:\.env(?:[.\\/]|$)|\.(?:ssh|aws|azure|gnupg)(?:[\\/]|$)|node_modules(?:[\\/]|$)|auth(?:[.\\/-]|$)|credentials?(?:[.\\/-]|$)|tokens?(?:[.\\/-]|$)|[^\\/]*\.(?:pem|key|pfx|p12|kdbx)$)/i;
const maxFile = 128 * 1024 ** 2, maxTotal = 1024 ** 3, maxRefs = 4096;
const identity = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
const sourceKey = value => /^[a-z]:[\\/]/i.test(value) || process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
const mediaKey = value => JSON.stringify([value.agent, value.threadId, sourceKey(value.source)]);
const localPath = value => {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return null;
  try {
    if (/^file:/i.test(value)) { const url = new URL(value); if (url.hostname || url.search || url.hash) return null; value = fileURLToPath(url); }
    return path.isAbsolute(value) && !/^[\\/]{2}/.test(value) ? path.resolve(value) : null;
  } catch { return null; }
};
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

// Only typed media/file references and rendered message links are inspected.
// Commands, reasoning, arbitrary tool arguments and unsent draft files are not.
export function referencedMedia(row) {
  const result = new Set();
  const add = value => { const file = localPath(value); if (file) result.add(file); };
  const message = value => {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(/!?\[[^\]\r\n]*\]\((?:<([^>]+)>|([^\r\n]+?))\)/g)) {
      const link = (match[1] || match[2]).split('#')[0];
      try { add(/^file:/i.test(link) ? link : decodeURIComponent(link)); } catch { add(link); }
    }
    const attached = value.match(/(?:^|\n)Attached paths:\s*\n([\s\S]*)$/);
    if (attached) for (const line of attached[1].split('\n')) { try { add(JSON.parse(line.trim())); } catch { /* Not an app attachment line. */ } }
  };
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node)) { for (const item of node.slice(0, 500)) visit(item, depth + 1); return; }
    if (['localImage', 'local_image', 'imageView', 'image_view', 'imageGeneration', 'image_generation_call', 'image_generation'].includes(node.type)) for (const key of ['path', 'savedPath', 'saved_path', 'result']) add(node[key]);
    if (['input_image', 'image', 'file', 'resource', 'resource_link'].includes(node.type)) {
      for (const key of ['path', 'image_url', 'url', 'uri']) add(node[key]);
      if (node.source?.type === 'file') add(node.source.path);
    }
    if (['message', 'user_message', 'agent_message'].includes(node.type) || ['user', 'assistant'].includes(node.role)) {
      message(node.text); message(node.message);
      for (const file of node.local_images || []) add(typeof file === 'string' ? file : file.path);
    }
    if (['text', 'input_text', 'output_text'].includes(node.type)) message(node.text);
    for (const key of ['payload', 'message', 'content', 'result', 'resource', 'contentItems']) visit(node[key], depth + 1);
  };
  visit(row); return [...result];
}

export async function readMediaIndex(stateDir) {
  const file = path.join(stateDir, 'conversation-media.json');
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info === null) return { version: 1, refs: [] };
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 ** 2) throw new Error('Conversation media index is unsafe or too large.');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 16 * 1024 ** 2) throw new Error('Conversation media index is too large.');
  const value = JSON.parse(text); validateMediaManifest(value); return value;
}

export function validateMediaManifest(media, manifest) {
  if (!media || media.version !== 1 || !Array.isArray(media.refs) || media.refs.length > maxRefs || media.omissions != null && (!Array.isArray(media.omissions) || media.omissions.length > maxRefs)) throw new Error('Invalid conversation media inventory.');
  const keys = new Set();
  for (const item of media.omissions || []) if (!item || !['codex', 'claude'].includes(item.agent) || typeof item.threadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.threadId) || typeof item.source !== 'string' || item.source.length > 8192 || typeof item.reason !== 'string' || item.reason.length > 500) throw new Error('Invalid conversation media omission.');
  for (const ref of media.refs) {
    if (!ref || !['codex', 'claude'].includes(ref.agent) || typeof ref.threadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(ref.threadId) || typeof ref.source !== 'string' || !ref.source || ref.source.length > 8192 || /[\x00-\x1f]/.test(ref.source) || typeof ref.target !== 'string' || !/^(context|knowledge|processes|inbox|workspace|projects)\//.test(ref.target) || ref.target.split('/').some(part => !part || part.startsWith('.') || /[\\:\x00-\x1f]/.test(part)) || privatePath.test(ref.target) || !extensions.test(ref.target) || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || keys.has(mediaKey(ref))) throw new Error('Invalid conversation media reference.');
    keys.add(mediaKey(ref));
    if (manifest && (!manifest.native.some(item => item.agent === ref.agent && item.id === ref.threadId) || !manifest.files.some(item => item.name === ref.target && item.sha256 === ref.sha256 && item.size === ref.bytes))) throw new Error('Conversation media is not associated with a verified conversation and file.');
  }
}

export async function resolveConversationMedia(repo, stateDir, agent, threadId, requested) {
  await transferTarget(repo, path.join(stateDir, 'conversation-media.json'));
  const index = await readMediaIndex(stateDir);
  const ref = index.refs.find(item => item.agent === agent && item.threadId === threadId && sourceKey(item.source) === sourceKey(requested));
  if (!ref) return null;
  const target = await transferTarget(repo, path.join(repo, ...ref.target.split('/')));
  return await realpath(target);
}

async function inspect(file) {
  if (privatePath.test(file) || !extensions.test(file)) throw new Error('private or unsupported file');
  for (let current = file; ; current = path.dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('linked file or parent directory');
    if (path.dirname(current) === current) break;
  }
  const actual = await realpath(file), value = await lstat(actual);
  if (privatePath.test(actual) || !value.isFile()) throw new Error('private or non-regular file');
  return { path: actual, bytes: value.size, identity: identity(value) };
}

export async function reviewConversationMedia(repo, stateDir, transcripts) {
  await transferTarget(repo, path.join(stateDir, 'conversation-media.json'));
  const prior = await readMediaIndex(stateDir), files = new Map(), refs = [], omissions = [];
  const priorRefs = new Map(prior.refs.map(ref => [mediaKey(ref), ref]));
  const seen = new Set(); let total = 0;
  for (const transcript of transcripts) {
    const stream = createReadStream(transcript.path), lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        for (const source of referencedMedia(JSON.parse(line))) {
          const ref = { agent: transcript.agent, threadId: transcript.id, source }, key = mediaKey(ref);
          if (seen.has(key)) continue;
          if (seen.size >= maxRefs - 1) {
            omissions.push({ agent: transcript.agent, threadId: transcript.id, source: '(additional conversation files)', reason: 'Media review limit reached; remaining references are excluded. Native transcripts are retained.' });
            return { files: [...files.values()], refs, omissions, totalBytes: total, truncated: true };
          }
          seen.add(key);
          try {
            const previous = priorRefs.get(key);
            const file = previous ? await transferTarget(repo, path.join(repo, ...previous.target.split('/'))) : source;
            const entry = await inspect(file);
            const relative = path.relative(repo, entry.path).replaceAll('\\', '/');
            const hub = within(repo, entry.path) && /^(context|knowledge|processes|inbox|workspace|projects)\//.test(relative);
            if (!hub && entry.bytes > maxFile) throw new Error('exceeds the 128 MB external-file limit');
            if (!files.has(entry.path)) { if (!hub && total + entry.bytes > maxTotal) throw new Error('exceeds the 1 GB external-media limit'); files.set(entry.path, { ...entry, hub, relative }); if (!hub) total += entry.bytes; }
            refs.push({ ...ref, file: entry.path });
          } catch (error) { omissions.push({ ...ref, reason: error.code === 'ENOENT' ? 'File missing' : error.code === 'EACCES' || error.code === 'EPERM' ? 'File inaccessible' : String(error.message).slice(0, 500) }); }
        }
      }
    } finally { lines.close(); stream.destroy(); }
  }
  return { files: [...files.values()], refs, omissions, totalBytes: total };
}

export async function prepareConversationMedia(plan, includeExternal, includedNames) {
  const entries = new Map(), refs = [], omissions = [...plan.omissions], preparedFiles = new Map(), blobs = new Map();
  const prepare = async reviewed => {
    if (preparedFiles.has(reviewed.path)) return preparedFiles.get(reviewed.path);
    const current = await inspect(reviewed.path);
    if (current.identity !== reviewed.identity) throw new Error('Conversation media changed after review. Review export again.');
    const sha256 = await digest(current.path), after = await inspect(current.path);
    if (after.identity !== current.identity) throw new Error('Conversation media changed while hashing. Review export again.');
    const target = reviewed.hub ? reviewed.relative : blobs.get(sha256) || `inbox/attachments/conversation-media/${sha256}${path.extname(current.path).toLowerCase()}`;
    blobs.set(sha256, target);
    if (!reviewed.hub && !includedNames.has(target)) entries.set(target, { name: target, source: current.path, expectedHash: sha256 });
    const value = { target, sha256, bytes: current.bytes }; preparedFiles.set(reviewed.path, value); return value;
  };
  for (const file of plan.files.filter(file => file.hub && includedNames.has(file.relative))) await prepare(file);
  for (const ref of plan.refs) {
    const reviewed = plan.files.find(file => file.path === ref.file);
    if (!reviewed.hub && !includeExternal) { omissions.push({ agent: ref.agent, threadId: ref.threadId, source: ref.source, reason: 'External media excluded by export choice' }); continue; }
    if (reviewed.hub && !includedNames.has(reviewed.relative)) { omissions.push({ agent: ref.agent, threadId: ref.threadId, source: ref.source, reason: 'Hub file excluded by archive privacy filters' }); continue; }
    const prepared = await prepare(reviewed);
    refs.push({ agent: ref.agent, threadId: ref.threadId, source: ref.source, ...prepared });
  }
  return { entries: [...entries.values()], media: { version: 1, refs, omissions } };
}

export function mergeMediaIndexes(local, incoming, acceptedKeys, replaceKeys = new Set()) {
  const refs = new Map(local.refs.map(ref => [mediaKey(ref), ref]));
  for (const ref of incoming.refs) {
    const key = `${ref.agent}:${ref.threadId}`, previous = refs.get(mediaKey(ref));
    if (acceptedKeys.has(key) && (!previous || previous.sha256 === ref.sha256 || replaceKeys.has(key))) refs.set(mediaKey(ref), ref);
  }
  if (refs.size > maxRefs) throw new Error('Imported conversation media index exceeds 4096 references.');
  return { version: 1, refs: [...refs.values()] };
}
