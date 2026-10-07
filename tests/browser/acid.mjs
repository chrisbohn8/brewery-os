// End-to-end test of acid tracking on the local Supabase stack.
import { chromium } from "playwright-core";
import { settings, floor, openBatchForm } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const OUT = new URL("./shots/", import.meta.url).pathname;
const log = (...a) => console.log("•", ...a);
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
});
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push("console: " + m.text()); });
// Dialog answers: accept by default; refuse the acid warning when `refuseAcid` is set
const dialogs = [];
let refuseAcid = false;
page.on("dialog", async (d) => {
  dialogs.push(d.message());
  if (refuseAcid && /due for an acid cycle/.test(d.message())) await d.dismiss();
  else await d.accept();
});
let n = 0;
const shot = async (name) => page.screenshot({ path: `${OUT}acid-${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true });
const settle = () => page.waitForTimeout(900);
const closed = (id) => page.waitForSelector(`#${id}:not([open])`, { state: "attached", timeout: 15000 });

// ---- Sign in ----
await fetch(`${MAIL}/messages`, { method: "DELETE" }).catch(() => {});
await page.goto(APP);
await page.waitForSelector("#signin-screen:not([hidden]), #app-screen:not([hidden])", { timeout: 15000 });
if (await page.isVisible("#signin-screen")) {
  await page.fill('#signin-form input[name="email"]', EMAIL);
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector("#code-form:not([hidden])");
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    const list = await (await fetch(`${MAIL}/messages`)).json();
    const msg = (list.messages || []).find((m) => (m.To || []).some((t) => t.Address === EMAIL));
    if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6,10})\b/)?.[1];
    if (!code) await page.waitForTimeout(500);
  }
  await page.fill('#code-form input[name="code"]', code);
  await page.click('#code-form button[type="submit"]');
}
await page.waitForSelector("#app-screen:not([hidden])", { timeout: 15000 });
await settle();
await settings(page, "cleaning");
check(await page.isVisible("#acid-settings"), "Acid cleaning section shows on the Cleaning settings page");
await floor(page);

const tag = String(Date.now()).slice(-5);
const STYLE = `Gose ${tag}`;

// ---- Helpers ----
async function addTank(name, every) {
  await settings(page, "equipment");
  await page.click("#add-tank");
  await page.waitForSelector("#tank-editor[open]");
  await page.fill('#tank-form input[name="name"]', name);
  if (every) await page.fill('#tank-form input[name="acidEveryTurns"]', String(every));
  await page.click('#tank-form button[type="submit"]');
  await closed("tank-editor"); await settle();
  await floor(page);
  return page.$eval(`#tanks .card:has(.tank:text-is("${name}"))`, (c) => c.dataset.tank);
}
async function addBeer(name, style) {
  await settings(page, "beers");
  await page.click("#add-beer");
  await page.waitForSelector("#beer-editor[open]");
  await page.fill('#beer-form input[name="name"]', name);
  await page.fill('#beer-form input[name="style"]', style);
  await page.click('#beer-form button[type="submit"]');
  await closed("beer-editor"); await settle();
  await floor(page);
  return page.$eval(`#beer-list [data-beer]:has(strong:text-is("${name}"))`, (r) => r.dataset.beer);
}
const card = (id) => `#tanks .card[data-tank="${id}"]`;
const cardText = (id) => page.textContent(card(id));
async function startBatch(tankId, number, beerId) {
  await openBatchForm(page, card(tankId));
  await page.fill('#batch-form input[name="batchId"]', number);
  await page.selectOption('#batch-form select[name="beerId"]', beerId);
  await page.click('#batch-form button[type="submit"]');
  await page.waitForTimeout(1200);
  const open = await page.isVisible("#batch-editor[open]");
  if (open) await page.click("#batch-form .cancel");
  await settle();
  return !open;
}
async function editBatchIn(tankId, changes) {
  await openBatchForm(page, card(tankId));
  for (const [field, value] of Object.entries(changes)) await page.selectOption(`#batch-form select[name="${field}"]`, value);
  await page.click('#batch-form button[type="submit"]');
  await closed("batch-editor"); await settle();
}
async function openTankForm(tankId) {
  // Empty tanks open the batch form; go to the tank form through "Tank settings"
  await openBatchForm(page, card(tankId)); // (lands on the batch form, or the tank form for a cleaning tank)
  if (await page.isVisible("#batch-editor[open]")) await page.click("#open-tank-settings");
  await page.waitForSelector("#tank-editor[open]");
}
async function setEmpty(tankId) {
  await openTankForm(tankId);
  await page.selectOption('#tank-form select[name="status"]', "empty");
  await page.click('#tank-form button[type="submit"]');
  await closed("tank-editor"); await settle();
}

