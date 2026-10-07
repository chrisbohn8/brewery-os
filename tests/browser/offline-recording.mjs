// Offline recording: changes made with no signal are kept on the phone, survive closing the app,
// are sent in order when signal returns, and any the database refuses are shown, not lost.
// Real Chrome against the local Supabase test copy. Serves the app on its own port (8125)
// so the server can be stopped to simulate "no signal".
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { settings, floor } from "./helpers.mjs";

const PORT = 8125;
const APP = `http://localhost:${PORT}/`;
const API = "http://127.0.0.1:54321";
const KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"; // the standard local test key
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const PROJECT = new URL("../../", import.meta.url).pathname;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36).slice(-4).toUpperCase(); // unique names for this run

let server;
const startServer = async () => {
  server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: PROJECT, stdio: "ignore" });
  for (let i = 0; i < 30; i++) { try { await fetch(APP); return; } catch { await wait(200); } }
  throw new Error("server didn't start");
};
const stopServer = async () => { server.kill(); await wait(500); };

await mkdir(SHOTS, { recursive: true });
await startServer();
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();
const dialogs = [];
const errors = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));

const banner = () => page.evaluate(() => { const b = document.getElementById("offline-banner"); return b.hidden ? null : b.textContent; });
const tankIdByName = (name) => page.evaluate((n) => data.tanks.find((t) => t.name === n).id, name);
const cardText = async (name) => (await page.locator(`.card[data-tank="${await tankIdByName(name)}"]`).innerText()).replace(/\s*\n+\s*/g, " | ");
const settle = () => page.waitForFunction(() => !busy && !sending);
const waiting = () => page.evaluate(() => outbox.length);

// Fill and save the batch form for a tank card
async function batchForm(tankName, { number, toTank, stage }) {
  await page.click(`.card[data-tank="${await tankIdByName(tankName)}"]`);
  await page.waitForSelector("#batch-editor[open]");
  if (number) {
    await page.fill('#batch-form [name="batchId"]', number);
    const beer = await page.evaluate(() => data.beers[0].id);
    await page.selectOption('#batch-form [name="beerId"]', beer);
    await page.fill('#batch-form [name="sizeBbl"]', "7");
  }
  if (toTank) await page.selectOption('#batch-form [name="tankId"]', await tankIdByName(toTank));
  if (stage) await page.selectOption('#batch-form [name="stage"]', stage);
  await page.click("#batch-form button[type=submit]");
  await settle();
}

async function addTank(name) {
  await settings(page, "equipment");
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', name);
  await page.fill('#tank-form [name="capacityBbl"]', "10");
  await page.click("#tank-form button[type=submit]");
  await settle();
  await floor(page);
}

