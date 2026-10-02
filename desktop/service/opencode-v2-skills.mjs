import path from 'node:path';
import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { within } from './util.mjs';

// Permission resources are IDs, not display labels or wildcard patterns.
export const configurableSkillId = id => typeof id === 'string' && id.length > 0 && id.length <= 160 && !/[\x00-\x1f\x7f/\\*?\[\]]/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const label = value => typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

export function v2SkillMetadata(directory, file, text) {
  let data = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match) {
    const decode = source => {
      const doc = parseDocument(source);
      if (doc.errors.length) throw new Error('Invalid skill frontmatter.');
      return doc.toJS({ maxAliasCount: 0 });
    };
    try { data = decode(match[1]); }
    catch {
      // Native retry for unquoted colons; YAML code/aliases are never evaluated.
      const sanitized = match[1].split(/\r?\n/).flatMap(line => {
        const entry = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line), value = entry?.[2].trim();
        return entry && value && !/^["'|>]/.test(value) && value.includes(':') ? [`${entry[1]}: |-`, `  ${value}`] : [line];
      }).join('\n');
      try { data = decode(sanitized); } catch { return null; }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.name !== undefined && typeof data.name !== 'string' || data.description !== undefined && typeof data.description !== 'string') return null;
  }
  const id = path.dirname(file) === directory && path.basename(file) !== 'SKILL.md' ? path.basename(file, '.md') : path.basename(path.dirname(file));
  const name = data.name ?? id;
  if (!configurableSkillId(id) || !label(name)) return null;
  return { id, name, ...(typeof data.description === 'string' ? { description: data.description.slice(0, 512) } : {}) };
}

export async function discoverV2Skills(folders) {
  const found = new Map();
  let visited = 0;
  for (const [directory, scope] of folders) {
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const root = await realpath(directory), files = [];
    const visit = async (folder, depth) => {
      if (depth > 16) throw new Error('Native skill discovery exceeds the supported directory depth.');
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (++visited > 8192) throw new Error('Native skill discovery exceeds the supported inventory size.');
        if (entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await visit(file, depth + 1);
        else if (entry.isFile() && (entry.name === 'SKILL.md' || depth === 0 && entry.name.endsWith('.md'))) files.push(file);
      }
    };
    await visit(directory, 0);
    for (const file of files.sort()) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || !within(root, await realpath(file))) continue;
      const metadata = v2SkillMetadata(directory, file, await readFile(file, 'utf8'));
      if (metadata) found.set(metadata.id, { kind: 'skill', ...metadata, source: file, originScope: scope, installed: true });
    }
  }
  return [...found.values()];
}

// Native catalog projection never contains skill bodies, auth or options.
export function publicV2Skills(rows) {
  if (!Array.isArray(rows) || rows.length > 2048) throw new Error('Native V2 skill inventory is not recognized.');
  return rows.filter(row => configurableSkillId(row?.id) && label(row.name) && typeof row.path === 'string' && path.isAbsolute(row.path) && row.path.length <= 2048 && !/[\x00-\x1f]/.test(row.path)).map(row => ({ id: row.id, name: row.name, path: row.path }));
}
