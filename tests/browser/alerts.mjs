// Alerts from the records: an admin turns one on and chooses who's emailed; a batch with no
// gravity raises it on the tank board; the server's check emails it once; "I've got it"; logging
// a gravity clears it; quiet hours hold emails. Real Chrome; the server check is called directly
// (the way the scheduled job does) with a stand-in for the email service.
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { settings, floor, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const CHECK = "http://127.0.0.1:54321/functions/v1/alerts";
const EMAIL = "brewer1@example.test";
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sent = [];
const fakeEmail = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => { sent.push(JSON.parse(body || "{}")); res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"fake"}'); });
}).listen(54399);
const serverCheck = async (secret = "local-alerts-secret") =>
  (await fetch(CHECK, { method: "POST", headers: { "x-alerts-secret": secret } })).json().catch(() => null);

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
await onDialog(page, (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);
const allSent = () => page.waitForFunction(() => !busy && !sending && !reloading && outbox.length === 0, null, { timeout: 30000 });
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
  const me = await page.evaluate((e) => data.members.find((m) => m.email === e).userId, EMAIL);

  console.log("0. The server check needs its secret");
  check((await fetch(CHECK, { method: "POST" })).status === 401, "without it: refused");
  await serverCheck(); // catch up on whatever the test brewery already has, so this run's alert is the new one
  sent.length = 0;

  console.log("1. Turn on 'no gravity' after 2 days, emailed to me");
  await settings(page, "alerts");
  const rule = page.locator('[data-alert-kind="no_gravity"]');
  await page.screenshot({ path: new URL("./shots/alerts-settings.png", import.meta.url).pathname, fullPage: true });
  await rule.locator('[data-param="days"]').fill("2");
  await rule.locator(`[data-recipient="${me}"]`).check();
  await page.click("#alerts-form button[type=submit]");
  await allSent();
  check(await page.evaluate(() => data.alertRules.find((r) => r.kind === "no_gravity")?.params.days === 2), "saved");

  console.log("2. A batch brewed 4 days ago with no gravity: an alert on the tank board");
  const tank = `AL-${run}`;
  await settings(page, "equipment");
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', tank);
  await page.click("#tank-form button[type=submit]");
  await page.waitForFunction((n) => data.tanks.some((t) => t.name === n), tank);
  await floor(page);
  const tankId = await page.evaluate((n) => data.tanks.find((t) => t.name === n).id, tank);
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `AL${run}`);
  await page.selectOption('#batch-form [name="beerId"]', await page.evaluate(() => data.beers[0].id));
  const fourDaysAgo = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 4); return toDateString(d); });
  await page.fill('#batch-form [name="brewDate"]', fourDaysAgo);
  await page.fill('#batch-form [name="stageStartDate"]', fourDaysAgo);
  await page.click("#batch-form button[type=submit]");
  await allSent();
  await page.evaluate(() => refreshAlerts());
  await page.evaluate(() => { const d = document.querySelector("#alerts-box details"); if (d) d.open = true; }); // (folded when there are many)
  const board = await text("#alerts-box");
  await page.screenshot({ path: new URL("./shots/alerts-board.png", import.meta.url).pathname });
  check(board?.includes(`#AL${run} in 4 days`), `on the board: "${board?.slice(0, 120)}"`);

  console.log("3. The server's check emails it once, to the chosen person");
  const first = await serverCheck();
  const mail = sent.find((m) => m.text?.includes(`#AL${run}`));
  check(mail && mail.to[0] === EMAIL && mail.subject.startsWith("Example Brewing"), `emailed: "${mail?.subject}" (check: ${JSON.stringify(first)})`);
  const count = sent.length;
  await serverCheck();
  check(sent.length === count, "checking again doesn't email it again");

  console.log("4. I've got it, then logging a gravity clears it");
  const alertId = await page.evaluate((n) => data.alerts.find((a) => a.title.includes(n)).id, `#AL${run}`);
  await page.click(`[data-ack="${alertId}"]`);
  await page.waitForFunction((id) => !document.querySelector(`[data-ack="${id}"]`), alertId);
  check(!(await text("#alerts-box") || "").includes(`#AL${run}`), "acknowledged: off the board");
  const batchId = await page.evaluate((n) => data.batches.find((b) => b.batchNumber === n).id, `AL${run}`);
  await page.evaluate(([b, id]) => db.rpc("log_cellar_entry", { p_id: crypto.randomUUID(), p_brewery_id: brewery.id, p_batch_id: b, p_occurred_on: today(),
    p_action: "Check", p_gravity_sg: 1.02, p_ph: null, p_temp_c: null, p_cellar_change: "", p_notes: "", p_new_stage: null }), [batchId]);
  await serverCheck();
  const resolved = await page.evaluate(async (id) => (await db.from("alerts").select("resolved_at").eq("id", id)).data[0].resolved_at, alertId);
  check(!!resolved, "logging a gravity cleared the alert");

  console.log("5. Quiet hours hold emails until they're over");
  const hour = await page.evaluate(() => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: prefs().timeZone }).format(new Date())));
  await settings(page, "alerts");
  await page.selectOption("#quiet-start", String(hour));
  await page.selectOption("#quiet-end", String((hour + 2) % 24));
  await page.click("#alerts-form button[type=submit]");
  await allSent();
  // A second batch, also with no gravity
  await page.evaluate(async ([t, n, d]) => {
    const tank2 = crypto.randomUUID();
    await db.from("tanks").insert({ id: tank2, brewery_id: brewery.id, name: t });
    await db.rpc("save_batch", { p_id: crypto.randomUUID(), p_brewery_id: brewery.id, p_batch_number: n, p_beer_id: data.beers[0].id, p_brew_date: d,
      p_size_bbl: 10, p_stage: "fermenting", p_stage_started_on: d, p_tank_id: tank2, p_action_date: d });
  }, [`AQ-${run}`, `AQ${run}`, fourDaysAgo]);
  const before = sent.length;
  const quiet = await serverCheck();
  check(sent.length === before && quiet.waiting >= 1, `during quiet hours: nothing sent, ${quiet.waiting} waiting`);
  await settings(page, "alerts");
  await page.selectOption("#quiet-start", "");
  await page.selectOption("#quiet-end", "");
  await page.click("#alerts-form button[type=submit]");
  await allSent();
  await serverCheck();
  check(sent.slice(before).some((m) => m.text?.includes(`#AQ${run}`)), "once they're over, it's sent");

  // Tidy up: nobody emailed by this rule, so other test runs start clean
  await settings(page, "alerts");
  await page.locator('[data-alert-kind="no_gravity"]').locator(`[data-recipient="${me}"]`).uncheck();
  await page.click("#alerts-form button[type=submit]");
  await allSent();
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
  fakeEmail.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
