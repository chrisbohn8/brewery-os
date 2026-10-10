// Kicked kegs and "Almost gone" (docs/keg-design.md, step 1), in a demo: a taproom's lines each have
// a Kicked button; kicking logs the keg (the size it most likely was, filled in), the line pours the
// next keg, or is empty, or opens to choose something new; the month's kicks add up by beer and size,
// can be looked at month by month, removed, and downloaded; stock isn't changed; the menu board marks
// the beer with no kegs left in storage "Almost gone". Also on a phone. (The API's kicks: api-writes.mjs.)
// Real Chrome against the local test copy. Deletes the demos it made.
import { chromium } from "playwright-core";
import { onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const made = [];

async function demo(width, height) {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  page.errors = [];
  await onDialog(page, (d) => d.accept());
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${APP}#demo`);
  await page.click("#try-demo");
  await page.waitForFunction(() => typeof DemoTour !== "undefined" && DemoTour.open, null, { timeout: 60000 });
  made.push(page);
  await page.click('.tour-card [data-tour="skip"]');
  return page;
}
const settle = async (p) => { await wait(150); await p.waitForFunction(() => !busy && !reloading); await wait(100); };
// Open a taproom in Inventory (the one with the one-off blend on a line)
async function openTaproom(page) {
  const placeId = await page.evaluate(() => data.lines.find((l) => l.beerId && findBeer(l.beerId)?.name === "Brewer's Blend")?.placeId
    || data.places.find((p) => p.kind === "taproom").id);
  await page.click("#open-inventory");
  await page.click(`[role=tab][data-place="${placeId}"]`);
  await page.waitForSelector("#inv-lines:not([hidden])");
  return placeId;
}

try {
  console.log("1. Kicked, on a computer");
  const page = await demo(1280, 900);
  const placeId = await openTaproom(page);
  const kickButtons = await page.locator("#inv-lines [data-kick]").count();
  const pouring = await page.evaluate((p) => data.lines.filter((l) => l.placeId === p && ["beer", "other"].includes(l.status)).length, placeId);
  check(kickButtons === pouring && pouring > 0, `a Kicked button on each pouring line (${kickButtons} of ${pouring}), none on empty lines`);
  const thisMonth = await page.textContent("#kicked");
  check(/Kicked kegs/.test(thisMonth) && /kicked in/.test(thisMonth), "the month's kicks are under the lines (the demo has some)");

  const line1 = await page.evaluate((p) => { const l = data.lines.find((x) => x.placeId === p && x.lineNo === 1); return { id: l.id, beer: findBeer(l.beerId).name, beerId: l.beerId }; }, placeId);
  const before = await page.evaluate((b) => ({ kicks: data.kicks.filter((k) => k.beerId === b).length, stock: stockOnHand().filter((r) => r.beerId === b).reduce((s, r) => s + r.count, 0) }), line1.beerId);
  await page.click(`#inv-lines [data-kick="${line1.id}"]`);
  await page.waitForSelector("#kick-editor[open]");
  const title = await page.textContent("#kick-title");
  const size = await page.evaluate(() => kickForm.typeId.selectedOptions[0]?.textContent);
  check(title.includes(`Line 1: ${line1.beer} kicked`) && size === "½ bbl keg", `the form: "${title}", keg size filled in (${size})`);
  check((await page.textContent("#kick-same")).includes(line1.beer), "\"The next keg of …\" is the usual answer");
  await page.screenshot({ path: `${SHOTS}kegs-kick-form.png` });
  await page.click('#kick-form button[type="submit"]');
  await settle(page);
  const after = await page.evaluate((b) => ({ kicks: data.kicks.filter((k) => k.beerId === b).length, stock: stockOnHand().filter((r) => r.beerId === b).reduce((s, r) => s + r.count, 0) }), line1.beerId);
  check(after.kicks === before.kicks + 1, "logged");
  check(after.stock === before.stock, "stock isn't changed (counts do that)");
  check(await page.evaluate((id) => data.lines.find((l) => l.id === id).status === "beer", line1.id), "the line still pours it (the next keg)");

  // Kicked, and the line is empty
  const line2 = await page.evaluate((p) => data.lines.find((x) => x.placeId === p && x.lineNo === 2).id, placeId);
  await page.click(`#inv-lines [data-kick="${line2}"]`);
  await page.check('#kick-form [name="then"][value="empty"]');
  await page.click('#kick-form button[type="submit"]');
  await settle(page);
  check(await page.evaluate((id) => data.lines.find((l) => l.id === id).status === "empty", line2), "the last keg: the line is empty, with no Kicked button");
  // Kicked, and something new goes on: the line's own form opens
  const line3 = await page.evaluate((p) => data.lines.find((x) => x.placeId === p && x.lineNo === 3).id, placeId);
  await page.click(`#inv-lines [data-kick="${line3}"]`);
  await page.check('#kick-form [name="then"][value="change"]');
  await page.click('#kick-form button[type="submit"]');
  await settle(page);
  check(await page.isVisible("#line-editor[open]") && (await page.textContent("#line-title")) === "Line 3", "something new on it: the line's form opens to choose it");
  await page.click("#line-editor .cancel");

  // The month's totals, by beer and size
  const total = await page.textContent("#kick-totals");
  check(total.includes(line1.beer) && /\d+ × ½ bbl keg/.test(total), `added up by beer and size ("${total.replace(/\s+/g, " ").trim().slice(0, 80)}…")`);
  await page.screenshot({ path: `${SHOTS}kegs-month.png`, fullPage: true });
  // Month by month
  const month = await page.textContent("#kick-month");
  check(await page.isDisabled('[data-kick-month="1"]'), "no months after this one");
  await page.click('[data-kick-month="-1"]');
  const last = await page.textContent("#kick-month");
  check(last !== month && /kicked in|None logged/.test(await page.textContent("#kicked")), `last month: ${last}`);
  await page.click('[data-kick-month="1"]');
  // Download the month
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#kick-csv")]);
  const csv = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  check(/Month,Taproom,Beer,Keg,Kicked/.test(csv) && csv.includes(line1.beer), `the month downloads as a spreadsheet (${download.suggestedFilename()})`);
  // Removing a mistake
  const n = await page.evaluate(() => data.kicks.length);
  await page.click("#kicked details summary");
  await page.locator("#kicked [data-unkick]").first().click();
  await settle(page);
  check(await page.evaluate(() => data.kicks.length) === n - 1, "a mistaken kick can be removed");

  console.log("2. Almost gone on the menu board");
  const board = await page.evaluate(async (p) => (await db.rpc("menu_board_preview_content", { p_place_id: p, p_public: false })).data, placeId);
  const almost = board.lines.filter((l) => l.beer?.almost_gone).map((l) => l.beer.name);
  check(almost.includes("Brewer's Blend") && almost.length < board.lines.length / 2, `marked: ${almost.join(", ")} (no kegs left in storage)`);
  const drawn = await page.evaluate((b) => BoardView.render({ ...b, board: { parts: BoardView.DEFAULT_PARTS } }, "tv"), board);
  check((drawn.match(/mb-almost/g) || []).length === almost.length, "the board draws the badge on those beers");
  check(await page.evaluate(() => BoardView.PARTS.some((p) => p.id === "almost")), "it's a part boards can show or hide in the builder");

  console.log("3. On a phone");
  const phone = await demo(390, 844);
  await openTaproom(phone);
  const fits = await phone.evaluate(() => [...document.querySelectorAll("#inv-lines .line-row")].every((r) => r.getBoundingClientRect().right <= innerWidth + 1)
    && document.documentElement.scrollWidth <= innerWidth);
  check(fits, "each line and its Kicked button fit the screen, no sideways scrolling");
  await phone.locator("#inv-lines [data-kick]").first().click();
  await phone.waitForSelector("#kick-editor[open]");
  await phone.screenshot({ path: `${SHOTS}kegs-phone.png` });
  await phone.click('#kick-form button[type="submit"]');
  await settle(phone);
  check(await phone.evaluate(() => data.kicks.filter((k) => k.recordedAt > new Date(Date.now() - 60000).toISOString()).length) === 1, "kicked on a phone");

  check([page, phone].every((p) => p.errors.length === 0), `no page errors (${[page, phone].flatMap((p) => p.errors).join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  for (const p of made) await p.evaluate(() => db.rpc("delete_brewery", { p_brewery_id: brewery.id })).catch(() => {});
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
