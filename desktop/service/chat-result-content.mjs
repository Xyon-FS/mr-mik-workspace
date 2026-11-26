import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const resultLimit = 10 * 1024 * 1024;
const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm' };
const previewTypes = new Set([...Object.values(types), 'audio/webm', 'audio/x-wav', 'video/ogg']);
export function resultKind(mime) { return previewTypes.has(mime) ? mime.split('/')[0] : mime?.startsWith('text/') ? 'text' : 'file'; }
export function fileResultMime(file) { return types[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream'; }

export function projectResultContent(item) {
  const content = Array.isArray(item.result?.content) ? item.result.content : Array.isArray(item.contentItems) ? item.contentItems : null;
  if (!content) return null;
  const assets = [], notes = [];
  let hasText = false;
  for (const part of content.slice(0, 40)) {
    if (['text', 'inputText'].includes(part?.type)) { hasText = true; notes.push(String(part.text || '')); continue; }
    if (!part || typeof part !== 'object') { notes.push('Unsupported tool content.'); continue; }
    const resource = part.type === 'resource' ? part.resource || {} : part;
    const uri = resource.uri || part.imageUrl || part.audioUrl;
    let mime = String(resource.mimeType || (part.type === 'inputAudio' ? 'audio/wav' : 'application/octet-stream')).toLowerCase();
    let data = resource.blob || part.data, text = resource.text, localPath = null;
    if (typeof uri === 'string' && uri.startsWith('data:')) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]*)$/.exec(uri);
      if (match) { mime = match[1].toLowerCase(); data = match[2]; }
    } else if (typeof uri === 'string') {
      try { if (uri.startsWith('file:')) localPath = fileURLToPath(uri); else if (path.isAbsolute(uri)) localPath = uri; } catch { /* Unsupported file URI. */ }
      if (localPath && !resource.mimeType) mime = fileResultMime(localPath);
    }
    const name = String(resource.name || resource.title || (localPath && path.basename(localPath)) || `Tool result ${assets.length + 1}`).slice(0, 200);
    let kind = resultKind(mime);
    if (typeof data === 'string' && data.length <= Math.ceil(resultLimit / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(data.replace(/[\r\n]/g, ''))) assets.push({ kind, name, mimeType: mime, data: data.replace(/[\r\n]/g, '') });
    else if (typeof text === 'string' && Buffer.byteLength(text) <= resultLimit) assets.push({ kind: 'text', name, mimeType: mime, text });
    else if (localPath) assets.push({ kind, name, mimeType: mime, path: localPath });
    else if (typeof uri === 'string' && /^https?:\/\//i.test(uri)) assets.push({ kind: 'link', name, mimeType: mime, uri: uri.slice(0, 8192) });
    else assets.push({ kind: 'unsupported', name, mimeType: mime });
    notes.push(`${name} · ${assets.at(-1).kind}`);
  }
  return { assets, summary: notes.join('\n'), hasText };
}

export function resultBytes(asset, preview = false) {
  if (preview && !previewTypes.has(asset.mimeType)) throw new Error('This result has no supported media preview. Save it instead.');
  const bytes = typeof asset.data === 'string' ? Buffer.from(asset.data, 'base64') : typeof asset.text === 'string' ? Buffer.from(asset.text) : null;
  if (!bytes || bytes.length > resultLimit) throw new Error('This result is unavailable or exceeds the 10 MB preview limit.');
  return { bytes, mimeType: preview ? asset.mimeType : 'application/octet-stream' };
}
