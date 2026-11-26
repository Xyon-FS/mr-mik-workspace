// Layout recorded from Claude Code 2.1.312, with synthetic descriptions.
export const claudeModelScreen = (active = 4) => `   Select model
   Switch between Claude models. Your pick becomes the default for new sessions.
${['Default (recommended)', 'Opus', 'Fable', 'Sonnet', 'Haiku ✔'].map((name, index) => `   ${active === index ? '❯' : ' '} ${index + 1}. ${name.padEnd(25)}  Synthetic native description`).join('\n')}

   ◐ Medium effort (default) ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel`;

export const claudeEffortScreen = (active = 1) => {
  const point = [1, 10, 20, 30, 40][active];
  return `   Effort

                             Faster                             Smarter
                             ${'─'.repeat(point)}▲${'─'.repeat(40 - point)}      Ultracode  off
                             low     medium     high     xhigh      max      Tab to toggle

   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`;
};
