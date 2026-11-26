import path from 'node:path';
import { projectResultContent } from './chat-result-content.mjs';
import { displayStructure, stepPresentation } from './chat-step-presentation.mjs';
import { recordedQuotes } from './chat-input-presentation.mjs';

const text = value => String(value ?? '');
export function projectChatItem(item, previous = {}, metadata = {}) {
  const summaryParts = item.type === 'reasoning' ? Array.isArray(item.summary) ? item.summary.map(part => text(typeof part === 'string' ? part : part.text)) : previous.summaryParts || [] : undefined;
  const content = item.type === 'reasoning' ? summaryParts.join('\n\n') : Array.isArray(item.content) ? item.content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : undefined;
  const message = text(item.text ?? content ?? item.command ?? item.prompt ?? item.review ?? (item.type === 'imageGeneration' ? item.revisedPrompt : undefined) ?? (item.type === 'hookPrompt' && Array.isArray(item.fragments) ? item.fragments.map(part => text(part.text)).join('\n\n') : undefined) ?? previous.text);
  const replacesResult = ['mcpToolCall', 'dynamicToolCall'].includes(item.type) && (item.result !== undefined || item.contentItems !== undefined) || item.type === 'functionCallOutput' && item.output !== undefined;
  const results = projectResultContent(item.type === 'functionCallOutput' && item.output !== undefined ? { ...item, contentItems: Array.isArray(item.output) ? item.output.map(part => part?.type === 'input_text' ? { type: 'text', text: part.text } : { type: 'unsupported' }) : [{ type: 'text', text: typeof item.output === 'string' ? item.output : '' }] } : item);
  const output = text(item.aggregatedOutput ?? (item.error ? JSON.stringify(item.error) : results ? results.summary + (item.result?.structuredContent ? '\n' + JSON.stringify(item.result.structuredContent, null, 2) : '') : item.result ? ['mcpToolCall', 'dynamicToolCall', 'imageGeneration'].includes(item.type) ? JSON.stringify(item.result, null, 2) : displayStructure(item.result) : Array.isArray(item.changes) ? item.changes.map(change => change.diff || '').join('\n') : replacesResult ? '' : previous.details ?? ''));
  const attachments = (Array.isArray(item.content) ? item.content : []).filter(part => part?.type === 'localImage' && typeof part.path === 'string').map(part => ({ path: part.path, name: path.basename(part.path), kind: 'image' }));
  const skills = item.type === 'userMessage' && Array.isArray(item.content) ? item.content.filter(part => part?.type === 'skill' && typeof part.name === 'string' && typeof part.path === 'string').map((part, index) => ({ id: `native-skill:${index}`, type: 'skill', name: part.name, path: part.path })) : [];
  // Decode only the application's explicit attachment suffix, not arbitrary prose.
  if (item.type === 'userMessage' && message.includes('\n\nAttached paths:\n')) {
    for (const line of message.split('\n\nAttached paths:\n').at(-1).split('\n').slice(0, 100)) {
      try { const file = JSON.parse(line); if (typeof file === 'string' && path.isAbsolute(file) && !attachments.some(part => part.path === file)) attachments.push({ path: file, name: path.basename(file), kind: /\.(png|jpe?g|webp|gif|bmp)$/i.test(file) ? 'image' : 'file' }); } catch { /* Not an attachment reference. */ }
    }
  }
  const quotes = item.type === 'userMessage' ? recordedQuotes({ text: message, attachments }) : [];
  const composerContext = skills.length || quotes.length ? [
    ...(skills.length ? skills : (previous.composerContext?.filter(value => value.type === 'skill') || [])),
    ...(quotes.length ? quotes : (previous.composerContext?.filter(value => value.type === 'quote') || [])),
  ] : previous.composerContext;
  const changes = Array.isArray(item.changes) ? item.changes.slice(0, 100).map(change => ({ path: text(change.path), kind: text(change.kind?.type || change.kind), previousPath: change.kind?.move_path ? text(change.path) : null, ...(change.kind?.move_path ? { path: text(change.kind.move_path) } : {}), diff: text(change.diff).slice(0, 32000), diffTruncated: text(change.diff).length > 32000 })) : previous.changes;
  const agents = item.type === 'collabAgentToolCall' && (item.receiverThreadIds !== undefined || item.agentsStates !== undefined) ? [...new Set([...(item.receiverThreadIds || []), ...Object.keys(item.agentsStates || {})])].filter(id => typeof id === 'string' && id.length <= 200).slice(0, 40).map(id => ({ id, status: text(item.agentsStates?.[id]?.status || 'unknown'), message: text(item.agentsStates?.[id]?.message).slice(0, 8000) })) : previous.agents;
  const presentation = stepPresentation(item, previous.presentation) || (results?.assets.length ? {} : undefined);
  if (presentation?.structured && results) {
    presentation.resultText = results.summary.slice(0, 32000);
    presentation.resultTextLength = results.summary.length;
    presentation.resultTextTruncated = results.summary.length > 32000;
  }
  // Resource cards already carry these names/kinds; don't repeat their generated
  // summary as a second textual output when the tool supplied no text of its own.
  if (presentation && results?.assets.length && !results.hasText) presentation.resultText = '';
  return { id: item.id, type: item.type, text: message, details: output.slice(0, 32000), detailsTruncated: output.length > 32000, ...(composerContext ? { composerContext } : {}),
    status: item.success === false ? 'failed' : item.status || previous.status || '', phase: item.phase !== undefined ? item.phase : previous.phase ?? null,
    turnId: metadata.turnId || previous.turnId || null, startedAt: metadata.startedAtMs ?? previous.startedAt ?? null, completedAt: metadata.completedAtMs ?? previous.completedAt ?? null,
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : previous.durationMs ?? null, exitCode: Number.isInteger(item.exitCode) ? item.exitCode : previous.exitCode ?? null,
    tool: text(item.tool || previous.tool), server: text(item.server || previous.server), ...(presentation ? { presentation } : {}), ...(agents ? { agents } : {}),
    ...(summaryParts ? { summaryParts } : {}), ...(changes ? { changes, changesTruncated: Array.isArray(item.changes) ? item.changes.length > 100 : previous.changesTruncated === true } : {}), attachments: attachments.length ? attachments : previous.attachments || [],
    ...(Array.isArray(item.plan) ? { plan: item.plan.slice(0, 100).map(step => ({ step: text(step.step), status: ['pending', 'inProgress', 'completed'].includes(step.status) ? step.status : 'pending' })) } : previous.plan ? { plan: previous.plan } : {}),
    resources: results ? results.assets.map(({ data, text, path: file, ...resource }) => ({ ...resource, ...(text != null ? { text: text.slice(0, 32000) } : {}), available: data != null || text != null || !!file })) : replacesResult ? [] : previous.resources || [],
    fullResources: results?.assets ?? (replacesResult ? [] : undefined),
    path: ['imageGeneration', 'imageView'].includes(item.type) ? item.savedPath || item.path || previous.path || null : null, fullDetails: output };
}
