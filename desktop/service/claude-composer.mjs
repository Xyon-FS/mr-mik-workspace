import { randomUUID } from 'node:crypto';
import { claudeAttachmentInput } from './claude-chat-attachments.mjs';
import { skillMentions, mentionedSkills, withoutLeadingSkillMention } from './skill-mentions.mjs';

const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !/[\x00-\x1f]/.test(value);
const reserved = new Set(['compact', 'clear', 'config', 'settings', 'model', 'permissions', 'mcp', 'login', 'logout', 'exit', 'quit', 'init', 'reload-skills', 'reload-plugins', 'heapdump', 'resume', 'fork', 'effort', 'fast', 'goal', 'usage', 'cost', 'context']);

function containsQuote(message, text) {
  if (message.includes(text)) return true;
  // A DOM selection omits Markdown delimiters and link destinations.
  const markdownText = message
    .replace(/\[([^[\]\n]+)\]\([^()\n]*\)/g, '$1')
    .replace(/^(?:[ \t]{0,3}#{1,6} +|[ \t]*>[ \t]?|[ \t]*(?:[-+*]|\d+[.)]) +)/gm, '')
    .replace(/(\*\*|__|~~|\*|_|`)([^\n]+?)\1/g, '$2');
  return markdownText.replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' '));
}

export function validateClaudeContext(items = []) {
  if (!Array.isArray(items) || items.length > 20) throw new Error('Claude prompt context exceeds its 20 item limit.');
  const seen = new Set(); let quotes = 0, skills = 0;
  return items.map(item => {
    if (!item || !id(item.id) || seen.has(item.id)) throw new Error('Invalid Claude prompt context identity.');
    seen.add(item.id);
    if (item.type === 'skill' && item.invocation === 'native' && name(item.name) && !reserved.has(item.name) && item.path === `native:${item.name}` && ++skills <= 1) return { id: item.id, type: 'skill', invocation: 'native', name: item.name, path: item.path };
    if (item.type === 'quote' && id(item.itemId) && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string' && item.text.trim() && item.text.length <= 8000 && (quotes += item.text.length) <= 16000) return { id: item.id, type: 'quote', itemId: item.itemId, role: item.role, text: item.text, ...(item.inspection === true ? {inspection:true} : {}), ...(typeof item.sourceUrl === 'string' && /^https?:\/\//i.test(item.sourceUrl) ? { sourceUrl: item.sourceUrl } : {}) };
    throw new Error('Invalid Claude skill or quoted context.');
  });
}

export class ClaudeComposer {
  constructor(runtime) { this.runtime = runtime; this.items = []; }
  editBrowser(id, text) {
    this.assertEditable?.(); const item = this.items.find(item => item.id === id && item.type === 'quote' && item.sourceUrl);
    if (!item || typeof text !== 'string' || !text.trim() || text.length > 8000 || this.items.filter(value => value.id !== id && value.type === 'quote').reduce((size, value) => size + value.text.length, text.length) > 16000) throw new Error('Choose a shorter browser note.');
    item.id = randomUUID(); item.text = text; this.changed(); return { edited: true };
  }
  addBrowser(value) {
    this.assertEditable?.();
    const url = new URL(value.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid browser source.');
    const text = `Browser selection: ${value.title || 'Page'}\n${url.href}\n${value.text}`;
    if (text.length > 8000 || this.items.length >= 20 || this.items.filter(item => item.type === 'quote').reduce((size, item) => size + item.text.length, text.length) > 16000) throw new Error('Remove some selected context before adding this browser selection.');
    this.items.push({ id: randomUUID(), type: 'quote', itemId: `browser:${randomUUID()}`, role: 'user', text, sourceUrl: url.href }); this.changed(); return { added: true };
  }
  restore(items) { this.items = validateClaudeContext(items); }
  changed() { this.runtime.draftRevision++; this.runtime.changed(); }
  assertEditable() { this.runtime.assertAttachmentReady(); }
  async skills() {
    const r = this.runtime;
    if (!r.initialized || r.closed) throw new Error('Reconnect Claude to inspect its native skill catalog.');
    if (r.session.toolRefresh && ['pending', 'applying', 'failed'].includes(r.session.toolRefresh.status)) throw new Error('Apply pending native tool/skill changes before selecting a skill.');
    const rows = r.protocol.initialization?.commands;
    if (!Array.isArray(rows) || rows.length > 2000) throw new Error('This Claude runtime does not expose a native skill catalog.');
    if (rows.length && !rows.some(row => row?.builtin === true)) throw new Error('This Claude runtime does not distinguish skills from system commands. Use CLI or update the native runtime.');
    // Hub skills are deliberately routed through the scoped Workspace Bridge,
    // not through same-named local slash commands that could bypass Hub scope.
    const bridgeOnly = new Set([...(r.bridge?.hubSkillNames || []), ...(r.bridge?.hubSkillIds || [])]);
    const counts = new Map();
    for (const row of rows) if (name(row?.name)) counts.set(row.name, (counts.get(row.name) || 0) + 1);
    return { skills: rows.filter(row => name(row?.name) && row.builtin !== true && row.enabled !== false && !bridgeOnly.has(row.name) && !reserved.has(row.name) && counts.get(row.name) === 1).slice(0, 200).map(row => ({ name: row.name, path: `native:${row.name}`, invocation: 'native', description: String(row.description || '').slice(0, 500) })), warnings: 'Native-invocable skills reported by this Claude connection. One skill per message; choosing it does not load instructions or send a prompt. Hub skills remain scoped through the Workspace Bridge.' };
  }
  async add(value) {
    this.assertEditable();
    const r = this.runtime; let item;
    if (value?.type === 'skill') {
      const skill = (await this.skills()).skills.find(skill => skill.name === value.name && skill.path === value.path);
      this.assertEditable();
      if (!skill) throw new Error('This native skill is unavailable. Refresh the catalog or reconnect.');
      if (this.items.some(item => item.type === 'skill' && item.name === skill.name)) return { added: true };
      if (this.items.some(item => item.type === 'skill')) throw new Error('Remove the selected native skill before choosing another (one per message).');
      item = { id: randomUUID(), type: 'skill', invocation: 'native', name: skill.name, path: skill.path };
    } else if (value?.type === 'quote') {
      const source = r.items.get(value.itemId) || r.historyItems.get(value.itemId), text = value.text ?? source?.text;
      if (!source || !['userMessage', 'agentMessage'].includes(source.type) || typeof text !== 'string' || text.length > 8000 || !containsQuote(source.text, text)) throw new Error('Load and select text from a message in this conversation before quoting it.');
      item = { id: randomUUID(), type: 'quote', itemId: source.id, role: source.type === 'userMessage' ? 'user' : 'assistant', text };
      if (this.items.some(previous => previous.type === 'quote' && previous.itemId === item.itemId && previous.text === item.text)) return { added: true };
    } else if (value?.type === 'working-project') return r.attach([r.session.cwd]);
    else throw new Error('Choose an available native skill, a message quote or the working-project reference.');
    this.items = validateClaudeContext([...this.items, item]); this.changed(); return { added: true, submitted: false };
  }
  remove(itemId) { this.assertEditable(); this.items = this.items.filter(item => item.id !== itemId); this.changed(); return { removed: true }; }
  async source(itemId) {
    const item = this.items.find(item => item.type === 'quote' && (item.id === itemId || item.itemId === itemId));
    if (!item) throw new Error('This quote is no longer selected.');
    const state = this.runtime.snapshot();
    if (state.items.some(value => value.id === item.itemId)) return { runtimeId: state.runtimeId, items: state.items, turns: state.turns, anchorId: item.itemId, hasOlder: state.hasOlder, nextCursor: null };
    return this.runtime.historyPage(await this.runtime.history.page({ aroundId: item.itemId }), item.itemId);
  }
  async input(text, attachments, selected = this.items) {
    const mentions = skillMentions(text);
    let items = validateClaudeContext(selected.filter(item => item.type !== 'skill' || !item.id.startsWith('inline-skill:') || mentions.some(mention => mention.name === item.name)));
    if (items.some(item => item.type === 'skill') || mentions.length) {
      const available = (await this.skills()).skills;
      if (items.some(item => item.type === 'skill' && !available.some(skill => item.name === skill.name && item.path === skill.path))) throw new Error('The selected native skill is no longer available. Nothing was sent; remove it or reconnect.');
      for (const skill of mentionedSkills(text, available)) if (!items.some(item => item.type === 'skill' && item.path === skill.path)) items.push({ id: `inline-skill:${skill.name}`, type: 'skill', invocation: 'native', name: skill.name, path: skill.path });
      if (items.filter(item => item.type === 'skill').length > 1) throw new Error('Claude supports one native skill per message. Keep one $skill command. Nothing was sent.');
      items = validateClaudeContext(items);
    }
    const skill = items.find(item => item.type === 'skill');
    if (skill && attachments.some(item => item.kind === 'image')) throw new Error('This Claude runtime does not expand native skill commands combined with images. Remove the skill or image, or continue in CLI. Nothing was sent.');
    const quotes = items.filter(item => item.type === 'quote');
    const prompt = (skill ? withoutLeadingSkillMention(text, [skill.name]) : text) + (quotes.length ? '\n\nQuoted context (user-selected chat excerpts or browser selections):\n' + quotes.map(item => `[${item.role} message ${item.itemId}]\n${item.text.split('\n').map(line => '> ' + line).join('\n')}`).join('\n\n') : '');
    if (prompt.length > 80000) throw new Error('Prompt and quoted context exceed 80,000 characters.');
    const prepared = await claudeAttachmentInput(skill ? `/${skill.name} ${prompt}` : prompt, attachments);
    return { ...prepared, context: items };
  }
  consumed(items) { const ids = new Set(items.map(item => item.id)); this.items = this.items.filter(item => !ids.has(item.id)); }
}
