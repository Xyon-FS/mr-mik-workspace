export function insertSkillAtCursor(text: string, name: string, input: HTMLTextAreaElement | null, change: (value: string) => void) {
  const start = input?.selectionStart ?? text.length, end = input?.selectionEnd ?? start
  const token = (start && !/\s/.test(text[start - 1]) ? ' ' : '') + `$${name} `
  const next = text.slice(0, start) + token + text.slice(end)
  if (next.length > 64000) throw new Error('Shorten the message before inserting a skill.')
  change(next)
  requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + token.length, start + token.length) })
}
