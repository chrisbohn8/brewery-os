// Moving beer, step 2: package types (catalog + your own), packaging runs that turn counts into
// barrels, the "what's left fills about..." calculator, and "this tank is spent" (with no signal).
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
const errors = [], dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);
const allSent = () => page.waitForFunction(() => outbox.length === 0 && !sending && !busy, null, { timeout: 20000 });
const typeId = (name) => page.evaluate((n) => data.packageTypes.find((t) => t.name === n)?.id, name);
const count = async (name, n) => page.fill(`[data-package-type="${await typeId(name)}"]`, String(n));

try {
  console.log("Setup: sign in");
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

  console.log("1. Package types: the usual ones, a catalog one, and your own");
  await settings(page, "packages");
  check(await page.isChecked('[data-package-key="keg_half"]') && await page.isChecked('[data-package-key="case_24x16"]'),
    "half barrel kegs and 16 oz cases are ticked to start");
  check((await text("#package-type-picker")).includes("Firkin (9 imperial gal) 10.81 gal"), "the catalog shows sizes (a firkin is 10.81 gal)");
  if (!(await page.isChecked('[data-package-key="keg_50l"]'))) {
    await page.check('[data-package-key="keg_50l"]');
    await page.waitForFunction(() => data.packageTypes.some((t) => t.catalogKey === "keg_50l" && t.active));
  }
  check(true, "ticked the 50 L keg");
  await page.fill('#own-package-form [name="name"]', `Crate ${run}`);
  await page.fill('#own-package-form [name="volume"]', "500");
  await page.selectOption('#own-package-form [name="unit"]', "ml");
  await page.fill('#own-package-form [name="per"]', "20");
  await page.selectOption('#own-package-form [name="kind"]', "case");
  await page.click("#own-package-form button[type=submit]");
  await allSent();
  const crate = await page.evaluate((n) => data.packageTypes.find((t) => t.name === n), `Crate ${run}`);
  check(crate && Math.abs(crate.volumeBbl * 31 - 20 * 0.5 * 0.264172) < 1e-6, `your own: 20 × 500 mL = ${(crate?.volumeBbl * 31).toFixed(2)} gal`);

  console.log("2. A batch of 30 bbl, ready to package");
  const tank = `PK-${run}`;
  await settings(page, "equipment");
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', tank);
  await page.click("#tank-form button[type=submit]");
  await page.waitForFunction((n) => data.tanks.some((t) => t.name === n), tank);
  await floor(page);
  const tankId = await page.evaluate((n) => data.tanks.find((t) => t.name === n).id, tank);
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `P${run}`);
  await page.selectOption('#batch-form [name="beerId"]', await page.evaluate(() => data.beers[0].id));
  await page.fill('#batch-form [name="sizeBbl"]', "30");
  await page.selectOption('#batch-form [name="stage"]', "ready");
  await page.click("#batch-form button[type=submit]");
  await allSent();
  const batchId = await page.evaluate((n) => data.batches.find((b) => b.batchNumber === n).id, `P${run}`);

  console.log("3. First run: 40 halves, more to package later");
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  await page.click("#bv-package");
  await page.waitForSelector("#package-editor[open]");
  check((await text("#package-summary")).includes("has about 30 bbl"), `before counting: "${await text("#package-summary")}"`);
  await count("½ bbl keg", 40);
  check((await text("#package-summary")) === `= 20 bbl · about 10 bbl left in ${tank}`, `summary: "${await text("#package-summary")}"`);
  check((await text("#package-fits")).includes("20 × ½ bbl keg"), `calculator: "${await text("#package-fits")}"`);
  await page.screenshot({ path: SHOTS + "packaging.png" });
  await page.click("#package-form button[type=submit]");
  await allSent();
  await floor(page);
  check((await text(`.card[data-tank="${tankId}"]`)).includes("10 bbl"), "the tank card shows 10 bbl left");
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  check((await text("#bv-history")).includes(`20 bbl packaged from ${tank} (40 × ½ bbl keg)`), `history: "${await text("#bv-history")}"`);

  console.log("4. Last run with no signal: 12 sixtels and 62 cases, and the tank is spent");
  await context.setOffline(true);
  await wait(300);
  await page.click("#bv-package");
  await page.waitForSelector("#package-editor[open]");
  await count("⅙ bbl keg", 12);
  await count("Case, 24 × 16 oz", 62);
  await page.check('#package-form [name="spent"][value="yes"]');
  const note = await text("#package-spent-note");
  check(note.includes("2 bbl is recorded as loss"), `spent note: "${note}"`);
  dialogs.length = 0;
  await page.click("#package-form button[type=submit]");
  await wait(300);
  check(dialogs.some((m) => m.includes("unaccounted for")), `a 20% leftover asks first: "${dialogs[0]}"`);
  check(await page.evaluate(() => outbox.length) === 1, "kept to send later");
  check(await page.evaluate((id) => data.batches.find((b) => b.id === id).stage === "packaged", batchId), "shows as packaged right away");
  await context.setOffline(false);
  await page.evaluate(() => refresh());
  await allSent();
  const moves = await page.evaluate(async (id) => (await db.from("beer_movements").select("kind, volume_bbl, notes").eq("batch_id", id).order("recorded_at")).data, batchId);
  const loss = moves.find((m) => m.kind === "loss");
  check(moves.filter((m) => m.kind === "package").length === 2 && loss && Math.abs(Number(loss.volume_bbl) - 2) < 0.001 && loss.notes === "tank spent",
    `database: two runs and a 2 bbl "tank spent" loss`);
  check(await page.evaluate((id) => data.tanks.find((t) => t.id === id).status, tankId) === "cleaning", "the tank goes to cleaning");

  console.log("5. Unticking a package type");
  await settings(page, "packages");
  await page.uncheck('[data-package-key="keg_50l"]');
  await page.waitForFunction(() => !data.packageTypes.find((t) => t.catalogKey === "keg_50l").active);
  check(true, "50 L keg no longer offered");
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
