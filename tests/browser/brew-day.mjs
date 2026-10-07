// Brew log, part 2: the brew-day sheet. Turns (from the brewhouse, changeable), values saved as each
// box is left, water worked out from grist weight, meter readings, targets and "far from target",
// quick typing, no signal, and values still there after reloading. Real Chrome, local test copy.
import { chromium } from "playwright-core";
import { settings, floor } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test"; // admin of "Example Brewing" (°F, Plato)
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);
const allSent = () => page.waitForFunction(() => outbox.length === 0 && !sending && !busy, null, { timeout: 20000 });
const box = (field, part) => `#sheet [data-field="${field}"]${part ? `[data-part="${part}"]` : ""}`;
const row = (field) => page.locator(`#sheet .field:has([data-field="${field}"])`);
const value = (batchId, field, turn) => page.evaluate(([b, f, t]) =>
  data.readings.find((r) => r.batchId === b && r.fieldKey === f && (r.turn ?? null) === t), [batchId, field, turn]);
// Type into a box and leave it (like tapping the next box)
async function enter(field, val, part) {
  await page.fill(box(field, part), val);
  await page.press(box(field, part), "Tab");
}
async function leaveSheet() {
  await page.click("#view-title");
  await wait(50);
}

try {
  console.log("Setup: sign in, brewhouse with 2 usual turns, add a tank there, start a batch");
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
  check(await page.evaluate(() => prefs().volumeUnit === "bbl" && prefs().temperatureUnit === "F"), "brewery shows bbl and °F");

  await settings(page, "equipment");
  await page.click("#location-list .row >> nth=0");
  await page.waitForSelector("#location-editor[open]");
  await page.fill('#location-form [name="usualTurns"]', "2");
  await page.fill('#location-form [name="kettleFull"]', "16");
  await page.fill('#location-form [name="flowTarget"]', "6.6 - 5.5 - 6.2");
  await page.fill('#location-form [name="waterGrist"]', "1.3");
  await page.fill('#location-form [name="absorption"]', "0.125");
  await page.click("#location-form button[type=submit]");
  await allSent();
  const locationId = await page.evaluate(() => data.locations[0].id);

  const tankName = `BD-${run}`;
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', tankName);
  await page.selectOption('#tank-form [name="locationId"]', locationId);
  await page.click("#tank-form button[type=submit]");
  await page.waitForFunction((n) => data.tanks.some((t) => t.name === n), tankName);
  await floor(page);
  const tankId = await page.evaluate((n) => data.tanks.find((t) => t.name === n).id, tankName);
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `D${run}`);
  const beer = await page.evaluate(() => data.beers.find((b) => b.targetOg));
  await page.selectOption('#batch-form [name="beerId"]', beer.id);
  await page.click("#batch-form button[type=submit]");
  await page.waitForFunction((n) => data.batches.some((b) => b.batchNumber === n), `D${run}`);
  await allSent();
  const batchId = await page.evaluate((n) => data.batches.find((b) => b.batchNumber === n).id, `D${run}`);
  check(await page.evaluate((id) => data.batches.find((b) => b.id === id)?.turns, batchId) === 2, "a new batch gets the brewhouse's usual 2 turns");

  console.log("1. The batch page opens the brew-day sheet, with a tab per turn");
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  await page.click("#bv-sheet");
  await page.waitForSelector("#bv-brewday:not([hidden])");
  check(await page.isHidden("#bv-main"), "the rest of the batch page steps aside");
  check((await text("#turn-tabs")) === "Turn 1 Turn 2", `tabs: "${await text("#turn-tabs")}"`);
  check((await page.inputValue("#turn-count")) === "2", "turn count shows 2");
  check((await row("flow_rate").innerText()).includes("target 6.6 - 5.5 - 6.2"), "flow target comes from the brewhouse");
  check((await row("sparge_temp").innerText()).includes("target 168.0 °F"), "sparge target shown in °F");
  check((await row("kettle_full_volume").innerText()).includes("target 16"), "kettle full target from the brewhouse");

  console.log("2. Grist weight works out the water; values save as each box is left");
  await enter("grist_weight", "1000");
  await leaveSheet();
  await allSent();
  check((await value(batchId, "grist_weight", 1))?.value === 1000, "grist weight saved (turn 1)");
  const water = await text("#sheet .water");
  check(water?.includes("mash 325 gal") && water.includes("sparge 296 gal") && water.includes("total 621 gal"), `water: "${water}"`);
  check((await row("mash_water_volume").innerText()).includes("target 325 gal"), "mash water target: 325 gal");

  console.log("3. A meter reading saves the difference");
  await enter("mash_water_volume", "1200", "start");
  await enter("mash_water_volume", "1525", "end");
  await allSent();
  const meter = await value(batchId, "mash_water_volume", 1);
  check(Math.abs(meter?.value - 325 / 31) < 1e-9 && meter.raw.start === 1200 && meter.raw.end === 1525, `stored ${meter?.value} bbl with both readings`);
  check((await row("mash_water_volume").innerText()).includes("= 325 gal"), "shows = 325 gal");
  check(!(await row("mash_water_volume").getAttribute("class")).includes("off-target"), "on target: not highlighted");

  console.log("4. Quick typing down the sheet: every value is kept, in °F and °P");
  await enter("mash_strike_temp", "165");
  await enter("mash_temp", "152");
  await enter("vorlauf_start_temp", "150");
  await enter("vorlauf_end_temp", "151");
  await enter("sparge_temp", "168");
  await allSent();
  const temps = await Promise.all(["mash_strike_temp", "mash_temp", "vorlauf_start_temp", "vorlauf_end_temp", "sparge_temp"].map((f) => value(batchId, f, 1)));
  check(temps.every(Boolean), `all five saved (${temps.filter(Boolean).length})`);
  check(Math.abs(temps[1].value - (152 - 32) * 5 / 9) < 1e-3, `mash temp stored in °C (${temps[1].value})`);
  const og = beer.targetOg;
  await enter("ko_gravity", "4.0");  // way below the beer's target: a typo
  await allSent();
  check((await row("ko_gravity").getAttribute("class")).includes("off-target"), "a knockout gravity far from target is highlighted");
  check((await row("ko_gravity").innerText()).includes("Far from target"), "with a note");
  check((await row("ko_gravity").innerText()).includes("°P"), `target shown in °P (OG ${og})`);
  await enter("first_runnings_ph", "5.3");
  await enter("mash_start", "07:05");
  await allSent();
  check((await value(batchId, "first_runnings_ph", 1))?.value === 5.3, "pH saved");
  check((await value(batchId, "mash_start", 1))?.valueText === "07:05", "time saved");

  console.log("5. Turn 2 has its own values; whole-batch fields are shared");
  await page.click('#turn-tabs [data-turn="2"]');
  check((await page.inputValue(box("grist_weight"))) === "", "turn 2 starts empty");
  await enter("grist_weight", "980");
  await enter("yeast_strain", `House ale ${run}`);
  await allSent();
  check((await value(batchId, "grist_weight", 2))?.value === 980 && (await value(batchId, "grist_weight", 1))?.value === 1000, "turn 1 and turn 2 kept apart");
  check((await value(batchId, "yeast_strain", null))?.valueText === `House ale ${run}`, "yeast saved for the whole batch");
  await page.click('#turn-tabs [data-turn="1"]');
  check((await page.inputValue(box("grist_weight"))) === "1000" && (await page.inputValue(box("yeast_strain"))) === `House ale ${run}`, "back on turn 1: its values, same yeast");

  console.log("6. A correction keeps the history; the newest value shows");
  await enter("grist_weight", "1010");
  await allSent();
  check((await value(batchId, "grist_weight", 1))?.value === 1010, "corrected to 1010");
  const token = await page.evaluate(async () => (await db.auth.getSession()).data.session.access_token);
  const all = await page.evaluate(async (id) => (await db.from("batch_readings").select("value").eq("batch_id", id).eq("field_key", "grist_weight").eq("turn", 1)).data, batchId);
  check(all.length === 2, `both values kept in the database (${all.length})`);

  console.log("7. Filling in the sheet with no signal");
  await context.setOffline(true);
  await wait(300);
  await enter("kettle_full_volume", "16.2");
  await enter("brew_notes", `offline note ${run}`);
  check(await page.evaluate(() => outbox.length) === 2, "both kept to send later");
  check(!dialogs.some((d) => /needs signal/.test(d)), "no 'needs signal' message");
  await context.setOffline(false);
  await page.evaluate(() => refresh());
  await allSent();
  check(Math.abs((await value(batchId, "kettle_full_volume", 1))?.value - 16.2) < 1e-9, "kettle full sent once signal returned");

  console.log("8. Changing the number of turns");
  await leaveSheet();
  await page.selectOption("#turn-count", "3");
  await allSent();
  await page.waitForFunction(() => document.querySelectorAll("#turn-tabs button").length === 3);
  check(await page.evaluate((id) => data.batches.find((b) => b.id === id).turns, batchId) === 3, "now 3 turns");

  console.log("9. After reloading, everything is still there");
  await page.screenshot({ path: SHOTS + "brew-day-sheet.png", fullPage: true });
  await page.reload();
  await page.waitForSelector("#app-screen:not([hidden]) .card", { timeout: 20000 });
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  await page.click("#bv-sheet");
  check((await page.inputValue(box("grist_weight"))) === "1010", "grist weight");
  check((await page.inputValue(box("mash_temp"))) === "152", `mash temp in °F ("${await page.inputValue(box("mash_temp"))}")`);
  check((await page.inputValue(box("mash_water_volume", "end"))) === "1525", "meter end reading");
  check((await page.inputValue(box("brew_notes"))) === `offline note ${run}`, "the note typed with no signal");
  await page.click("#bv-sheet-back");
  check(await page.isVisible("#bv-main") && await page.isHidden("#bv-brewday"), "back to the batch page");
  check(!(await page.evaluate(() => document.getElementById("sync-problems").hidden === false)), "nothing was refused");
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
