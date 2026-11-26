// Follow the same two-level disclosure navigation as a user; do not force open
// hidden DOM nodes or bypass browser interaction checks in acceptance tests.
export async function revealProcessFor(locator) {
  await locator.waitFor({state:'attached'});
  const parents = locator.locator('xpath=ancestor::details[contains(@class,"graphical-turn-process")]');
  for (let n = 0; n < await parents.count(); n++) {
    const parent = parents.nth(n);
    if (!await parent.evaluate(element => element.open)) await parent.locator(':scope > summary').click();
  }
}
