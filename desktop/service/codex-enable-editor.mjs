import { parse as parseToml } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';

// Change only the enablement key of an existing Codex table. In particular,
// never serialize the whole config: it may contain comments and secret values.
export function setTableEnabled(text, group, id, enabled) {
  const headers = [...text.matchAll(/^[ \t]*\[{1,2}[^\r\n]+\]{1,2}[^\r\n]*$/gm)];
  const table = headers.find(match => {
    if (!/^\s*\[[^\[\]]+\]\s*(?:#.*)?$/.test(match[0])) return false;
    try {
      const probe = parseToml(`${match[0]}\n__mrmak_probe = true\n`);
      return probe[group]?.[id]?.__mrmak_probe === true;
    } catch { return false; }
  });
  if (!table) throw new Error('This Codex entry does not use an editable TOML table. Its configuration was not changed.');
  const start = table.index + table[0].length;
  const nextHeader = headers.find(match => match.index > table.index);
  const end = nextHeader?.index ?? text.length;
  const body = text.slice(start, end);
  const key = /^[ \t]*enabled[ \t]*=[^\r\n]*(?:\r?\n|$)/m;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const updated = key.test(body)
    ? body.replace(key, line => {
        const match = /^(\s*enabled\s*=\s*)(true|false)(.*?)(\r?\n|$)/.exec(line);
        if (!match) throw new Error('The enabled value is not a simple boolean; no changes were made.');
        return `${match[1]}${enabled}${match[3]}${match[4]}`;
      })
    : `${newline}enabled = ${enabled}${body}`;
  const result = text.slice(0, start) + updated + text.slice(end);
  const before = parseToml(text.replace(/^\uFEFF/, ''));
  const after = parseToml(result.replace(/^\uFEFF/, ''));
  const expected = structuredClone(before);
  expected[group][id].enabled = enabled;
  if (!isDeepStrictEqual(after, expected)) throw new Error('The Codex table could not be updated without changing other settings. No changes were made.');
  return result;
}
