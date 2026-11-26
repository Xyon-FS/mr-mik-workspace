// Only prose mentions are commands. Code examples, escaped dollars, variables
// embedded in identifiers and paths must remain literal text.
export function skillMentions(text) {
  const source = String(text || '');
  let fence = null;
  const masked = source.split(/(?<=\n)/).map(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r?\n$/, ''));
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      return line.replace(/[^\n]/g, ' ');
    }
    if (delimiter) { fence = delimiter[1]; return line.replace(/[^\n]/g, ' '); }
    return line;
  }).join('').replace(/(`+)[\s\S]*?\1/g, value => ' '.repeat(value.length))
    .replace(/\$\$[\s\S]*?\$\$/g, value => ' '.repeat(value.length))
    .replace(/(?<!\\)\$[^$\n]+?\$(?![A-Za-z0-9_])/g, value => ' '.repeat(value.length));
  const result = [];
  for (const match of masked.matchAll(/\$([A-Za-z0-9](?:[A-Za-z0-9._:-]{0,158}[A-Za-z0-9_-])?)/g)) {
    const start = match.index;
    if (start && /[\w$\\/]/.test(masked[start - 1])) continue;
    result.push({ name: match[1], start, end: start + match[0].length });
  }
  return result;
}

export function mentionedSkills(text, available) {
  const result = [];
  for (const { name } of skillMentions(text)) {
    const matches = available.filter(skill => skill.name === name);
    if (matches.length > 1) throw new Error(`Skill $${name} is ambiguous in this chat. Choose a uniquely named skill. Nothing was sent.`);
    if (matches.length === 1 && !result.some(skill => skill.path === matches[0].path)) result.push(matches[0]);
  }
  return result;
}

export function withoutLeadingSkillMention(text, names) {
  const first = skillMentions(text)[0];
  // Native Claude requires the command at the start. Consume only that leading
  // alias; mentions within the user's instructions must remain unchanged.
  if (!first || !names.includes(first.name) || text.slice(0, first.start).trim()) return text;
  return text.slice(first.end).trimStart();
}
