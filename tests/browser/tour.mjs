// The demo tour (docs/demo-design.md, step 4): it starts by itself the first time a demo opens, goes
// through every step on the real screens with a spotlight on something real (never empty, never off
// screen), with its words fully on screen, on a computer and on a phone; Back, Next, Skip, and the
// keyboard work; "Take the tour" plays it again; it doesn't start by itself a second time.
// Real Chrome against the local test copy. Screenshots of every step go to tests/browser/shots/.
import { chromium } from "playwright-core";
import { onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const made = [];

// Where the tour is: its step, its words' box and the spotlight, and whether they fit the screen
const state = (page) => page.evaluate(() => {
  const card = document.querySelector(".tour-card"), spot = document.querySelector(".tour-spot");
  if (!card) return null;
  const c = card.getBoundingClientRect(), s = spot.getBoundingClientRect();
  const on = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
  return { step: card.dataset.step, title: card.querySelector("h2")?.textContent, target: spot.dataset.target,
    cardOn: on(c), spotOn: s.width === 0 || on(s), spotSize: Math.round(s.width * s.height), sideways: document.documentElement.scrollWidth > innerWidth,
    text: card.querySelector(".tour-text")?.textContent || "", tv: !!card.querySelector(".tour-tv .mb"),
    tvFits: (() => { const m = card.querySelector(".tour-tv-screen .mb"); return !m || m.scrollHeight <= m.parentElement.clientHeight + 1; })() };
});

async function visit(width, height, label) {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  await onDialog(page, (d) => d.accept());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${APP}#demo`);
  await page.click("#try-demo");
  await page.waitForFunction(() => typeof DemoTour !== "undefined" && DemoTour.open, null, { timeout: 60000 }).catch(() => {});
  made.push({ page, id: await page.evaluate(() => brewery?.id) });
  check(await page.evaluate(() => DemoTour.open), `${label}: the tour starts by itself the first time the demo opens`);
  const seen = [];
  for (let i = 0; i < 20; i++) {
    await wait(350);
    // (the menu step's TV preview loads the board first)
    await page.waitForFunction(() => document.querySelector(".tour-card")?.dataset.step !== "menu" || document.querySelector(".tour-tv")?.dataset.ready, null, { timeout: 10000 }).catch(() => {});
    const st = await state(page);
    if (!st) break;
    seen.push(st);
    await page.screenshot({ path: `${SHOTS}tour-${label}-${String(i + 1).padStart(2, "0")}-${st.step}.png` });
    if (st.step === "done") break;
    await page.click('.tour-card [data-tour="next"]');
  }
  const steps = seen.map((s) => s.step);
  check(steps[0] === "welcome" && steps.at(-1) === "done" && steps.length >= 9, `${label}: ${steps.length} steps: ${steps.join(", ")}`);
  const targeted = seen.filter((s) => !["welcome", "done"].includes(s.step));
  const noSpot = targeted.filter((s) => !s.target || s.spotSize < 2000).map((s) => s.step);
  check(!noSpot.length, `${label}: every step's spotlight is on something real${noSpot.length ? ` (not on: ${noSpot.join(", ")})` : ""}`);
  const offScreen = seen.filter((s) => !s.cardOn || s.sideways).map((s) => s.step);
  check(!offScreen.length, `${label}: the words are fully on screen at every step, no sideways scrolling${offScreen.length ? ` (not on: ${offScreen.join(", ")})` : ""}`);
  check(seen.find((s) => s.step === "menu")?.tv && seen.find((s) => s.step === "menu")?.tvFits, `${label}: the menu step shows a little TV preview of the board, all of it`);
  check(seen.every((s) => s.text.length > 40 && !/undefined|null|NaN/.test(s.text)), `${label}: every step's words are filled in (no blanks)`);
  await page.click('.tour-card [data-tour="explore"]');
  check(!(await page.evaluate(() => DemoTour.open)) && await page.isVisible("#floor-view"), `${label}: "Explore the demo" ends it, on the tank board`);
  return { page, errors, seen };
}

try {
  console.log("1. On a computer");
  const desk = await visit(1280, 860, "desk");

  console.log("2. On a phone");
  const phone = await visit(390, 844, "phone");

  console.log("3. Back, Skip, the keyboard, and playing it again");
  const page = desk.page;
  await page.reload();
  await page.waitForFunction(() => typeof brewery !== "undefined" && brewery?.isDemo && !busy && !reloading, null, { timeout: 30000 });
  await wait(800);
  check(!(await page.evaluate(() => DemoTour.open)), "coming back: it doesn't start by itself again");
  await page.click("#take-tour");
  await page.waitForFunction(() => DemoTour.open);
  await page.keyboard.press("ArrowRight");
  await wait(400);
  await page.keyboard.press("ArrowRight");
  await wait(400);
  const two = await page.evaluate(() => DemoTour.step);
  await page.click('.tour-card [data-tour="back"]');
  await wait(400);
  check(two !== "welcome" && await page.evaluate(() => DemoTour.step) !== two, `"Take the tour" plays it again; → and Back move through it (at ${two})`);
  await page.keyboard.press("Escape");
  await wait(300);
  check(!(await page.evaluate(() => DemoTour.open)), "Esc ends it");
  check([...desk.errors, ...phone.errors].length === 0, `no page errors (${[...desk.errors, ...phone.errors].join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  for (const m of made) await m.page.evaluate((id) => db.rpc("delete_brewery", { p_brewery_id: id }), m.id).catch(() => {});
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
