import { skillMentions } from './skill-mentions.mjs';

// Editing-time projection only. Native invocation remains catalog-validated.
export function skillCompletion(text, cursor, end = cursor) {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length || end !== cursor) return null;
  const match = /(?:^|[^\w$\\/])(\$[A-Za-z0-9._:-]*)$/.exec(text.slice(0, cursor));
  if (!match || match[1].length > 161) return null;
  const start = cursor - match[1].length, suffix = /^[A-Za-z0-9._:-]*/.exec(text.slice(cursor))[0];
  const finish = cursor + suffix.length;
  if (text[finish] === '$' || text[start - 1] === '$') return null;
  const probe = text.slice(0, start) + '$completion-probe' + text.slice(finish);
  if (!skillMentions(probe).some(item => item.start === start && item.name === 'completion-probe')) return null;
  return { start, end: finish, query: match[1].slice(1) };
}

export function completeSkill(text, token, name, limit = 64000) {
  const after = text.slice(token.end), insert = `$${name}${/^\s/.test(after) ? '' : ' '}`;
  const value = text.slice(0, token.start) + insert + after;
  if (value.length > limit) throw new Error('Shorten the message before inserting a skill.');
  return { text: value, cursor: token.start + insert.length };
}
