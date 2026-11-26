import path from 'node:path';

export function claudeChanges(item, block, metadata, cwd) {
  if (block.is_error || !['Edit', 'Write'].includes(item.tool) || typeof item.input?.file_path !== 'string') return;
  const file = path.resolve(cwd, item.input.file_path), result = metadata?.tool_use_result;
  if (result?.filePath && path.resolve(cwd, result.filePath) !== file) return;
  let diff = '', truncated = false;
  if (Array.isArray(result?.structuredPatch)) {
    const hunks = result.structuredPatch.slice(0, 100).filter(hunk => hunk && ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isInteger(hunk[key]) && hunk[key] >= 0) && Array.isArray(hunk.lines) && hunk.lines.every(line => typeof line === 'string' && /^[ +\-\\]/.test(line)));
    truncated = result.structuredPatch.length !== hunks.length || hunks.some(hunk => hunk.lines.length > 2000);
    diff = hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.slice(0, 2000).join('\n')}`).join('\n');
  }
  const created = item.tool === 'Write' && result?.type === 'create';
  if (created && !diff && typeof item.input.content === 'string') {
    const content = item.input.content, lines = content ? content.split('\n') : [];
    if (content.endsWith('\n')) lines.pop();
    truncated ||= lines.length > 2000;
    diff = `@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@\n${lines.slice(0, 2000).map(line => '+' + line).join('\n')}`;
    if (content && !content.endsWith('\n') && !truncated) diff += '\n\\ No newline at end of file';
  }
  return [{ path: file, kind: created ? 'add' : 'update', diff: diff.slice(0, 32000), diffTruncated: truncated || diff.length > 32000 }];
}

export function reviewDraft(target) {
  if (!target || !['uncommittedChanges', 'baseBranch', 'commit'].includes(target.type)) throw new Error('Choose a review scope.');
  const reference = target.type === 'baseBranch' ? target.branch : target.sha;
  if (target.type !== 'uncommittedChanges' && (typeof reference !== 'string' || !/^[\w./-]{1,200}$/.test(reference) || reference.startsWith('-'))) throw new Error('Use a valid branch or commit reference.');
  const scope = target.type === 'uncommittedChanges' ? 'the current working-tree changes (including staged and unstaged changes)' : target.type === 'baseBranch' ? `the changes against branch ${JSON.stringify(reference)}` : `commit ${JSON.stringify(reference)}`;
  return `Review ${scope} in this chat's working project. This is a review task, not a request to implement fixes. Do not modify files. Inspect the available diff and relevant context, identify concrete bugs or regressions, and report each finding with its file and line when available. If no actionable findings are found, say so. If the requested Git scope is unavailable, explain that rather than inventing a diff.`;
}
