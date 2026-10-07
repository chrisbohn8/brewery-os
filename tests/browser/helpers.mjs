// Shared steps for the browser tests.

// Open a Settings page ("brewery", "equipment", "beers", "cleaning", "team", "backup", "account")
export async function settings(page, name) {
  if (await page.isVisible("#open-settings")) await page.click("#open-settings");
  await page.click(`#settings-nav [data-page="${name}"]`);
  await page.waitForSelector(`.settings-page[data-page="${name}"]:not([hidden])`);
}

// Back to the tank board
export async function floor(page) {
  if (await page.isVisible("#close-settings")) await page.click("#close-settings");
  await page.waitForSelector("#floor-view:not([hidden])");
}
