// Moving beer, step 4: splits and blends make a new batch (option A). A split keeps the rest in
// the source; a blend (here made with no signal) uses up its sources, and a used batch can't be
// moved. Real Chrome, local test copy.
import { chromium } from "playwright-core";
import { settings, floor, onDialog } from "./helpers.mjs";

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
await onDialog(page, (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);
const allSent = () => page.waitForFunction(() => outbox.length === 0 && !sending && !busy && !reloading, null, { timeout: 20000 });
const tankId = (name) => page.evaluate((n) => data.tanks.find((t) => t.name === n).id, name);
const batchId = (n) => page.evaluate((x) => data.batches.find((b) => b.batchNumber === x)?.id, n);
const card = async (name) => text(`.card[data-tank="${await tankId(name)}"]`);
async function openBatch(tank) {
  await floor(page);
  await page.click(`.card[data-tank="${await tankId(tank)}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
}
async function startBatch(tank, number, size) {
  await floor(page);
  await page.click(`.card[data-tank="${await tankId(tank)}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', number);
  await page.selectOption('#batch-form [name="beerId"]', await page.evaluate(() => data.beers[0].id));
  await page.fill('#batch-form [name="sizeBbl"]', String(size));
  await page.click("#batch-form button[type=submit]");
  await allSent();
}

try {
  console.log("Setup: sign in, four tanks, batch A (30 bbl) and batch B (20 bbl)");
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
  const [S1, S2, T1] = [`S1-${run}`, `S2-${run}`, `T1-${run}`];
  await settings(page, "equipment");
  for (const t of [S1, S2, T1]) {
    await page.click("#add-tank");
    await page.fill('#tank-form [name="name"]', t);
    await page.click("#tank-form button[type=submit]");
    await page.waitForFunction((n) => data.tanks.some((x) => x.name === n), t);
  }
  const [A, B] = [`A${run}`, `B${run}`];
  await startBatch(S1, A, 30);
  await startBatch(S2, B, 20);

  console.log("1. Split 12 bbl of A into a new batch");
  await openBatch(S1);
  await page.click("#bv-blend");
  await page.waitForSelector("#blend-editor[open]");
  check((await text("#blend-title")) === "Split into a new batch", "titled as a split");
  check((await page.inputValue('#blend-form [name="batchNumber"]')) === `${A}-2`, `suggested number: ${A}-2`);
  await page.fill("[data-source-volume]", "12");
  check(!(await page.isChecked("[data-source-used]")), "typing a part unticks 'all used'");
  await page.selectOption('#blend-form [name="tankId"]', await tankId(T1));
  check((await text("#blend-summary")).includes(`12 bbl in ${T1}`), `summary: "${await text("#blend-summary")}"`);
  await page.screenshot({ path: SHOTS + "split.png" });
  await page.click("#blend-form button[type=submit]");
  await allSent();
  await floor(page);
  check((await card(S1)).includes(`#${A}`) && (await card(S1)).includes("18 bbl"), `source: "${await card(S1)}"`);
  check((await card(T1)).includes(`#${A}-2`) && (await card(T1)).includes("12 bbl"), `split: "${await card(T1)}"`);
  await openBatch(T1);
  check((await text("#bv-family")) === `Made from 12 bbl of #${A}`, `family: "${await text("#bv-family")}"`);
  await page.click("#bv-family [data-open-batch]");
  check((await text("#bv-family")) === `Part went into #${A}-2 (12 bbl)`, `the source links back: "${await text("#bv-family")}"`);

  console.log("2. Blend all of the split and 19 bbl of B into the split's tank, with no signal");
  await context.setOffline(true);
  await wait(300);
  await openBatch(T1);
  await page.click("#bv-blend");
  await page.waitForSelector("#blend-editor[open]");
  await page.selectOption("#blend-add", await batchId(B));
  const rows = page.locator("#blend-sources [data-source]");
  await rows.nth(1).locator("[data-source-volume]").fill("19");
  await rows.nth(1).locator("[data-source-used]").check();
  check((await page.inputValue('#blend-form [name="batchNumber"]')) === `${A}-2/${B}`, "suggested number: both batch numbers");
  check((await text("#blend-title")) === "Blend into a new batch", "titled as a blend");
  await page.selectOption('#blend-form [name="tankId"]', await tankId(T1));
  check((await text("#blend-summary")).includes(`31 bbl in ${T1}`), `summary: "${await text("#blend-summary")}"`);
  await page.click("#blend-form button[type=submit]");
  await wait(300);
  check(await page.evaluate(() => outbox.length) === 1, "kept to send later");
  await floor(page);
  check((await card(T1)).includes(`#${A}-2/${B}`) && (await card(T1)).includes("31 bbl"), `shows right away: "${await card(T1)}"`);
  await context.setOffline(false);
  await page.evaluate(() => refresh());
  await allSent();
  check((await card(T1)).includes("31 bbl") && (await card(S2)).includes("Cleaning"), "sent: the blend holds 31 bbl, and B's tank goes to cleaning");
  const stages = await page.evaluate(async (ids) => (await db.from("batch_status").select("batch_number, stage").in("id", ids)).data, [await batchId(`${A}-2`), await batchId(B)]);
  check(stages.every((s) => s.stage === "used"), `database: both sources used (${JSON.stringify(stages)})`);

  console.log("3. A used batch: listed as used, and it can't be moved");
  check((await text("#packaged-list")).includes("Used in another batch"), "listed under batches out of tanks as used");
  await page.click(`#packaged-list [data-batch="${await batchId(B)}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  check((await text("#bv-family")).startsWith(`All used in #${A}-2/${B}`), `family: "${await text("#bv-family")}"`);
  check(await page.isHidden("#bv-edit") && await page.isHidden("#bv-blend"), "no move or split buttons");
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
