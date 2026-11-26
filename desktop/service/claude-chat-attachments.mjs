import path from 'node:path';
import { realpath, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { imageExtension } from './attachments.mjs';

export const CLAUDE_ATTACHMENT_LIMIT = 20;
export const CLAUDE_IMAGE_LIMIT = 4;
export const CLAUDE_IMAGE_BYTES = 4 * 1024 * 1024;
export const CLAUDE_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
export const CLAUDE_INPUT_BYTES = 10 * 1024 * 1024;
export const CLAUDE_OUTPUT_FRAME_CHARS = 12 * 1024 * 1024;
const imagePattern = /\.(png|jpe?g|gif|webp)$/i;
const unsupportedImage = /\.(bmp|svg|tiff?|heic|heif|avif|ico)$/i;
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export async function inspectClaudeAttachment(file, { content = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 8192 || /[\x00-\x1f\x7f]/.test(file)) throw new Error('Choose a local file or folder with an absolute path.');
  const absolute = path.resolve(file), resolvedPath = await realpath(absolute), info = await stat(resolvedPath);
  if (!info.isFile() && !info.isDirectory()) throw new Error('Attach a regular file or folder.');
  const metadata = { path: absolute, resolvedPath, name: path.basename(absolute), kind: info.isDirectory() ? 'folder' : 'file', size: info.size };
  if (info.isDirectory()) return { metadata };
  if (unsupportedImage.test(absolute)) throw new Error('Claude image attachments support PNG, JPEG, GIF and WebP. Convert this image before attaching it.');
  if (!imagePattern.test(absolute)) return { metadata };
  const handle = await open(resolvedPath, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || !current.size || current.size > CLAUDE_IMAGE_BYTES) throw new Error('Choose a Claude image of 4 MB or less.');
    // Read at most one bounded image, even if the file grows after stat.
    const buffer = Buffer.alloc(current.size + 1);
    let length = 0;
    while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat();
    if (length !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw new Error('The image changed while being attached. Try attaching it again.');
    const bytes = buffer.subarray(0, length), expected = path.extname(absolute).toLowerCase().replace('.jpeg', '.jpg');
    let extension;
    try { extension = imageExtension(bytes); } catch { throw new Error('The image content does not match its PNG, JPEG, GIF or WebP filename.'); }
    if (!mimeTypes[extension] || extension !== expected) throw new Error('The image content does not match its PNG, JPEG, GIF or WebP filename.');
    Object.assign(metadata, { kind: 'image', mimeType: mimeTypes[extension], size: length, sha256: createHash('sha256').update(bytes).digest('hex') });
    return { metadata, ...(content ? { block: { type: 'image', source: { type: 'base64', media_type: metadata.mimeType, data: bytes.toString('base64') } } } : {}) };
  } finally { await handle.close(); }
}

export function validateClaudeAttachments(items) {
  if (items.length > CLAUDE_ATTACHMENT_LIMIT) throw new Error('Attach at most 20 files or folders to a Claude message.');
  const images = items.filter(item => item.kind === 'image');
  if (images.length > CLAUDE_IMAGE_LIMIT || images.reduce((sum, item) => sum + item.size, 0) > CLAUDE_TOTAL_IMAGE_BYTES) throw new Error('A Claude message supports up to 4 images and 6 MB of images in total.');
}

export async function claudeAttachmentInput(text, selected) {
  const attachments = [], images = [];
  for (const previous of selected) {
    if (previous.unavailable) throw new Error('An imported attachment is unavailable. Remove it and attach a local file before sending.');
    const { metadata, block } = await inspectClaudeAttachment(previous.path, { content: true });
    if (previous.kind !== metadata.kind || previous.resolvedPath !== metadata.resolvedPath || previous.sha256 && previous.sha256 !== metadata.sha256) throw new Error('An attachment changed since selection. Remove it and attach it again. Your message has not been sent.');
    attachments.push(metadata); if (block) images.push(block);
  }
  validateClaudeAttachments(attachments);
  const references = attachments.filter(item => item.kind !== 'image');
  const prompt = text + (references.length ? '\n\nUser-selected local file/folder references (not embedded file contents; use native tools and permissions as needed):\n' + references.map(item => JSON.stringify({ path: item.path, kind: item.kind })).join('\n') : '');
  if (prompt.length > 256000) throw new Error('The message and attachment paths are too long. Remove some attachments.');
  const blocks = [...(prompt ? [{ type: 'text', text: prompt }] : []), ...images];
  if (Buffer.byteLength(JSON.stringify(blocks)) > CLAUDE_INPUT_BYTES - 16384) throw new Error('The Claude message and images exceed the input limit.');
  return { blocks, attachments };
}
