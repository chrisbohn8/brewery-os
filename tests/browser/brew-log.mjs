// Brew log, part 1: the batch page, cellar log (with stage changes), additions, corrections,
// offline cellar logging, and brewhouse settings on a location. Real Chrome, local test copy.
import { chromium } from "playwright-core";
import { settings, floor } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test"; // admin of "Example Brewing" (°F, Plato)
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
const settle = async () => { await wait(150); await page.waitForFunction(() => !busy && !sending); await wait(100); };
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);

async function logCellar({ action, gravity, ph, temp, change, notes }) {
  await page.click("#bv-log");
  await page.waitForSelector("#cellar-editor[open]");
  await page.selectOption('#cellar-form [name="action"]', action);
  if (gravity) await page.fill('#cellar-form [name="gravity"]', gravity);
  if (ph) await page.fill('#cellar-form [name="ph"]', ph);
  if (temp) await page.fill('#cellar-form [name="temp"]', temp);
  if (change) await page.fill('#cellar-form [name="cellarChange"]', change);
  if (notes) await page.fill('#cellar-form [name="notes"]', notes);
  await page.click("#cellar-form button[type=submit]");
  await settle();
}

try {
  console.log("Setup: sign in, add a tank, start a batch");
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
  const tankName = `LOG-${run}`;
  await settings(page, "equipment");
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', tankName);
  await page.click("#tank-form button[type=submit]");
  await page.waitForFunction((n) => data.tanks.some((t) => t.name === n), tankName);
  await floor(page);
  const tankId = await page.evaluate((n) => data.tanks.find((t) => t.name === n).id, tankName);
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `L${run}`);
  await page.selectOption('#batch-form [name="beerId"]', await page.evaluate(() => data.beers[0].id));
  await page.click("#batch-form button[type=submit]");
  await page.waitForFunction((n) => data.batches.some((b) => b.batchNumber === n), `L${run}`);
  const batchId = await page.evaluate((n) => data.batches.find((b) => b.batchNumber === n).id, `L${run}`);

  console.log("1. Tapping a full tank opens the batch's page");
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  check((await text("#bv-title")).includes(`#L${run}`), `title: "${await text("#bv-title")}"`);
  check((await text("#bv-stage")) === "Fermenting", "stage badge: Fermenting");
  check((await text("#bv-meta")).includes(tankName), `details: "${await text("#bv-meta")}"`);
  check((await text("#bv-history")).includes(`Fermenting in ${tankName}`), "history shows the start");

  console.log("2. Log a check with readings in °P / °F and a cellar change");
  await logCellar({ action: "Check", gravity: "4.2", ph: "4.5", temp: "64", change: "FR to 62", notes: "smells great" });
  const first = await text("#bv-cellar .item");
  check(first.includes("Check") && first.includes("4.2 °P") && first.includes("pH 4.5") && first.includes("64.0 °F"), `entry shown: "${first}"`);
  check(first.includes("FR to 62") && first.includes("smells great"), "cellar change and notes shown");
  const stored = await page.evaluate((id) => data.cellar.find((c) => c.batchId === id), batchId);
  check(Math.abs(stored.gravitySg - 1.0165) < 0.0005 && Math.abs(stored.tempC - 17.78) < 0.01, `stored in standard units (SG ${stored.gravitySg}, ${stored.tempC} °C)`);

  console.log("3. A dry hop entry can move the stage");
  await page.click("#bv-log");
  await page.waitForSelector("#cellar-editor[open]");
  await page.selectOption('#cellar-form [name="action"]', "Dry hop");
  check(await page.isVisible("#cellar-stage-field"), `offered: "${await text("#cellar-stage-text")}"`);
  await page.click("#cellar-form button[type=submit]");
  await settle();
  check((await text("#bv-stage")) === "Dry hopping", "the batch is now Dry hopping");
  check((await text("#bv-history")).includes("Dry hopping"), "and the history shows it");

  console.log("4. An addition with its lot number");
  await page.click("#bv-add");
  await page.waitForSelector("#addition-editor[open]");
  await page.fill('#addition-form [name="name"]', "Citra");
  await page.fill('#addition-form [name="amount"]', "176");
  await page.fill('#addition-form [name="timing"]', "Primary");
  await page.fill('#addition-form [name="lot"]', "L123");
  await page.click("#addition-form button[type=submit]");
  await settle();
  const add = await text("#bv-additions .item");
  check(add.includes("Citra") && add.includes("176 oz") && add.includes("Primary") && add.includes("lot L123"), `addition shown: "${add}"`);

  console.log("5. Correcting an entry keeps it and marks it edited");
  const firstId = stored.id;
  await page.click(`[data-cellar="${firstId}"]`);
  await page.waitForSelector("#cellar-editor[open]");
  check((await page.inputValue('#cellar-form [name="gravity"]')) === "4.2", "the form shows the reading in °P");
  await page.fill('#cellar-form [name="notes"]', "smells great, slightly sulfur");
  await page.click("#cellar-form button[type=submit]");
  await settle();
  const fixed = await page.evaluate((id) => data.cellar.find((c) => c.id === id), firstId);
  check(fixed.notes.includes("sulfur") && fixed.edited, "the correction is saved and marked edited");
  check(Math.abs(fixed.gravitySg - stored.gravitySg) < 1e-9, "an unchanged reading stays exactly the same");

  console.log("6. Logging cellar work with no signal");
  await context.setOffline(true);
  await wait(300);
  await logCellar({ action: "Check", gravity: "2.8", notes: `offline ${run}` });
  check((await text("#bv-cellar")).includes(`offline ${run}`), "shows right away");
  check(await page.evaluate(() => outbox.length) === 1, "kept to send later");
  await context.setOffline(false);
  await page.waitForFunction(() => outbox.length === 0 && !sending, null, { timeout: 30000 });
  await settle();
  check(await page.evaluate((r) => data.cellar.some((c) => c.notes === `offline ${r}`), run), "sent once signal returned");

  console.log("7. Brewhouse settings on a location");
  await settings(page, "equipment");
  await page.click("#location-list .row >> nth=0");
  await page.waitForSelector("#location-editor[open]");
  await page.fill('#location-form [name="turnSize"]', "15");
  await page.fill('#location-form [name="usualTurns"]', "2");
  await page.fill('#location-form [name="kettleFull"]', "16");
  await page.fill('#location-form [name="flowTarget"]', "6.6 - 5.5 - 6.2");
  await page.fill('#location-form [name="waterGrist"]', "1.234");
  await page.fill('#location-form [name="absorption"]', "0.125");
  await page.click("#location-form button[type=submit]");
  await settle();
  const loc = await page.evaluate(() => data.locations[0]);
  check(loc.turnSizeBbl === 15 && loc.usualTurns === 2 && loc.kettleFullBbl === 16 && loc.flowTarget === "6.6 - 5.5 - 6.2"
        && loc.waterGristQtLb === 1.234 && loc.absorptionGalLb === 0.125, `brewhouse saved: ${JSON.stringify(loc)}`);
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
