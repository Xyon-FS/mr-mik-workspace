import path from 'node:path';
import { within } from './util.mjs';
import { ClaudeSubagents } from './claude-subagents.mjs';
import { knownClaudePermissionModes } from './claude-chat-settings.mjs';
import { validateClaudeContext } from './claude-composer.mjs';

const types = new Set(['userMessage', 'agentMessage', 'reasoning', 'tool', 'contextCompaction']);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const string = (value, maximum) => typeof value === 'string' && value.length <= maximum;
export function portableClaudeState(value, session) {
  if (!value || value.version !== 1 || value.nativeId !== session.nativeId || !string(value.draft, 64000) || !Array.isArray(value.state?.items) || value.state.items.length > 2000 || !Array.isArray(value.state.turns) || value.state.turns.length > 2000 || !Array.isArray(value.attachments) || value.attachments.length > 20) throw new Error('Invalid portable Claude display state.');
  if (value.buildPermissionMode != null && (!knownClaudePermissionModes.includes(value.buildPermissionMode) || value.buildPermissionMode === 'plan')) throw new Error('Invalid saved Claude Build permissions.');
  const agents = new ClaudeSubagents({}); agents.restore(value.subagents);
  const attachment = item => {
    if (!item || !['file', 'folder', 'image'].includes(item.kind) || !string(item.name, 8192) || !string(item.path, 8192) || !path.isAbsolute(item.path) || !string(item.resolvedPath, 8192) || !path.isAbsolute(item.resolvedPath) || /[\x00-\x1f]/.test(item.path + item.resolvedPath) || item.sha256 != null && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) || item.size != null && (!Number.isSafeInteger(item.size) || item.size < 0) || item.mimeType != null && !string(item.mimeType, 100) || item.unavailable != null && typeof item.unavailable !== 'boolean') throw new Error('Invalid portable Claude attachment reference.');
    return pick(item, ['path', 'resolvedPath', 'name', 'kind', 'size', 'mimeType', 'sha256', 'unavailable']);
  };
  const projectItem = item => {
    if (!item || !types.has(item.type) || !string(item.id, 2000) || !string(item.text || '', 200000) || item.attachments && (!Array.isArray(item.attachments) || item.attachments.length > 20)) throw new Error('Invalid portable Claude message.');
    const result = pick(item, ['id', 'nativeUuid', 'turnId', 'type', 'text', 'status', 'tool', 'toolId', 'final', 'historical']);
    if (['nativeUuid', 'turnId', 'status', 'tool', 'toolId'].some(key => result[key] != null && !string(result[key], 2000)) || ['final', 'historical'].some(key => result[key] != null && typeof result[key] !== 'boolean')) throw new Error('Invalid portable Claude message metadata.');
    if (item.attachments) result.attachments = item.attachments.map(attachment);
    if (item.composerContext) result.composerContext = validateClaudeContext(item.composerContext);
    if (item.changes != null) {
      if (!Array.isArray(item.changes) || item.changes.length > 100 || item.changes.some(change => !string(change.path, 8192) || !path.isAbsolute(change.path) || !['add', 'update'].includes(change.kind) || !string(change.diff, 32000))) throw new Error('Invalid portable Claude recorded changes.');
      result.changes = item.changes.map(change => pick(change, ['path', 'kind', 'diff', 'diffTruncated']));
    }
    if (item.type === 'tool') result.input = { note: 'See native transcript for original tool input' };
    return result;
  };
  const items = value.state.items.map(projectItem);
  if (value.historyMetadata != null && (!Array.isArray(value.historyMetadata) || value.historyMetadata.length > 2000)) throw new Error('Invalid portable Claude attachment history.');
  const historyMetadata = (value.historyMetadata || []).map(projectItem);
  const turns = value.state.turns.map(turn => {
    if (!turn || !string(turn.id, 2000) || !['completed', 'failed', 'interrupted', 'uncertain', 'running'].includes(turn.status)) throw new Error('Invalid portable Claude turn.');
    if (['startedAt', 'completedAt'].some(key => turn[key] != null && (!Number.isFinite(turn[key]) || turn[key] < 0)) || turn.historical != null && typeof turn.historical !== 'boolean' || turn.timingSource != null && !string(turn.timingSource, 100)) throw new Error('Invalid portable Claude timing.');
    return pick(turn, ['id', 'status', 'startedAt', 'completedAt', 'historical', 'timingSource']);
  });
  return { version: 1, nativeId: session.nativeId, subagents: agents.save(), ...(value.buildPermissionMode ? { buildPermissionMode: value.buildPermissionMode } : {}), hasOlder: !!value.hasOlder, draft: value.draft, composerContext: validateClaudeContext(value.composerContext), attachments: value.attachments.map(attachment), historyMetadata, state: { sessionId: session.nativeId, status: 'closed', items, turns, requests: [], error: '', uncertain: !!value.state.uncertain || ['running', 'waiting', 'stopping'].includes(value.state.status) }, previewPaths: [] };
}
export function relocateClaudeState(value, session, { sourceHub, destinationHub, sourceCwd, destinationCwd, stateDir }) {
  const result = portableClaudeState(value, session);
  const relocate = file => {
    if (within(sourceCwd, file)) return path.resolve(destinationCwd, path.relative(sourceCwd, file));
    if (within(sourceHub, file)) return path.resolve(destinationHub, path.relative(sourceHub, file));
    return null;
  };
  const attachment = item => {
    const target = relocate(item.path), resolved = relocate(item.resolvedPath);
    return { ...item, ...(target && resolved ? { path: target, resolvedPath: resolved } : { unavailable: true }) };
  };
  for (const item of result.state.items) if (item.changes) for (const change of item.changes) { const target = relocate(change.path); if (target) change.path = target; }
  result.attachments = result.attachments.map(attachment);
  for (const item of [...result.state.items, ...result.historyMetadata]) if (item.attachments) item.attachments = item.attachments.map(attachment);
  result.repo = stateDir;
  return result;
}
