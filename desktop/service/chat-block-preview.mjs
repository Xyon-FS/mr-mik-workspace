import { createHash } from 'node:crypto';
import path from 'node:path';
import { realFile, within } from './util.mjs';
import { visualizeReference } from './chat-visualize.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const inlineVisualizeLimit = 1000000;
function recordedCode(source, text) {
  const original = source.replace(/\r\n/g, '\n'), rendered = text.replace(/\r\n/g, '\n');
  // Markdown removes quote/list prefixes from fenced code. Keep the rendered
  // indentation without requiring those surrounding Markdown prefixes.
  return original.includes(rendered) || rendered.split('\n').every(line => !line || original.includes(line));
}
export function previewViewState(input) {
  if (!input || typeof input !== 'object') return undefined;
  const state = {};
  if (input.zoom === 'fit' || Number.isFinite(input.zoom) && input.zoom >= .25 && input.zoom <= 4) state.zoom = input.zoom;
  for (const key of ['top', 'left']) if (Number.isFinite(input[key]) && input[key] >= 0 && input[key] < 1000000) state[key] = input[key];
  return state;
}
export async function chatBlockPreview(session, runtime, input, repo) {
  if (session.chatInterface !== 'chat' || !runtime || !['codex', 'claude'].includes(session.agent)) throw invalid('Open a graphical chat first.');
  if (input.runtimeId && input.runtimeId !== runtime.runtimeId) throw invalid('The conversation changed. Reopen the block.');
  if (typeof input.itemId !== 'string' || !['code', 'table', 'visualize'].includes(input.kind)) throw invalid('Choose a recorded output.');
  await runtime.ensureHistoryItem?.(input.itemId);
  const item = runtime.items.get(input.itemId) || runtime.historyItems.get(input.itemId);
  if (!item || typeof item.text !== 'string') throw invalid('This source message is no longer available.');
  if (input.kind === 'visualize') {
    if (input.bundle) throw invalid('Choose a self-contained HTML visualization.');
    const reference = item.type === 'agentMessage' && item.text.split(/\r?\n/).map(visualizeReference).find(entry => entry && entry.path === input.visualizePath);
    if (!repo || !reference) throw invalid('This visualization is not recorded in the source response.');
    const requested = path.resolve(session.cwd, reference.path);
    const root = [session.cwd, repo].find(folder => within(folder, requested));
    let disk;
    try {
      if (!root) throw new Error();
      const { file, info } = await realFile(root, path.relative(root, requested));
      // Check the resolved name too, including links to another file inside the project.
      if (!info.isFile() || !/\.html?$/i.test(file) || /(?:^|[\\/])(?:\.env|auth\.json|credentials|\.git)(?:[\\/.]|$)/i.test(file)) throw new Error();
      disk = { file, info };
    } catch {
      throw invalid('This HTML visualization is unavailable in the project or Hub.');
    }
    const { info } = disk;
    const identity = createHash('sha256').update(JSON.stringify([session.id, input.itemId, disk.file, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])).digest('hex');
    if (input.identity && input.identity !== identity) throw invalid('This visualization changed. Open it again from the chat.');
    if (input.inline === true && !input.identity && info.size > inlineVisualizeLimit) return { workspaceOnly: true };
    return { kind: 'rich', blockKind: 'code', name: reference.title || path.basename(requested), path: '', identity, size: info.size, language: 'html', disk, source: { sessionId: session.id, itemId: input.itemId, visualizePath: reference.path } };
  }
  let text = '', cells, language = '';
  if (input.kind === 'code') {
    if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 200000 || !recordedCode(item.text, input.text) || typeof input.language !== 'string' || !/^[\w+-]{0,40}$/.test(input.language)) throw invalid('Choose a code block from the current message under 200 KB.');
    text = input.text; language = input.language;
  } else {
    if (!Array.isArray(input.cells) || !input.cells.length || input.cells.length > 1000 || input.cells.some(row => !Array.isArray(row) || !row.length || row.length > 100 || row.some(value => typeof value !== 'string'))) throw invalid('Choose a table of up to 1000 rows and 100 columns.');
    if (Buffer.byteLength(JSON.stringify(input.cells)) > 200000) throw invalid('Choose a table under 200 KB.');
    cells = input.cells;
  }
  const identity = createHash('sha256').update(JSON.stringify([session.id, input.itemId, input.kind, language, text, cells])).digest('hex');
  return { kind: 'rich', blockKind: input.kind, name: input.kind === 'table' ? 'Table preview' : language === 'mermaid' ? 'Diagram preview' : `${language || 'Code'} preview`, path: '', identity, size: Buffer.byteLength(text || JSON.stringify(cells)), text, language, cells, source: { sessionId: session.id, itemId: input.itemId } };
}