// ---- Setup ----
log("Adding the style", STYLE, "to the acid list");
await settings(page, "cleaning");
await page.fill('#acid-style-form input[name="style"]', STYLE);
await page.click('#acid-style-form button[type="submit"]');
await settle();
check((await page.textContent("#acid-style-list")).includes(STYLE), "style appears on the acid list");
await floor(page);

const X = await addTank(`AC-X${tag}`, 2);
const Y = await addTank(`AC-Y${tag}`);
const Z = await addTank(`AC-Z${tag}`);
const plain = await addBeer(`Plain ${tag}`, "Blonde Ale");
const sour = await addBeer(`Sour ${tag}`, STYLE);
log("Tanks and beers added");

// ---- Turn counting on X (acid every 2 turns) ----
await startBatch(X, `A${tag}`, plain);
await editBatchIn(X, { tankId: Y });                    // turn 1: transfer out
check(!(await cardText(X)).includes("Acid due"), "after 1 of 2 turns, X is not due");
await setEmpty(X);
await startBatch(X, `B${tag}`, plain);
await editBatchIn(X, { stage: "packaged" });            // turn 2: packaged out
check((await cardText(X)).includes("Acid due · 2 of 2 turns"), "after 2 of 2 turns, X shows 'Acid due · 2 of 2 turns'");
await shot("x-due");

// ---- Warning on fill ----
await setEmpty(X);
refuseAcid = true;
const filled = await startBatch(X, `C${tag}`, plain);
refuseAcid = false;
check(dialogs.some((d) => /is due for an acid cycle \(2 of 2 turns\)/.test(d)), "filling a due tank asks first");
check(!filled && !(await cardText(X)).includes(`C${tag}`), "answering 'no' keeps the tank empty");

// ---- Log an acid cycle ----
await openTankForm(X);
check((await page.textContent("#acid-summary")).includes("No acid cycle logged yet · 2 of 2 turns"), "tank form shows turns so far");
await page.click("#log-acid");
await page.waitForSelector("#acid-editor[open]");
await page.fill('#acid-form input[name="note"]', "e2e acid");
await page.click('#acid-form button[type="submit"]');
await closed("acid-editor"); await settle();
const summary = await page.textContent("#acid-summary");
check(/Last acid .* · 0 of 2 turns since/.test(summary), `tank form updates after logging (${summary.trim()})`);
check((await page.textContent("#acid-history")).includes("e2e acid"), "acid log lists the cycle with its note");
await shot("x-logged");
await page.click("#tank-form .cancel");
await settle();
check(!(await cardText(X)).includes("Acid due"), "after logging acid, X is no longer due");

// ---- Style trigger on Z ----
await startBatch(Z, `S${tag}`, sour);
check(!(await cardText(Z)).includes("Acid due"), "a tank with the style still in it isn't flagged yet");
await editBatchIn(Z, { stage: "packaged" });
check((await cardText(Z)).includes(`Acid due · after ${STYLE}`), "after the style leaves, Z shows 'Acid due · after <style>'");

// ---- Removing a logged cycle brings the flag back ----
await openTankForm(X);
await page.click("#acid-history [data-remove-acid]");
await settle();
check((await page.textContent("#acid-summary")).includes("No acid cycle logged yet"), "removing the cycle updates the form");
await page.click("#tank-form .cancel");
await settle();
check((await cardText(X)).includes("Acid due"), "and X is due again");

// ---- Clean up the test style ----
await settings(page, "cleaning");
await page.click(`#acid-style-list li:has-text("${STYLE}") [data-remove-style]`); // this run's style, not a leftover
await settle();
check(!(await page.textContent("#acid-style-list")).includes(STYLE), "style can be removed from the list");
await shot("end");

console.log("\nErrors:", errors.length ? errors : "none");
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
await browser.close();
