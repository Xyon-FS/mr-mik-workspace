import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { inspectClaudeAttachment, validateClaudeAttachments, CLAUDE_IMAGE_BYTES } from '../claude-chat-attachments.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
test('Claude attachment preflight checks signature, supported formats, size and total image limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-images-'));
  const image = path.join(root, 'test.png'); await writeFile(image, png);
  const { metadata } = await inspectClaudeAttachment(image);
  assert.equal(metadata.kind, 'image'); assert.equal(metadata.sha256.length, 64);
  assert.throws(() => validateClaudeAttachments(Array(5).fill(metadata)), /up to 4 images/);
  assert.throws(() => validateClaudeAttachments([{ ...metadata, size: 4e6 }, { ...metadata, size: 4e6 }]), /6 MB/);
  assert.throws(() => validateClaudeAttachments(Array(21).fill({ kind: 'file' })), /at most 20/);
  await writeFile(image, 'not png'); await assert.rejects(inspectClaudeAttachment(image), /does not match/);
  await writeFile(image, Buffer.alloc(CLAUDE_IMAGE_BYTES + 1)); await assert.rejects(inspectClaudeAttachment(image), /4 MB/);
  const svg = path.join(root, 'test.svg'); await writeFile(svg, '<svg/>'); await assert.rejects(inspectClaudeAttachment(svg), /Convert/);
  await assert.rejects(inspectClaudeAttachment('relative.txt'), /absolute path/);
});
