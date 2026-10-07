// A newer version of the app: a page left open offers a reload once the published files change,
// and never reloads by itself. Real Chrome, local test copy (the sign-in screen is enough).
import { chromium } from "playwright-core";

const APP = "http://localhost:8123/";
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
// Service workers off here, so the test can stand in for "the server now has a new version"
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(APP);
  await page.waitForFunction(() => loadedVersion !== null, null, { timeout: 20000 });
  console.log("1. Nothing new published: no notice");
  await page.evaluate(() => checkForUpdate());
  check(await page.isHidden("#update-banner"), "no notice");

  console.log("2. A new version is published while the page is open");
  await page.route("**/style.css", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + "\n/* a newer version */\n" });
  });
  await page.evaluate(() => checkForUpdate());
  check(await page.isVisible("#update-banner"), `notice shown: "${(await page.textContent("#update-banner")).trim().replace(/\s+/g, " ")}"`);
  check(await page.evaluate(() => performance.getEntriesByType("navigation").length === 1), "the page didn't reload by itself");

  console.log("3. Tapping Reload loads the new version, and the notice is gone");
  await page.click("#update-reload");
  await page.waitForLoadState("load");
  await page.waitForFunction(() => loadedVersion !== null, null, { timeout: 20000 });
  await page.evaluate(() => checkForUpdate());
  check(await page.isHidden("#update-banner"), "no notice after reloading");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