// The database's own view (as a coworker's phone would see it), via the API
async function api(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  console.log("Setup (online): sign in, add three empty tanks, start a batch in the first");
  await fetch(`${MAIL}/messages`, { method: "DELETE" }).catch(() => {});
  await page.goto(APP);
  await page.waitForSelector("#signin-screen:not([hidden]), #app-screen:not([hidden])", { timeout: 20000 });
  if (await page.isVisible("#signin-screen")) {
    await page.fill('#signin-form [name="email"]', EMAIL);
    await page.click("#signin-form button[type=submit]");
    await page.waitForSelector("#code-form:not([hidden])");
    let code = null;
    for (let i = 0; i < 30 && !code; i++) {
      const list = await (await fetch(`${MAIL}/messages`)).json();
      const msg = (list.messages || []).find((m) => (m.To || []).some((t) => t.Address === EMAIL));
      if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
      if (!code) await wait(300);
    }
    await page.fill('#code-form [name="code"]', code);
    await page.click("#code-form button[type=submit]");
  }
  await page.waitForSelector("#app-screen:not([hidden]) .card", { timeout: 20000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const [A, B, C] = [`OA-${run}`, `OB-${run}`, `OC-${run}`];
  for (const t of [A, B, C]) await addTank(t);
  await batchForm(A, { number: `X${run}` });
  check((await cardText(A)).includes(`#X${run}`), `batch X${run} is in ${A}`);
  const token = await page.evaluate(async () => (await db.auth.getSession()).data.session.access_token);
  const breweryId = await page.evaluate(() => brewery.id);
  const beerId = await page.evaluate(() => data.beers[0].id);

  console.log("1. Signal drops: transfer, log acid, start a new batch — all kept on the phone");
  await context.setOffline(true);
  await wait(300);
  await batchForm(A, { toTank: B });
  check((await cardText(B)).includes(`#X${run}`), `${B} shows the transferred batch right away`);
  check((await cardText(A)).includes("Cleaning"), `${A} shows Cleaning right away`);
  await page.click(`.card[data-tank="${await tankIdByName(A)}"]`); // a cleaning tank opens its settings
  await page.waitForSelector("#tank-editor[open]");
  await page.click("#log-acid");
  await page.waitForSelector("#acid-editor[open]");
  await page.fill('#acid-form [name="note"]', "offline test");
  await page.click("#acid-form button[type=submit]");
  await settle();
  await page.keyboard.press("Escape");
  await batchForm(C, { number: `Y${run}` });
  check((await cardText(C)).includes(`#Y${run}`), `${C} shows the new batch right away`);
  check(await waiting() === 3, `3 changes waiting (${await waiting()})`);
  const b1 = await banner();
  check(!!b1 && b1.includes("3 changes waiting to send"), `banner: "${b1}"`);
  check(!dialogs.some((m) => /needs signal|can't be saved/i.test(m)), "no 'can't save' messages for floor actions");

  console.log("2. Meanwhile a coworker with signal puts a different batch into", C);
  const zBatch = await api("/rest/v1/batches", token, null); // just to confirm the API works
  check(zBatch.status === 200, "coworker can reach the database");
  const z = await api("/rest/v1/rpc/save_batch", token, {
    p_id: crypto.randomUUID(), p_brewery_id: breweryId, p_batch_number: `Z${run}`, p_beer_id: beerId,
    p_brew_date: "2026-10-06", p_size_bbl: 7, p_stage: "fermenting", p_stage_started_on: "2026-10-06",
    p_tank_id: await tankIdByName(C), p_action_date: "2026-10-06",
  });
  check(z.status === 200 || z.status === 204, `coworker's batch Z${run} saved in ${C} (${z.status})`);

  console.log("3. Phone closed and reopened with no signal: the changes are still there");
  await stopServer();
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await page.waitForSelector("#app-screen:not([hidden]) .card", { timeout: 20000 });
  check((await cardText(B)).includes(`#X${run}`), `${B} still shows the transferred batch`);
  check((await cardText(C)).includes(`#Y${run}`), `${C} still shows the new batch`);
  check(await waiting() === 3, "still 3 changes waiting");

  console.log("4. Signal returns: changes go out in order; the conflicting one is refused and shown");
  await startServer();
  await context.setOffline(false);
  await page.waitForFunction(() => outbox.length === 0 && !sending, null, { timeout: 30000 });
  await settle();
  const xNow = await api(`/rest/v1/batch_status?batch_number=eq.X${run}&select=tank_id`, token);
  check(xNow.json?.[0]?.tank_id === await tankIdByName(B), `database: X${run} is in ${B}`);
  const acid = await api(`/rest/v1/tank_cleanings?tank_id=eq.${await tankIdByName(A)}&select=note`, token);
  check(acid.json?.length === 1 && acid.json[0].note === "offline test", `database: acid cycle on ${A} saved once (${acid.json?.length})`);
  const y = await api(`/rest/v1/batches?batch_number=eq.Y${run}&select=id`, token);
  check(y.json?.length === 0, `database: Y${run} was refused (${C} was already taken)`);
  const problems = await page.evaluate(() => document.getElementById("sync-problems").hidden ? null : document.getElementById("sync-problem-list").innerText);
  check(!!problems && problems.includes(`Y${run}`) && problems.includes(`${C} already has`), `on-page note: "${problems}"`);
  check((await cardText(C)).includes(`#Z${run}`), `${C} now shows the coworker's batch (the truth)`);
  check((await banner()) === null, "banner gone");
  await page.screenshot({ path: SHOTS + "sync-problem.png" });
  await page.click("#sync-problems-ok");
  check(await page.isHidden("#sync-problems"), "OK dismisses the note");

  console.log("5. Connection drops in the middle of a save: kept and sent later, not lost");
  await page.route("**/rest/v1/rpc/save_batch", (route) => route.abort("internetdisconnected"));
  await batchForm(B, { stage: "conditioning" });
  check(await waiting() === 1, "the change is kept to send later");
  await page.unroute("**/rest/v1/rpc/save_batch");
  await page.evaluate(() => refresh());
  await settle();
  const xStage = await api(`/rest/v1/batch_status?batch_number=eq.X${run}&select=stage`, token);
  check(xStage.json?.[0]?.stage === "conditioning" && await waiting() === 0, "sent once the connection is back");

  console.log("6. Signing out with changes not yet sent warns first");
  await context.setOffline(true);
  await wait(300);
  await batchForm(B, { stage: "ready" });
  dialogs.length = 0;
  await settings(page, "account");
  await page.click("#app-screen .sign-out");
  await page.waitForSelector("#signin-screen:not([hidden])");
  check(dialogs.some((m) => m.includes("hasn't been sent yet")), `warning: "${dialogs[0]}"`);
  check(await page.evaluate(() => outbox.length === 0 && !localStorage.getItem("brewery-os.offline-copy")), "signing out clears the phone's copy and waiting changes");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
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
