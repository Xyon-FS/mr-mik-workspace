import test from 'node:test';
import assert from 'node:assert/strict';
import { skillMentions, mentionedSkills, withoutLeadingSkillMention } from '../skill-mentions.mjs';
import { GraphicalComposer } from '../graphical-composer.mjs';
import { ClaudeComposer } from '../claude-composer.mjs';
import { projectChatItem } from '../codex-chat-items.mjs';

const available = [{ name: 'review', path: '/skills/review/SKILL.md' }, { name: 'plugin:inspect', path: '/skills/inspect/SKILL.md' }];
test('inline skill syntax preserves prose locations and excludes literals/code/paths', () => {
  const source = 'Use $review, then $plugin:inspect. `echo $review` \\$review C:/$review x$review\n```sh\n$review\n```\n~~~text\n$review\n~~~~\n$review\n```\n$review';
  assert.deepEqual(skillMentions(source).map(token => token.name), ['review', 'plugin:inspect', 'review']);
  for (const token of skillMentions(source)) assert.equal(source.slice(token.start, token.end), '$' + token.name);
  assert.deepEqual(mentionedSkills('Use $review $review and $HOME', available), [available[0]]);
  assert.deepEqual(skillMentions('Math $review$ and $$review + $review$$; invoke $review now').map(token => token.name), ['review']);
  assert.throws(() => mentionedSkills('$review', [...available, { name: 'review', path: '/another/skill' }]), /ambiguous/);
  assert.equal(withoutLeadingSkillMention('Please $review this `literal $review`.', ['review']), 'Please $review this `literal $review`.');
  assert.equal(withoutLeadingSkillMention('$review describe $review', ['review']), 'describe $review');
});

test('Codex sends typed skill invocations as native inputs and preserves quotes', async () => {
  const composer = new GraphicalComposer({}); composer.skills = async () => ({ skills: available });
  const input = await composer.input('$review inspect $plugin:inspect', [], [{ type: 'quote', role: 'user', itemId: 'q', text: 'Retained quote' }]);
  assert.deepEqual(input.filter(part => part.type === 'skill').map(part => part.name), ['review', 'plugin:inspect']);
  assert.match(input[0].text, /Retained quote/);
  assert.equal((await composer.input('`$review`', [], [])).some(part => part.type === 'skill'), false);
  const item = projectChatItem({ id: 'u', type: 'userMessage', content: input });
  assert.deepEqual(item.composerContext.filter(value => value.type === 'skill').map(skill => skill.name), ['review', 'plugin:inspect']);
  assert.equal(item.composerContext.find(value => value.type === 'quote')?.text, 'Retained quote');
});

test('Claude invokes one native skill, retains visible text/context and rejects unsupported combinations', async () => {
  const composer = new ClaudeComposer({});
  composer.skills = async () => ({ skills: available.map(skill => ({ ...skill, path: `native:${skill.name}` })) });
  const prepared = await composer.input('$review inspect this', []);
  assert.equal(prepared.blocks[0].text, '/review inspect this');
  assert.equal(prepared.context[0].name, 'review');
  assert.equal(prepared.context[0].invocation, 'native');
  await assert.rejects(composer.input('$review $plugin:inspect', []), /one|Invalid Claude skill/);
  await assert.rejects(composer.input('$review inspect', [{ kind: 'image' }]), /images/);
  const edited = await composer.input('ordinary request', [], prepared.context);
  assert.equal(edited.context.length, 0, 'removing an inline command from queued text removes its invocation');
  assert.equal(edited.blocks[0].text, 'ordinary request');
});
