// UI acceptance helper: supports remaining native and shared dark selectors.
export async function selectControl(page, label, value) {
  if (label === 'Filter tools by type') { await page.getByRole('group', { name: 'Tool type', exact: true }).getByRole('button', { name: { all: 'All', mcp: 'MCP', plugin: 'Plugins' }[value], exact: true }).click(); return; }
  const group = page.getByRole('group', { name: label, exact: true });
  if (await group.count() && await group.locator('[role=radio]').count()) { await group.locator(`[role=radio][data-value=${JSON.stringify(value)}]`).click(); return; }
  if (['Filter MCP by agent', 'Filter MCP by scope'].includes(label) && !await page.getByRole('combobox', { name: label, exact: true }).count()) await page.getByRole('button', { name: 'Tool filters', exact: true }).click();
  const control = page.getByRole('combobox', { name: label, exact: true });
  if (await control.evaluate(element => element.tagName === 'SELECT')) return control.selectOption(value);
  await control.click();
  await page.getByRole('listbox', { name: label, exact: true }).locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
  if (['Filter MCP by agent', 'Filter MCP by scope'].includes(label)) await page.keyboard.press('Escape');
}
