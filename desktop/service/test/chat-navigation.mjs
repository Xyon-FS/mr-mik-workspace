// Existing acceptance checks can select a chat without assuming visible global
// tabs. The dedicated navigation check covers grouping/filtering interactions.
export async function selectChatInNavigation(page, id) {
  const drawer = page.getByRole('complementary', { name: 'Conversations by project' });
  const all = page.getByRole('button', { name: 'Show all projects', exact: true });
  if (await drawer.isVisible()) await all.click();
  await all.click();
  await drawer.getByRole('button', { name: 'Filter chats', exact: true }).click();
  await page.getByRole('group', { name: 'Conversation filters' }).getByRole('button', { name: 'Open chats', exact: true }).click();
  const folded = drawer.locator('.project-chat-group-heading > button[aria-expanded="false"]');
  for (let index = 0; await folded.count(); index++) {
    if (index > 100) throw new Error('Unexpected project navigation expansion loop.');
    await folded.first().click();
  }
  await drawer.locator(`[data-chat-tab="${id}"] [role="tab"]`).click();
}
