// "Try the demo" (docs/demo-design.md): a visitor with no email taps it and gets their own demo
// brewery, filled with the demo's records; the demo bar says what it is; API keys, invites, calendar
// links, and fonts are off (on screen and in the database); a visitor can't set up a real brewery;
// coming back on the same device is the same demo; "Start your own brewery" signs out of it; a new
// visit is a new demo. Real Chrome, local test copy. Deletes the demos it made.
import { chromium } from "playwright-core";
import { settings, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
const errors = [];
const asked = [];
await onDialog(page, (d) => { if (d.type() !== "alert") asked.push(d.message()); d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));
// (a new demo opens with its tour, which covers the page: skip it, as a visitor might; tour.mjs tests the tour)
const ready = async () => {
  await page.waitForFunction(() => !busy && !reloading && brewery?.isDemo && data.batches.length > 30, null, { timeout: 60000 });
  await wait(500);
  if (await page.evaluate(() => DemoTour.open)) await page.click('.tour-card [data-tour="skip"]');
};
const made = [];

try {
  console.log("1. The demo link points to it");
  await page.goto(`${APP}#demo`);
  await page.waitForSelector("#signin-screen:not([hidden])", { timeout: 20000 });
  check(await page.isVisible("#try-demo") && await page.evaluate(() => document.getElementById("demo-offer").classList.contains("highlight")),
    "the sign-in screen offers Try the demo (highlighted from the demo link)");

  console.log("2. Try the demo");
  const t0 = Date.now();
  await page.click("#try-demo");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 30000 });
  await ready();
  const first = await page.evaluate(() => ({ id: brewery.id, name: brewery.name, batches: data.batches.length, tanks: data.tanks.length,
    role: brewery.role, ends: brewery.demoEnds, signedIn: document.getElementById("signed-in-as").textContent }));
  made.push(first.id);
  check(first.name === "Demo Brewing Co." && first.tanks === 18 && first.batches > 40 && first.role === "admin",
    `a demo brewery of their own, filled in ${((Date.now() - t0) / 1000).toFixed(1)} s (${first.tanks} tanks, ${first.batches} batches)`);
  check(await page.isVisible("#demo-bar") && (await page.textContent("#demo-ends")).startsWith("on "), `the demo bar: "${(await page.textContent("#demo-bar")).replace(/\s+/g, " ").trim()}"`);
  check(first.signedIn === "Trying the demo (no email)", "My account says it's the demo");
  await page.screenshot({ path: `${SHOTS}demo-visit.png` });

  console.log("3. What's off in a demo");
  await settings(page, "api");
  check(!(await page.isVisible("#key-form")) && await page.isVisible('.settings-page[data-page="api"] .demo-note'), "API keys: off, and it says so");
  await settings(page, "team");
  check(!(await page.isVisible("#invite-form")) && await page.isVisible('.settings-page[data-page="team"] .demo-note'), "no invites, and it says so");
  await settings(page, "menu");
  check(!(await page.isVisible("#font-upload-btn")) && await page.isVisible("#logo-upload-btn") && await page.isVisible("#menu-files .demo-note"), "no font uploads, and it says so (logos work)");
  await settings(page, "account");
  check(!(await page.isVisible("#make-feed")) && await page.isVisible('.settings-page[data-page="account"] .demo-note'), "no calendar links, and it says so");
  const refused = await page.evaluate(async () => ({
    key: (await db.rpc("create_api_key", { p_brewery_id: brewery.id, p_name: "x", p_permissions: ["cellar_log"] })).error?.message,
    real: (await db.rpc("create_brewery", { brewery_name: "A real one" })).error?.code,
  }));
  check(/off in the demo/.test(refused.key || ""), `the database refuses an API key too ("${refused.key}")`);
  check(refused.real === "42501", "a visitor can't set up a real brewery");

  console.log("4. Coming back is the same demo");
  await page.reload();
  await ready();
  const back = await page.evaluate(() => ({ id: brewery.id, batches: data.batches.length }));
  check(back.id === first.id && back.batches === first.batches, "after a reload: the same demo, not filled twice");

  console.log("5. Start your own brewery: leaves the demo");
  await page.evaluate((id) => db.rpc("delete_brewery", { p_brewery_id: id }), first.id); // (tidy up first: the demo can't be reached once left)
  await page.click("#leave-demo");
  await page.waitForSelector("#signin-screen:not([hidden])", { timeout: 20000 });
  check(asked.some((m) => /won't be able to come back/.test(m)), "asked first, saying the demo can't be come back to");
  check(!(await page.isVisible("#demo-bar")) && await page.evaluate(() => !document.body.classList.contains("in-demo")), "signed out, the demo bar gone");

  console.log("6. A new visit is a new demo");
  await page.click("#try-demo");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 30000 });
  await ready();
  const second = await page.evaluate(() => brewery.id);
  made.push(second);
  check(second !== first.id, "a new demo brewery");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}demo-visit-crash.png` }).catch(() => {});
} finally {
  // The demo this visitor still has (the first was deleted above)
  await page.evaluate(async (ids) => { for (const id of ids) await db.rpc("delete_brewery", { p_brewery_id: id }); }, made).catch(() => {});
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
