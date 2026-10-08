// Moving beer, step 1: volumes. A batch is knocked out with its size, transfers ask how much
// moved (what's left behind is a loss), packaging takes it out, it all works with no signal, and
// a batch without a volume still works. Real Chrome, local test copy.
import { chromium } from "playwright-core";
import { settings, floor, openBatchForm } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test"; // admin of "Example Brewing" (bbl)
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
const allSent = () => page.waitForFunction(() => outbox.length === 0 && !sending && !busy && !reloading, null, { timeout: 20000 });
const tankId = (name) => page.evaluate((n) => data.tanks.find((t) => t.name === n).id, name);
const card = async (name) => text(`.card[data-tank="${await tankId(name)}"]`);
const dbMovements = (batchId) => page.evaluate(async (id) =>
  (await db.from("beer_movements").select("kind, volume_bbl, notes").eq("batch_id", id).order("recorded_at")).data, batchId);

try {
  console.log("Setup: sign in, add three tanks");
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
  const [FV, BT, FV2] = [`VF-${run}`, `VB-${run}`, `VG-${run}`];
  await settings(page, "equipment");
  for (const t of [FV, BT, FV2]) {
    await page.click("#add-tank");
    await page.fill('#tank-form [name="name"]', t);
    await page.click("#tank-form button[type=submit]");
    await page.waitForFunction((n) => data.tanks.some((x) => x.name === n), t);
  }
  await floor(page);

  console.log("1. A new 30 bbl batch: the fermenter holds 30 bbl");
  await page.click(`.card[data-tank="${await tankId(FV)}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `V${run}`);
  await page.selectOption('#batch-form [name="beerId"]', await page.evaluate(() => data.beers[0].id));
  await page.fill('#batch-form [name="sizeBbl"]', "30");
  check(await page.isHidden("#volume-field"), "no 'volume moved' when starting a batch");
  await page.click("#batch-form button[type=submit]");
  await allSent();
  const batchId = await page.evaluate((n) => data.batches.find((b) => b.batchNumber === n).id, `V${run}`);
  check((await card(FV)).includes("30 bbl"), `card: "${await card(FV)}"`);

  console.log("2. Transfer 29 bbl to the brite: 1 bbl left behind is a loss");
  await openBatchForm(page, `.card[data-tank="${await tankId(FV)}"]`);
  check(await page.isHidden("#volume-field"), "no 'volume moved' until the tank changes");
  await page.selectOption('#batch-form [name="tankId"]', await tankId(BT));
  check(await page.isVisible("#volume-field"), "changing the tank asks how much moved");
  check((await page.getAttribute('#batch-form [name="volume"]', "placeholder")) === "all of it (30)", "placeholder: all of it (30)");
  await page.fill('#batch-form [name="volume"]', "29");
  check((await text("#volume-note")).includes("1 bbl left in") && (await text("#volume-note")).includes("loss"), `note: "${await text("#volume-note")}"`);
  await page.click("#batch-form button[type=submit]");
  await allSent();
  await floor(page);
  check((await card(BT)).includes("29 bbl"), `brite: "${await card(BT)}"`);
  check((await card(FV)).includes("Cleaning"), "the fermenter goes to cleaning");
  const moves = await dbMovements(batchId);
  check((moves.length === 3 && moves[1].kind === "transfer" && Number(moves[1].volume_bbl) === 29 && moves[2].kind === "loss" && Number(moves[2].volume_bbl) === 1),
    `database: ${JSON.stringify(moves)}`);
  await page.click(`.card[data-tank="${await tankId(BT)}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  const history = await text("#bv-history");
  check(history.includes(`30 bbl knocked out into ${FV}`) && history.includes(`29 bbl moved ${FV} → ${BT}`) && history.includes(`1 bbl lost from ${FV}`),
    `history: "${history}"`);
  check((await text("#bv-meta")).includes("29 bbl in the tank"), `batch page: "${await text("#bv-meta")}"`);

  console.log("3. Packaging with no signal: all of it, shown right away, sent later");
  await context.setOffline(true);
  await wait(300);
  await openBatchForm(page, `.card[data-tank="${await tankId(BT)}"]`);
  await page.selectOption('#batch-form [name="stage"]', "packaged");
  check((await text("#volume-note")).includes("Everything in") && (await text("#volume-note")).includes("29 bbl"), `note: "${await text("#volume-note")}"`);
  await page.click("#batch-form button[type=submit]");
  await wait(300);
  check(await page.evaluate(() => outbox.length) === 1, "kept to send later");
  await page.click(`.card[data-tank="${await tankId(FV)}"]`).catch(() => {});
  await page.keyboard.press("Escape");
  check(await page.evaluate((id) => data.movements.some((m) => m.batchId === id && m.kind === "package" && m.volumeBbl === 29), batchId),
    "the 29 bbl packaged shows right away");
  await context.setOffline(false);
  await page.evaluate(() => refresh());
  await allSent();
  const after = await dbMovements(batchId);
  check(after.some((m) => m.kind === "package" && Number(m.volume_bbl) === 29) && after.length === 4, `sent once signal returned: ${after.length} movements`);

  console.log("4. A batch with no volume anywhere still works, and the brew sheet's knockout volume fills it in");
  await floor(page);
  await page.click(`.card[data-tank="${await tankId(FV2)}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `W${run}`);
  await page.selectOption('#batch-form [name="beerId"]', await page.evaluate(() => data.beers[0].id));
  await page.click("#batch-form button[type=submit]");
  await allSent();
  check((await card(FV2)).includes("volume not recorded"), `card: "${await card(FV2)}"`);
  const second = await page.evaluate((n) => data.batches.find((b) => b.batchNumber === n).id, `W${run}`);
  await page.evaluate(([id, b]) => db.from("batch_readings").insert({ brewery_id: b, batch_id: id, field_key: "ko_volume", value: 15.5 }), [second, await page.evaluate(() => brewery.id)]);
  await page.evaluate(() => refresh());
  check((await card(FV2)).includes("15.5 bbl"), `after the knockout volume is entered: "${await card(FV2)}"`);

  console.log("5. Level checks: the sight glass shows a bit less (served), then a bit more (a correction)");
  await page.click(`.card[data-tank="${await tankId(FV2)}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  await page.click("#bv-level");
  await page.waitForSelector("#level-editor[open]");
  check((await text("#level-note")) === "On record: 15.5 bbl.", `before typing: "${await text("#level-note")}"`);
  await page.fill('#level-form [name="reading"]', "15");
  check(await page.isVisible("#level-reason") && (await text("#level-note")).includes("0.5 bbl difference"), `a drop asks what it was: "${await text("#level-note")}"`);
  await page.check('#level-form [name="reason"][value="served"]');
  await page.screenshot({ path: SHOTS + "level-check.png" });
  await page.click("#level-form button[type=submit]");
  await allSent();
  check((await text("#bv-meta")).includes("15 bbl in the tank"), `the tank now shows the reading: "${await text("#bv-meta")}"`);
  const hist = await text("#bv-history");
  check(hist.includes(`0.5 bbl served from ${FV2}`) && hist.includes(`Level check: 15 bbl in ${FV2}`), `history: "${hist.slice(-120)}"`);
  await page.click("#bv-level");
  await page.waitForSelector("#level-editor[open]");
  await page.fill('#level-form [name="reading"]', "15.25");
  check(await page.isHidden("#level-reason") && (await text("#level-note")).includes("noted as a correction"), "a rise is a correction (no question asked)");
  await page.click("#level-form button[type=submit]");
  await allSent();
  check(await page.evaluate((id) => tankBalance(id, viewingBatch().tankId), second) === 15.25, "the tank holds 15.25 bbl");
  await page.screenshot({ path: SHOTS + "volumes.png" });
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
