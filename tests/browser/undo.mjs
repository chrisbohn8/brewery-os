// Messages and questions on the page (not the browser's pop-ups), and Undo: a question box answers
// with Enter (yes) and Escape (no); a message shows above an open form; starting a batch or changing
// its stage waits a few seconds with "Undo", which takes it back before it reaches the database,
// and without Undo it's saved. Real Chrome against the local test copy.
import { chromium } from "playwright-core";
import { settings, floor, openBatchForm } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const UNDO = 3; // seconds (the app's usual is 8)
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript((s) => { window.BREWERY_UNDO_SECONDS = s; }, UNDO);
const page = await context.newPage();
const errors = [];
let browserPopups = 0;
page.on("dialog", (d) => { browserPopups++; d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));
const settle = () => page.waitForFunction(() => !busy && !sending && !reloading);
const toastText = () => page.evaluate(() => [...document.querySelectorAll("#toasts .toast-text")].map((t) => t.textContent).join(" | "));

try {
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
  await settle();

  console.log("1. Questions on the page");
  await page.evaluate(() => { window.answer = ask("Delete FV9?", { ok: "Delete", danger: true }); });
  await page.waitForSelector("#ask-dialog[open]");
  check(await page.textContent("#ask-ok") === "Delete" && await page.evaluate(() => document.getElementById("ask-ok").classList.contains("danger")),
    "the box says what OK does, in red for a delete");
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => window.answer) === false, "Escape means no");
  await page.evaluate(() => { window.answer = ask("Go on?"); });
  await page.waitForSelector("#ask-dialog[open]");
  await page.keyboard.press("Enter");
  check(await page.evaluate(() => window.answer) === true, "Enter means yes");
  await page.evaluate(() => { window.answer = ask("Name for this place:", { input: { value: "Storage" } }); });
  await page.waitForSelector("#ask-dialog[open] #ask-input:not([hidden])");
  await page.fill("#ask-input", "Cold room");
  await page.keyboard.press("Enter");
  check(await page.evaluate(() => window.answer) === "Cold room", "a typed answer comes back");
  await page.evaluate(() => { window.answer = ask("Name?", { input: { value: "x" } }); });
  await page.waitForSelector("#ask-dialog[open]");
  await page.click("#ask-cancel");
  check(await page.evaluate(() => window.answer) === null, "Cancel answers nothing");

  console.log("2. A message shows above an open form, and can be closed");
  await settings(page, "equipment");
  await page.click("#add-tank");
  await page.waitForSelector("#tank-editor[open]");
  await page.evaluate(() => warn("Something to read"));
  const onTop = await page.evaluate(() => {
    const t = document.querySelector("#toasts .toast");
    const r = t.getBoundingClientRect();
    return t.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  check(onTop, "the message is on top of the form, not behind it");
  await page.click("#toasts .toast-close");
  check(!(await toastText()).includes("Something to read"), "× closes it");

  console.log("Setup: a tank for this test");
  const TANK = `U-${run}`;
  await page.fill('#tank-form [name="name"]', TANK);
  await page.fill('#tank-form [name="capacityBbl"]', "10");
  await page.click("#tank-form button[type=submit]");
  await settle();
  await floor(page);
  const tankId = await page.evaluate((n) => data.tanks.find((t) => t.name === n).id, TANK);
  const card = `.card[data-tank="${tankId}"]`;
  async function startBatch(number) {
    await openBatchForm(page, card);
    await page.fill('#batch-form [name="batchId"]', number);
    await page.selectOption('#batch-form [name="beerId"]', await page.evaluate(() => data.beers[0].id));
    await page.click("#batch-form button[type=submit]");
  }
  const onServer = (number) => page.evaluate((n) => serverData.batches.find((b) => b.batchNumber === n) || null, number);

  console.log("3. Starting a batch, then Undo");
  await startBatch(`U${run}a`);
  await page.waitForSelector("#toasts .toast button:not(.toast-close)");
  check((await toastText()).startsWith(`Saved: `) && (await page.textContent("#toasts .toast button:not(.toast-close)")) === "Undo",
    `the message offers Undo: "${await toastText()}"`);
  check((await page.textContent(card)).includes(`U${run}a`), "the tank shows the batch right away");
  check(await page.evaluate(() => document.getElementById("offline-banner").hidden), "no 'waiting to send' banner while it can be undone");
  await page.click("#toasts .toast button:not(.toast-close)");
  check(!(await page.textContent(card)).includes(`U${run}a`), "Undo takes it off the tank");
  check((await toastText()).includes("Undone"), "and says so");
  await wait((UNDO + 1) * 1000);
  await page.evaluate(() => refresh());
  check(!(await onServer(`U${run}a`)), "it never reached the database");

  console.log("4. Starting a batch, no Undo: it's saved after the few seconds");
  await startBatch(`U${run}b`);
  await page.waitForSelector("#toasts .toast button:not(.toast-close)");
  check(!(await onServer(`U${run}b`)), "not in the database during the Undo time");
  await page.waitForFunction(() => outbox.length === 0, null, { timeout: (UNDO + 5) * 1000 });
  await settle();
  await page.evaluate(() => refresh());
  const saved = await onServer(`U${run}b`);
  check(saved?.tankId === tankId, "then it's in the database, in the tank");

  console.log("5. A stage change, then Undo");
  const before = saved?.stage;
  await openBatchForm(page, card);
  await page.selectOption('#batch-form [name="stage"]', "conditioning");
  await page.click("#batch-form button[type=submit]");
  await page.waitForSelector("#toasts .toast button:not(.toast-close)");
  await page.click("#toasts .toast:last-child button:not(.toast-close)");
  await wait((UNDO + 1) * 1000);
  await page.evaluate(() => refresh());
  check((await onServer(`U${run}b`))?.stage === before, `the stage stayed ${before} in the database`);
  check(browserPopups === 0, "no browser pop-ups at all");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);

  // Clean up: package the test batch out of the tank
  await openBatchForm(page, card);
  await page.selectOption('#batch-form [name="stage"]', "packaged");
  await page.click("#batch-form button[type=submit]");
  await page.waitForFunction(() => outbox.length === 0, null, { timeout: (UNDO + 5) * 1000 }).catch(() => {});
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
