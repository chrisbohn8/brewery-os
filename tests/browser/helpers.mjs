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

// Open the batch form (stage, transfer, packaging) for a tank card. Tapping a FULL tank opens the
// batch's page first, where "Stage / transfer…" opens the form; an empty tank opens it directly.
export async function openBatchForm(page, cardSelector) {
  await floor(page);
  await page.click(cardSelector);
  await page.waitForSelector("#batch-editor[open], #batch-view:not([hidden]), #tank-editor[open]");
  if (await page.isVisible("#batch-view")) {
    await page.click("#bv-edit");
    await page.waitForSelector("#batch-editor[open]");
  }
}
