// Offline test for Brewery OS in real Chrome, against the local Supabase test copy.
// Serves the app on its own port (8124) so the server can be stopped to simulate "no signal".
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { settings, floor, openBatchForm, onDialog } from "./helpers.mjs";

const PORT = 8124;
const APP = `http://localhost:${PORT}/`;
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const PROJECT = new URL("../../", import.meta.url).pathname;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
const startServer = async () => {
  server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: PROJECT, stdio: "ignore" });
  for (let i = 0; i < 30; i++) { try { await fetch(APP); return; } catch { await wait(200); } }
  throw new Error("server didn't start");
};
const stopServer = async () => { server.kill(); await wait(500); };

await (await import("node:fs/promises")).mkdir(SHOTS, { recursive: true });
await startServer();
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();
const dialogs = [];
await onDialog(page, async (d) => { dialogs.push(d.message()); await d.accept(); });
const screen = () => page.evaluate(() => ["loading-screen", "signin-screen", "setup-screen", "app-screen"].find((id) => !document.getElementById(id).hidden));
const banner = () => page.evaluate(() => { const b = document.getElementById("offline-banner"); return b.hidden ? null : b.textContent; });
const tankCount = () => page.evaluate(() => document.querySelectorAll(".card").length);

try {
  console.log("1. Online: sign in, and the app keeps copies on the device");
  await fetch(`${MAIL}/messages`, { method: "DELETE" }).catch(() => {});
  await page.goto(APP);
  await page.waitForSelector("#signin-screen:not([hidden]), #app-screen:not([hidden])", { timeout: 20000 });
  if ((await screen()) === "signin-screen") {
    await page.fill('#signin-form input[name="email"]', EMAIL);
    await page.click('#signin-form button[type="submit"]');
    await page.waitForSelector("#code-form:not([hidden])");
    let code = null;
    for (let i = 0; i < 30 && !code; i++) {
      const list = await (await fetch(`${MAIL}/messages`)).json();
      const msg = (list.messages || []).find((m) => (m.To || []).some((t) => t.Address === EMAIL));
      if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
      if (!code) await wait(300);
    }
    await page.fill('#code-form input[name="code"]', code);
    await page.click('#code-form button[type="submit"]');
  }
  await page.waitForSelector("#app-screen:not([hidden]) .card", { timeout: 20000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // so the service worker is in charge of the page
  await page.waitForSelector("#app-screen:not([hidden]) .card", { timeout: 20000 });
  const onlineTanks = await tankCount();
  const cached = await page.evaluate(async () => (await (await caches.open("brewery-os-app-v1")).keys()).map((r) => r.url));
  const copy = await page.evaluate(() => JSON.parse(localStorage.getItem("brewery-os.offline-copy")));
  check(cached.length === 10, `the app's 10 files (the guide and the menu board page too) are saved on the device (${cached.length})`);
  check(copy && copy.data.tanks.length === onlineTanks, `the data is saved on the device (${onlineTanks} tanks)`);
  check((await banner()) === null, "no offline banner while online");

  console.log("2. Signal drops while the app is open");
  await context.setOffline(true);
  await wait(500);
  const b2 = await banner();
  check(!!b2 && b2.startsWith("Offline · showing data from"), `banner appears: "${b2}"`);
  // Try to save: tap a full tank, change nothing, press Save
  await openBatchForm(page, ".card >> nth=0");
  await page.click("dialog[open] button[type=submit]");
  await wait(500);
  const b2b = await banner();
  check(!!b2b && b2b.includes("1 change waiting to send"), `saving keeps the change to send later: "${b2b}"`);

  console.log("3. Opening the app with no signal at all (server and database unreachable)");
  await stopServer();
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await page.waitForSelector("#app-screen:not([hidden]) .card", { timeout: 20000 });
  check((await tankCount()) === onlineTanks, `tank board shows from the device copy (${await tankCount()} tanks)`);
  const b3 = await banner();
  check(!!b3 && b3.includes("showing data from"), `banner says how old it is: "${b3}"`);
  await page.screenshot({ path: SHOTS + "offline-board.png" });

  console.log("4. Signal comes back");
  await startServer();
  await context.setOffline(false);
  await page.waitForFunction(() => document.getElementById("offline-banner").hidden, null, { timeout: 15000 });
  check((await banner()) === null, "banner goes away and data reloads");
  check((await screen()) === "app-screen", "still in the app");

  console.log("5. Signing out deletes the device copy");
  await settings(page, "account");
  await page.click("#app-screen .sign-out");
  await page.waitForSelector("#signin-screen:not([hidden])");
  const left = await page.evaluate(() => localStorage.getItem("brewery-os.offline-copy"));
  check(left === null, "the offline copy is deleted");
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await page.waitForSelector("#signin-screen:not([hidden]), #app-screen:not([hidden])", { timeout: 20000 });
  check((await screen()) === "signin-screen", "after signing out, an offline phone shows sign-in, not the old data");
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message);
  await page.screenshot({ path: SHOTS + "crash.png" }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
