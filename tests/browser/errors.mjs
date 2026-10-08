// Problem reports: a crash and an unexpected database error are reported (with the screen and the
// brewery); a problem the person can act on ("already used") isn't; with no signal a report waits
// on the phone and goes when the signal is back; the server's check emails new reports to
// ERROR_REPORTS_TO. Real Chrome against the local test copy, with a stand-in for the email service.
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";
import { onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const REST = "http://127.0.0.1:54321/rest/v1";
const CHECK = "http://127.0.0.1:54321/functions/v1/alerts";
const EMAIL = "brewer1@example.test";
const run = Date.now().toString(36).slice(-5);
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sent = [];
const fakeEmail = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => { sent.push(JSON.parse(body || "{}")); res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"fake"}'); });
}).listen(54399);

// The reports can't be read from the app, only with the local copy's service key
const KEY = JSON.parse(execSync("supabase status -o json", { cwd: new URL("../..", import.meta.url).pathname, stdio: ["ignore", "pipe", "ignore"] })).SERVICE_ROLE_KEY;
const reports = async () => (await fetch(`${REST}/error_reports?select=*&message=ilike.*${run}*`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();
async function waitForReports(n) {
  for (let i = 0; i < 40; i++) {
    const r = await reports();
    if (r.length >= n) return r;
    await wait(250);
  }
  return reports();
}

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await onDialog(page, (d) => d.accept());
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
  await page.waitForFunction(() => !busy && !reloading);

  console.log("1. A crash is reported");
  await page.evaluate((r) => setTimeout(() => { throw new Error(`test crash ${r}`); }), run);
  let found = await waitForReports(1);
  const crash = found.find((x) => x.message === `crash: test crash ${run}`);
  check(!!crash, `reported: "${crash?.message}"`);
  check(crash?.screen.includes("app-screen") && crash?.stack.length > 0 && crash?.browser.includes("Chrome"), `with the screen, where in the code, and the browser (${crash?.screen})`);
  check(crash?.brewery_id === await page.evaluate(() => brewery.id) && !!crash?.user_id, "and who, in which brewery");

  console.log("2. An unexpected database error is reported; one the person can act on isn't");
  await page.evaluate((r) => save(() => must(db.rpc(`no_such_function_${r}`))), run);
  await page.evaluate(() => save(() => { throw Object.assign(new Error("duplicate key value"), { code: "23505" }); }));
  found = await waitForReports(2);
  check(found.some((x) => x.message.startsWith("save: [") && x.message.includes(`no_such_function_${run}`)), "the unexpected one is reported, with its code");
  check(!found.some((x) => x.message.includes("duplicate key value")), "\"already used\" isn't (it's not a bug)");

  console.log("3. The same crash again is counted, not repeated");
  await page.evaluate((r) => setTimeout(() => { throw new Error(`test crash ${r}`); }), run);
  await wait(1500);
  found = await reports();
  check(found.filter((x) => x.message === `crash: test crash ${run}`).length === 1 && found.find((x) => x.message === `crash: test crash ${run}`).times === 2,
    "one report, counted twice");

  console.log("4. With no signal, a report waits on the phone");
  await context.setOffline(true);
  await page.evaluate((r) => setTimeout(() => { throw new Error(`offline crash ${r}`); }), run);
  await wait(800);
  check(await page.evaluate(() => readReports().length) === 1, "kept on the phone");
  check(!(await reports()).some((x) => x.message.includes("offline crash")), "not sent yet");
  await context.setOffline(false);
  found = await waitForReports(3);
  check(found.some((x) => x.message === `crash: offline crash ${run}`), "sent once the signal is back");
  await page.waitForFunction(() => readReports().length === 0, null, { timeout: 10000 }).catch(() => {});
  check(await page.evaluate(() => readReports().length) === 0, "and no longer waiting");

  console.log("5. The server's check emails new reports to ERROR_REPORTS_TO");
  const result = await (await fetch(CHECK, { method: "POST", headers: { "x-alerts-secret": "local-alerts-secret" } })).json();
  const email = sent.find((m) => m.subject?.includes("problem report"));
  check(result.problems >= 3 && email?.to?.[0] === "problems@example.test", `emailed ${result.problems} to ${email?.to?.[0]}`);
  check(email?.text.includes(`test crash ${run} (2 times)`) && email.text.includes(EMAIL) && email.text.includes("Example Brewing"),
    "listing each problem, how often, who, and which brewery");
  await fetch(CHECK, { method: "POST", headers: { "x-alerts-secret": "local-alerts-secret" } });
  check(sent.filter((m) => m.subject?.includes("problem report")).length === 1, "each report is emailed once");
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
  fakeEmail.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
