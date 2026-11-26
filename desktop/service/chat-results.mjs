import { createHash } from 'node:crypto';
import { standaloneHtml } from './chat-html-output.mjs';
export function messageResults(item) {
  if (['inProgress', 'running'].includes(item.status)) return [];
  const revision = createHash('sha256').update(JSON.stringify([item.text, item.path, item.resources])).digest('hex').slice(0, 16);
  if (item.type === 'imageGeneration' && item.path) return [{ itemId: item.id, revision, index: 0, type: 'asset', title: item.path.split(/[\\/]/).pop(), mediaKind: 'image' }];
  if (['mcpToolCall', 'dynamicToolCall', 'imageGeneration'].includes(item.type) && item.resources?.length) return item.resources.flatMap((resource, index) => resource.available && !['link','unsupported'].includes(resource.kind) ? [{ itemId: item.id, revision, index, resourceIndex: index, type: 'asset', title: resource.name, mediaKind: resource.kind }] : []);

  if (item.type !== 'agentMessage' || !item.text || ['inProgress', 'running'].includes(item.status)) return [];
  const results = [];
  const add = value => results.push({ itemId: item.id, revision, ...value });
  const html = standaloneHtml(item.text);
  if (html) { add({ index: 0, type: 'code', language: 'html', title: 'HTML document', text: html }); return results; }
  const fences = /^\s{0,3}(`{3,}|~{3,})([\w+-]*)[^\n]*\n([\s\S]*?)^\s{0,3}\1\s*$/gm;
  for (const match of item.text.matchAll(fences)) {
    if (results.length >= 100) break;
    add({ index: results.length, type: 'code', language: match[2] || 'text', title: `${match[2] || 'Code'} snippet`, text: match[3].replace(/\r?\n$/, '') });
  }
  const prose = item.text.replace(fences, '');
  // Ordinary citations/links are source references, not proof of a produced file.
  if (/^\s*\|.+\|\s*\n\s*\|?\s*:?-{3}/m.test(prose)) add({ index: results.length, type: 'message', title: 'Table response' });
  return results;
}
export async function conversationResults(runtime, input = {}) {
  const snapshot = runtime.snapshot();
  const page = input.beforeId ? await runtime.older({ beforeId: input.beforeId, cursor: input.cursor }) : snapshot;
  const items = page.items || [], results = items.flatMap(messageResults).slice(-200).map(({ text, ...value }) => { void text; return value; });
  return { runtimeId: runtime.runtimeId, results, beforeId: items[0]?.id || null, cursor: page.nextCursor || null, hasOlder: !!(page.hasOlder || page.truncated), projectId: runtime.session?.projectId || null };
}
