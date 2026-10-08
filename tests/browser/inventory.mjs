// Inventory, step 1: finished goods. Packaging puts kegs into the location's storage place; stock
// moves up to the taproom; removals and count sheets take it out (oldest batch first); an opening
// count adds beer from before the app; reasons can be required; it all works with no signal.
// Real Chrome, local test copy.
import { chromium } from "playwright-core";
import { settings, floor } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);
const allSent = () => page.waitForFunction(() => outbox.length === 0 && !sending && !busy, null, { timeout: 20000 });
const onHand = (place, beer) => page.evaluate(([p, b]) => sumCount(stockOnHand().filter((r) => r.placeId === p && r.beerId === b)), [place, beer]);
async function inventory() {
  await floor(page);
  await page.click("#open-inventory");
  await page.waitForSelector("#inventory-view:not([hidden])");
}

try {
  console.log("Setup: sign in, a taproom place, a tank, a batch of a new beer packaged into 20 halves");
  await page.goto(APP);
  await page.waitForSelector("#signin-screen:not([hidden]), #app-screen:not([hidden])", { timeout: 20000 });
  if (await page.isVisible("#signin-screen")) {
    const before = new Set(((await (await fetch(`${MAIL}/messages`)).json()).messages || []).map((m) => m.ID));
    await page.fill('#signin-form [name="email"]', EMAIL);
    await page.click("#signin-form button[type=submit]");
    await page.waitForSelector("#code-form:not([hidden])");
    let code = null;
    for (let i = 0; i < 40 && !code; i++) {
      const msg = ((await (await fetch(`${MAIL}/messages`)).json()).messages || []).find((m) => !before.has(m.ID) && m.To.some((t) => t.Address === EMAIL));
      if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
      if (!code) await wait(300);
    }
    await page.fill('#code-form [name="code"]', code);
    await page.click("#code-form button[type=submit]");
  }
  await page.waitForSelector("#app-screen:not([hidden]) .card", { timeout: 20000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const locationId = await page.evaluate(() => data.locations[0].id);
  await settings(page, "equipment");
  check((await text("#place-list")).includes("Storage"), "each location has a storage place");
  await page.fill('#place-form [name="name"]', `Taproom ${run}`);
  await page.selectOption('#place-form [name="locationId"]', locationId);
  await page.selectOption('#place-form [name="kind"]', "taproom");
  await page.click("#place-form button[type=submit]");
  await allSent();
  const [storage, taproom] = await page.evaluate(([loc, name]) => [
    data.places.find((p) => p.locationId === loc && p.kind === "storage").id, data.places.find((p) => p.name === name).id], [locationId, `Taproom ${run}`]);
  // A beer of its own, so counts in this run start from zero
  const beerId = await page.evaluate(async (name) => {
    const id = crypto.randomUUID();
    await db.from("beers").insert({ id, brewery_id: brewery.id, code: name.toLowerCase(), name });
    await refresh();
    return id;
  }, `Inv Ale ${run}`);
  const tank = `IN-${run}`;
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', tank);
  await page.selectOption('#tank-form [name="locationId"]', locationId);
  await page.click("#tank-form button[type=submit]");
  await page.waitForFunction((n) => data.tanks.some((t) => t.name === n), tank);
  await floor(page);
  const tankId = await page.evaluate((n) => data.tanks.find((t) => t.name === n).id, tank);
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `I${run}`);
  await page.selectOption('#batch-form [name="beerId"]', beerId);
  await page.fill('#batch-form [name="sizeBbl"]', "30");
  await page.click("#batch-form button[type=submit]");
  await allSent();
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  await page.click("#bv-package");
  await page.waitForSelector("#package-editor[open]");
  check((await page.inputValue('#package-form [name="placeId"]')) === storage, "packaging goes into the location's storage by default");
  await page.fill(`[data-package-type="${await page.evaluate(() => data.packageTypes.find((t) => t.catalogKey === "keg_half").id)}"]`, "20");
  await page.click("#package-form button[type=submit]");
  await allSent();
  check((await text("#bv-family")).includes("In stock: 20 × ½ bbl keg"), `the batch page shows its stock: "${await text("#bv-family")}"`);
  check(await onHand(storage, beerId) === 20, "20 halves in storage");

  console.log("1. The Inventory screen");
  await inventory();
  const table = await text("#inv-table");
  check(table.includes(`Inv Ale ${run}`) && table.includes("20"), "the beer is listed with 20 halves");
  await page.click(`[data-inv-beer="${beerId}"]`);
  check((await text("#inv-table")).includes(`#I${run}`), "tapping it shows the batch behind it");

  console.log("2. Move 3 up to the taproom, with a reason");
  await page.click("#inv-move");
  await page.waitForSelector("#stock-editor[open]");
  await page.selectOption('#stock-form [name="fromPlaceId"]', storage);
  await page.selectOption('#stock-form [name="toPlaceId"]', taproom);
  await page.selectOption('#stock-form [name="beerId"]', beerId);
  await page.fill("[data-stock-type]", "3");
  await page.fill('#stock-form [name="reason"]', "Stocked the taproom");
  await page.click("#stock-form button[type=submit]");
  await allSent();
  check(await onHand(storage, beerId) === 17 && await onHand(taproom, beerId) === 3, "17 in storage, 3 in the taproom");
  check((await text("#inv-recent")).includes("Stocked the taproom"), "the reason shows in Recent");

  console.log("3. Sell 2 from storage to an account");
  await page.click("#inv-remove");
  await page.waitForSelector("#stock-editor[open]");
  await page.selectOption('#stock-form [name="fromPlaceId"]', storage);
  await page.selectOption('#stock-form [name="beerId"]', beerId);
  await page.selectOption('#stock-form [name="removal"]', "sold");
  await page.fill("[data-stock-type]", "2");
  await page.fill('#stock-form [name="account"]', "Corner Bar");
  await page.click("#stock-form button[type=submit]");
  await allSent();
  check(await onHand(storage, beerId) === 15, "15 left in storage");

  console.log("4. Count the taproom: 1 left (2 poured)");
  await page.click("#inv-count");
  await page.waitForSelector("#count-editor[open]");
  await page.selectOption('#count-form [name="placeId"]', taproom);
  check((await page.inputValue('#count-form [name="drop"]')) === "taproom", "a taproom's drop defaults to poured");
  await page.fill(`#count-sheet input[data-beer="${beerId}"][data-type="${await page.evaluate(() => data.packageTypes.find((t) => t.catalogKey === "keg_half").id)}"]`, "1");
  check((await text("#count-summary")).includes("−2"), `summary: "${await text("#count-summary")}"`);
  await page.screenshot({ path: SHOTS + "count-sheet.png" });
  await page.click("#count-form button[type=submit]");
  await allSent();
  check(await onHand(taproom, beerId) === 1, "the taproom has 1");
  check(await page.evaluate((b) => data.stockMoves.filter((m) => m.beerId === b && m.removalKind === "taproom").reduce((s, m) => s + m.count, 0), beerId) === 2,
    "2 recorded as poured in the taproom");

  console.log("5. An opening count: a beer from before the app");
  const oldBeer = await page.evaluate(async (name) => {
    const id = crypto.randomUUID();
    await db.from("beers").insert({ id, brewery_id: brewery.id, code: name.toLowerCase().replace(/\s/g, "-"), name });
    await refresh();
    return id;
  }, `Old Stock ${run}`);
  await page.click("#inv-count");
  await page.waitForSelector("#count-editor[open]");
  await page.selectOption('#count-form [name="placeId"]', storage);
  await page.selectOption("#count-add", oldBeer);
  await page.fill(`#count-sheet input[data-beer="${oldBeer}"][data-type="${await page.evaluate(() => data.packageTypes.find((t) => t.catalogKey === "keg_half").id)}"]`, "4");
  await page.click("#count-form button[type=submit]");
  await allSent();
  check(await onHand(storage, oldBeer) === 4, "4 halves of a beer never packaged in the app");
  await page.click(`[data-inv-beer="${oldBeer}"]`);
  check((await text("#inv-table")).includes("From before the app"), "shown as stock from before the app");

  console.log("6. Requiring a reason");
  await settings(page, "packages");
  await page.check('#reasons-form [name="required"]');
  await page.fill('#reasons-form [name="reasons"]', "Stocked the taproom\nDock sale\nDistributor order");
  await page.click("#reasons-form button[type=submit]");
  await allSent();
  await inventory();
  await page.click("#inv-remove");
  await page.waitForSelector("#stock-editor[open]");
  await page.selectOption('#stock-form [name="fromPlaceId"]', storage);
  await page.selectOption('#stock-form [name="beerId"]', beerId);
  await page.fill("[data-stock-type]", "1");
  await page.click("#stock-form button[type=submit]");
  await wait(300);
  check(await page.isVisible("#stock-editor[open]") && await onHand(storage, beerId) === 15, "without a reason it won't save");
  check((await page.evaluate(() => [...document.querySelectorAll("#stock-reason-list option")].map((o) => o.value))).includes("Dock sale"), "the brewery's reasons are offered");
  await page.fill('#stock-form [name="reason"]', "Dock sale");
  await page.click("#stock-form button[type=submit]");
  await allSent();
  check(await onHand(storage, beerId) === 14, "with one, it saves");
  await settings(page, "packages");
  await page.uncheck('#reasons-form [name="required"]');
  await page.click("#reasons-form button[type=submit]");
  await allSent();

  console.log("7. A move with no signal: shown right away, sent later");
  await inventory();
  await context.setOffline(true);
  await wait(300);
  await page.click("#inv-move");
  await page.waitForSelector("#stock-editor[open]");
  await page.selectOption('#stock-form [name="fromPlaceId"]', storage);
  await page.selectOption('#stock-form [name="toPlaceId"]', taproom);
  await page.selectOption('#stock-form [name="beerId"]', beerId);
  await page.fill("[data-stock-type]", "4");
  await page.click("#stock-form button[type=submit]");
  await wait(300);
  check(await page.evaluate(() => outbox.length) === 1 && await onHand(taproom, beerId) === 5, "kept to send later, and the taproom shows 5 right away");
  await context.setOffline(false);
  await page.evaluate(() => refresh());
  await allSent();
  const dbCount = await page.evaluate(async ([p, b]) => (await db.from("stock_on_hand").select("count").eq("place_id", p).eq("beer_id", b)).data.reduce((s, r) => s + Number(r.count), 0), [taproom, beerId]);
  check(dbCount === 5, `sent: the database has 5 in the taproom (${dbCount})`);

  console.log("8. Pars at the taproom: under par, bring up from storage, and what's on deck");
  await page.click(`#inv-places [data-place="${taproom}"]`);
  await page.click("#set-pars");
  await page.waitForSelector("#pars-editor[open]");
  await page.fill(`[data-par-beer="${beerId}"][data-par="bbl"]`, "4");
  await page.click("#pars-form button[type=submit]");
  await allSent();
  const pars = await text("#inv-pars");
  check(pars.includes("2.5 bbl of 4 bbl (−1.5 bbl)"), `over / under: "${pars.slice(0, 160)}"`);
  check(pars.includes("Bring up 3 × ½ bbl keg from"), "suggests bringing up 3 halves from storage");
  await page.click("[data-bring]");
  await page.waitForSelector("#stock-editor[open]");
  check((await page.inputValue('#stock-form [name="toPlaceId"]')) === taproom && (await page.inputValue("[data-stock-type]")) === "3", "Bring up fills in the move");
  await page.click("#stock-form button[type=submit]");
  await allSent();
  check((await text("#inv-pars")).includes("4 bbl of 4 bbl") && !(await text("#inv-pars")).includes("Bring up"), "at par now");
  check((await text("#inv-deck")).includes(`Old Stock ${run}`), "on deck: the beer in storage that isn't at the taproom yet");
  await page.screenshot({ path: SHOTS + "pars.png", fullPage: true });

  console.log("9. A brewery-wide par");
  await page.click('#inv-places [data-place="all"]');
  await page.click("#set-pars");
  await page.waitForSelector("#pars-editor[open]");
  await page.fill(`[data-par-beer="${beerId}"][data-par="bbl"]`, "20");
  await page.click("#pars-form button[type=submit]");
  await allSent();
  check((await text("#inv-pars")).includes(`Inv Ale ${run}`) && (await text("#inv-pars")).includes("of 20 bbl"), "the brewery-wide par is shown against all places");
  check(await page.isHidden("#inv-deck"), "no 'on deck' for all places");
  await page.screenshot({ path: SHOTS + "inventory.png" });

  console.log("10. Raw materials: an item, a delivery, use on a batch, a count, and traceability");
  await page.click('#inv-tabs [data-inv-tab="raw"]');
  await page.click("#raw-items-open");
  await page.waitForSelector("#raw-item-editor[open]");
  const malt = `Pils malt ${run}`;
  await page.fill('#raw-item-form [name="name"]', malt);
  await page.selectOption('#raw-item-form [name="kind"]', "malt");
  await page.selectOption('#raw-item-form [name="unit"]', "lb");
  await page.fill('#raw-item-form [name="packName"]', "sack");
  await page.fill('#raw-item-form [name="packSize"]', "55");
  await page.fill('#raw-item-form [name="reorderLevel"]', "1000");
  await page.click("#raw-item-save");
  await allSent();
  await page.click("#raw-item-editor .cancel");
  await page.click("#raw-receive");
  await page.waitForSelector("#receive-editor[open]");
  await page.selectOption('#receive-form [name="itemId"]', { label: malt });
  check((await page.inputValue('#receive-form [name="unit"]')) === "pack", "a delivery is entered in sacks by default");
  await page.fill('#receive-form [name="amount"]', "20");
  await page.fill('#receive-form [name="lot"]', `L-${run}`);
  await page.fill('#receive-form [name="supplier"]', "Maltster");
  await page.click("#receive-form button[type=submit]");
  await allSent();
  const itemRow = async () => text(`[data-raw-item="${await page.evaluate((n) => data.rawItems.find((i) => i.name === n).id, malt)}"]`);
  check((await itemRow()).includes("1100 lb (20 sacks)"), `20 sacks received: "${await itemRow()}"`);
  check((await itemRow()).includes("Below the reorder level") === false, "above the reorder level");
  // Use 900 lb on the batch's brew day, as an ingredient with that lot
  await floor(page);
  await page.click(`.card[data-tank="${tankId}"]`).catch(() => {});
  const used = await page.evaluate(async ([name, lot, batchName]) => {
    const batch = data.batches.find((b) => b.batchNumber === batchName);
    await db.from("batch_additions").insert({ brewery_id: brewery.id, batch_id: batch.id, added_on: today(), kind: "malt", name,
      amount: 900, unit: "lb", timing: "Mash", lot, brew_day: true });
    await refresh();
    return batch.id;
  }, [malt, `L-${run}`, `I${run}`]);
  await inventory();
  await page.click('#inv-tabs [data-inv-tab="raw"]');
  check((await itemRow()).includes("200 lb") && (await itemRow()).includes("Below the reorder level"), `used on brew day: "${await itemRow()}"`);
  await page.click(`[data-raw-item="${await page.evaluate((n) => data.rawItems.find((i) => i.name === n).id, malt)}"]`);
  check((await itemRow()).includes(`Lot L-${run}`) && (await itemRow()).includes(`Used in #I${run}`), "the lot shows the batch that used it");
  await page.click("#raw-count");
  await page.waitForSelector("#raw-count-editor[open]");
  await page.selectOption('#raw-count-form [name="itemId"]', { label: malt });
  await page.fill('#raw-count-form [name="actual"]', "165");
  check((await text("#raw-count-note")).includes("−35 lb"), `count note: "${await text("#raw-count-note")}"`);
  await page.fill('#raw-count-form [name="reason"]', "spilled");
  await page.click("#raw-count-form button[type=submit]");
  await allSent();
  check((await itemRow()).includes("165 lb (3 sacks)"), `after the count: "${await itemRow()}"`);
  await page.screenshot({ path: SHOTS + "raw.png" });
  // The ingredient form offers the lot that's on hand
  await page.evaluate((id) => openBatchView(id), used);
  await page.click("#bv-add");
  await page.waitForSelector("#addition-editor[open]");
  await page.fill('#addition-form [name="name"]', malt);
  await page.dispatchEvent('#addition-form [name="name"]', "input");
  check((await page.evaluate(() => [...document.querySelectorAll("#addition-lots option")].map((o) => o.value))).includes(`L-${run}`), "the ingredient form suggests the lot on hand");
  await page.keyboard.press("Escape");
  await page.evaluate((id) => db.from("stock_places").update({ active: false }).eq("id", id), taproom); // tidy up: hide this run's taproom
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
  await page.screenshot({ path: SHOTS + "crash.png" }).catch(() => {});
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
