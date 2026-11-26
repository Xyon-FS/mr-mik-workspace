import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath, open } from 'node:fs/promises';
import { within } from './util.mjs';

const denied = /(?:^|[\\/])(?:\.env(?:\.|$)|auth\.json$|credentials(?:\.|[\\/]|$)|\.ssh(?:[\\/]|$)|\.aws(?:[\\/]|$)|\.codex(?:[\\/]|$))/i;
const lineNumber = value => Number.isSafeInteger(value) && value > 0 && value <= 10000000 ? value : null;

export function diffRows(diff) {
  let old = null, next = null, inHunk = false;
  return String(diff || '').split('\n').slice(0, 5000).map(raw => {
    const text = raw.replace(/\r$/, ''), hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; return { type: 'hunk', text, old: null, next: null }; }
    const type = inHunk ? text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : text.startsWith(' ') ? 'context' : 'meta' : 'meta';
    const row = { type, text, old: ['remove', 'context'].includes(type) ? old : null, next: ['add', 'context'].includes(type) ? next : null };
    if (row.old != null) old++; if (row.next != null) next++;
    return row;
  });
}

function reviewLocations(text) {
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*)\n```\s*$/, '$1')); } catch { /* Native review is text, not guaranteed JSON. */ }
  if (Array.isArray(parsed?.findings)) return parsed.findings.slice(0, 100).map((finding, index) => {
    const location = finding?.code_location, start = lineNumber(location?.line_range?.start), end = lineNumber(location?.line_range?.end);
    return { id: `finding-${index}`, title: String(finding?.title || 'Review finding').slice(0, 500), body: String(finding?.body || '').slice(0, 8000), priority: Number.isInteger(finding?.priority) && finding.priority >= 0 && finding.priority <= 3 ? finding.priority : null, path: typeof location?.absolute_file_path === 'string' ? location.absolute_file_path.slice(0, 4000) : '', line: start, end: start && end && end >= start ? Math.min(end, start + 200) : start, source: 'structured' };
  });
  // Only explicit Markdown file links with a line anchor are locations. Never
  // infer a finding or a line number from ordinary review prose.
  const links = [...text.matchAll(/\[([^\]\n]{1,500})\]\(([^)\n]{1,4000})\)/g)].slice(0, 100);
  return links.flatMap(([, title, href], index) => {
    const match = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)$/.exec(href);
    if (!match || /^(?:https?|javascript|data|file):/i.test(match[1])) return [];
    const start = lineNumber(Number(match[2] || match[4])), end = lineNumber(Number(match[3] || match[5]));
    return start ? [{ id: `link-${index}`, title, body: '', priority: null, path: match[1], line: start, end: end && end >= start ? Math.min(end, start + 200) : start, source: 'link' }] : [];
  });
}

function orderedTurnEdits(runtime, turnId) {
  const recorded = new Map([...(runtime?.historyItems || []), ...(runtime?.items || [])]);
  const matchesTurn = value => value.turnId === turnId && value.type === 'fileChange' && value.status === 'completed' && value.changes?.length;
  const edits = [...recorded.values()].filter(matchesTurn);
  const time = value => value.startedAt ?? value.completedAt;
  const sortByTime = values => values.every(value => Number.isFinite(time(value))) ? values.sort((first, second) => time(first) - time(second)) : values;

  // Older pages can enter the cache after newer ones. Their anchors still give
  // their relative position even when the provider supplies no item timestamps.
  const before = new Map(), older = new Set();
  for (const id of recorded.keys()) {
    const reference = runtime.historyReferences?.get(id);
    if (reference?.kind !== 'older' || !recorded.has(reference.beforeId)) continue;
    const page = before.get(reference.beforeId) || [];
    page.push(id);
    before.set(reference.beforeId, page);
    older.add(id);
  }
  if (!older.size) return sortByTime(edits);
  const ordered = [], visited = new Set();
  const append = id => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const child of before.get(id) || []) append(child);
    const value = recorded.get(id);
    if (matchesTurn(value)) ordered.push(value);
  };
  for (const id of recorded.keys()) if (!older.has(id)) append(id);
  for (const id of recorded.keys()) append(id);
  return sortByTime(ordered);
}

export function inspectItem(runtime, itemId) {
  let item = runtime?.items.get(itemId) || runtime?.historyItems.get(itemId);
  if (!item && typeof itemId === 'string' && itemId.startsWith('turn-changes:')) {
    const turnId = itemId.slice('turn-changes:'.length);
    const edits = orderedTurnEdits(runtime, turnId);
    if (edits.length) item = { id: itemId, type: 'fileChange', status: 'completed', text: '', changes: edits.flatMap(value => value.changes.map((change, index) => ({ ...change, source: [value.id, index] }))), changesTruncated: edits.some(value => value.changesTruncated) };
  }
  if (!item || !['fileChange', 'exitedReviewMode'].includes(item.type)) throw new Error('This recorded change or review is no longer loaded. Reopen it from the conversation.');
  const version = createHash('sha256').update(JSON.stringify([runtime.runtimeId, runtime.session.cwd, item.id, item.status, item.text, item.changes, item.changesTruncated])).digest('hex');
  const review = item.type === 'exitedReviewMode' ? String(item.text || '').slice(0, 256000) : '';
  const findings = reviewLocations(review), files = [], byPath = new Map();
  const pathKey = file => {
    const resolved = path.resolve(runtime.session.cwd, file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  for (const [index, change] of (item.changes || []).entries()) {
    const key = pathKey(change.path);
    let file = byPath.get(key);
    if (!file) {
      file = { id: `change-${files.length}`, key, path: change.path, patches: [], added: 0, removed: 0 };
      byPath.set(key, file);
      files.push(file);
    }
    const original = String(change.diff || ''), diff = original.slice(0, 32000);
    const rows = diff ? diffRows(diff) : [];
    file.patches.push({
      id: createHash('sha256').update(JSON.stringify(change.source ?? [item.id, index])).digest('hex'),
      previousPath: change.previousPath || null, kind: change.kind, rows,
      truncated: change.diffTruncated === true || original.length > diff.length || diff.split('\n').length > 5000,
      binary: /(?:^|\n)(?:Binary files |GIT binary patch)/.test(diff),
    });
    file.added += rows.filter(row => row.type === 'add').length;
    file.removed += rows.filter(row => row.type === 'remove').length;
  }

  for (const finding of findings) {
    const key = finding.path && pathKey(finding.path);
    let file = key && byPath.get(key);
    if (!file && key) {
      file = { id: `location-${files.length}`, key, path: finding.path, patches: [], added: 0, removed: 0 };
      byPath.set(key, file);
      files.push(file);
    }
    finding.fileId = file?.id || null;
  }

  for (const file of files) {
    const resolved = path.resolve(runtime.session.cwd, file.path);
    file.displayPath = within(runtime.session.cwd, resolved) ? path.relative(runtime.session.cwd, resolved) || path.basename(resolved) : file.path;
  }
  let reviewSummary = '', structuredReview = false;
  try { const parsed = JSON.parse(review.replace(/^```(?:json)?\s*\n([\s\S]*)\n```\s*$/, '$1')); if (Array.isArray(parsed?.findings)) { structuredReview = true; reviewSummary = typeof parsed.overall_explanation === 'string' ? parsed.overall_explanation.slice(0, 16000) : parsed.findings.length ? '' : 'No findings were reported in this recorded review.'; } } catch { /* Preserve the original text below. */ }
  return { sessionId: runtime.session.id, itemId: item.id, runtimeId: runtime.runtimeId, version, type: item.type, status: item.status, files, findings, review, reviewSummary, structuredReview, filesTruncated: item.changesTruncated === true, reviewTruncated: String(item.text || '').length > review.length && item.type === 'exitedReviewMode' };
}

export async function inspectFile(runtime, request) {
  const snapshot = inspectItem(runtime, request.itemId);
  if (snapshot.version !== request.version) throw new Error('The recorded result changed. Refresh the inspector before opening its file.');
  const entry = snapshot.files.find(file => file.id === request.fileId);
  if (!entry || !entry.path || entry.path.length > 4000 || /[\x00-\x1f]/.test(entry.path)) throw new Error('Choose a file from this recorded result.');
  const resolved = path.resolve(runtime.session.cwd, entry.path);
  if (denied.test(resolved)) throw new Error('Sensitive configuration files cannot be opened in this inspector.');
  const root = await realpath(runtime.session.cwd);
  if (!within(runtime.session.cwd, resolved) && !within(root, resolved) && !runtime.previewPaths.has(resolved)) throw new Error('This file is outside the chat project. Attach it explicitly before inspecting it.');
  let actual;
  try { actual = await realpath(resolved); } catch (error) { if (error.code === 'ENOENT') return { status: 'missing', message: 'This file is missing or was deleted. Its recorded diff remains available.' }; throw error; }
  if (denied.test(actual) || !within(root, actual) && !runtime.previewPaths.has(actual)) throw new Error('This link leaves the chat project. Attach its destination explicitly before inspecting it.');
  let handle;
  try {
    handle = await open(actual, 'r'); const info = await handle.stat();
    if (await realpath(actual) !== actual || !info.isFile()) throw new Error('This file location changed. Refresh the inspector.');
    if (info.size > 1024 * 1024) return { status: 'large', message: 'Current-file preview supports files up to 1 MB. The recorded diff remains available.' };
    const bytes = Buffer.alloc(Math.min(info.size + 1, 1024 * 1024 + 1)); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const content = bytes.subarray(0, bytesRead);
    if (bytesRead > 1024 * 1024) return { status: 'large', message: 'This file grew beyond the preview limit. Refresh to inspect it.' };
    let text;
    try { if (content.includes(0)) throw new Error(); text = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { return { status: 'binary', message: 'Binary or non-UTF-8 file. A text preview is unavailable.' }; }
    const all = text.split(/\r?\n/), selected = request.line == null ? 1 : lineNumber(request.line);
    if (!selected || selected > all.length) return { status: 'line-missing', message: 'This recorded line is not present in the current file. The file may have changed since the result was recorded.' };
    const start = Math.max(1, selected - 60), end = Math.min(all.length, selected + 140);
    return { status: 'ready', path: entry.path, line: selected, start, totalLines: all.length, partial: start > 1 || end < all.length, modifiedAt: info.mtime.toISOString(), lines: all.slice(start - 1, end).map((text, index) => ({ number: start + index, text: text.slice(0, 16000), truncated: text.length > 16000 })) };
  } finally { await handle?.close(); }
}

// Accept row identities, never arbitrary client quote text or current file bytes.
export function quoteRecordedDiff(runtime, request) {
  const snapshot = inspectItem(runtime, request.itemId);
  if (request.runtimeId !== runtime.runtimeId || snapshot.version !== request.version) throw new Error('The recorded result changed. Refresh the inspector before selecting context.');
  const file = snapshot.files.find(value => value.id === request.fileId), start = request.start, end = request.end;
  const patch = request.patchId == null && file?.patches.length === 1 ? file.patches[0] : file?.patches.find(value => value.id === request.patchId);
  if (!patch || patch.binary || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= patch.rows.length || end - start > 200) throw new Error('Select up to 201 recorded diff rows from one patch.');

  const patchLabel = file.patches.length > 1 ? `patch ${file.patches.indexOf(patch) + 1}, ` : '';
  const text = `Recorded diff: ${file.displayPath} (${patchLabel}rows ${start + 1}–${end + 1})\n` + patch.rows.slice(start, end + 1).map(row => row.text).join('\n');

  const composer = runtime.composer;
  composer.assertEditable?.();
  if (composer.items.length >= 20 || text.length > 8000 || composer.items.filter(value=>value.type==='quote').reduce((size,value)=>size+value.text.length,text.length)>16000) throw new Error('Select a shorter diff or remove some prompt context.');
  if (!composer.items.some(value=>value.type==='quote' && value.itemId===snapshot.itemId && value.text===text)) composer.items.push({ id: randomUUID(), type:'quote', role:'assistant', itemId:snapshot.itemId, inspection:true, text });
  composer.changed(); return { added:true, submitted:false };
}
