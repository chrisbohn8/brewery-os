// Suggest-only API keys (docs/api-writes-design.md, step 2): new keys suggest changes unless told
// otherwise; a suggestion changes nothing until a person approves it on the tank board's To review
// list; approving saves it as that person, still marked "via" the key, dated when it was suggested;
// rejecting sets it aside; a suggestion that couldn't be saved is refused right away (not stored).
// Real Chrome against the local test copy. Removes what it made.
import { chromium } from "playwright-core";
import { settings, floor, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const API = "http://127.0.0.1:54321/functions/v1/api";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (key, method, path, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const errors = [];
await onDialog(page, (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const settle = async () => { await wait(150); await page.waitForFunction(() => !busy && !reloading); await wait(100); };

let batchNumber = null, entries = null;
try {
  console.log("Setup: sign in");
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
  batchNumber = await page.evaluate(() => data.batches.find((b) => isInTank(b))?.batchNumber);
  const countEntries = () => page.evaluate((n) => data.cellar.filter((c) => c.batchId === data.batches.find((b) => b.batchNumber === n).id).length, batchNumber);

  console.log("1. A new key suggests changes unless told otherwise");
  await settings(page, "api");
  check(await page.isChecked('#key-form [name="mode"][value="suggest"]'), "the form starts on \"Suggests changes for a person to approve\"");
  await page.fill('#key-form [name="name"]', `Assistant ${run}`);
  await page.click("#key-form button[type=submit]");
  await page.waitForSelector("#new-key:not([hidden])");
  const key = (await page.textContent("#new-key-value")).trim();
  check((await page.textContent("#key-list")).includes("suggests changes"), "the key list says it suggests changes");

  console.log("2. A suggestion changes nothing until it's approved");
  entries = await countEntries();
  let r = await call(key, "POST", `/batches/${encodeURIComponent(batchNumber)}/log`, { action: "Check", gravity_plato: 2.8, notes: `suggested ${run}` });
  check(r.status === 202 && r.json.suggested && /Logged Check on #/.test(r.json.summary), `202, waiting for review: "${r.json?.summary}"`);
  const firstId = r.json?.id;
  r = await call(key, "POST", "/stock/moves", { from: "Nowhere at all", removal: "sold", lines: [{ beer: "x", package: "x", count: 1 }] });
  check(r.status === 404, `a suggestion that couldn't be saved is refused right away (${r.status}: ${r.json?.error})`);
  r = await call(key, "PATCH", `/tanks/${encodeURIComponent(await page.evaluate(() => data.tanks.find((t) => !batchInTank(t.id) && t.status === "empty").name))}`, { status: "maintenance" });
  check(r.status === 202, "a second suggestion");
  const secondId = r.json?.id;
  await floor(page);
  await page.evaluate(() => refresh());
  check(await countEntries() === entries, "nothing was saved yet");
  check(await page.isVisible("#review-box") && /2 changes to review/.test(await page.textContent("#review-box")), "the tank board: 2 changes to review");
  await page.screenshot({ path: new URL("./shots/review-box.png", import.meta.url).pathname, clip: { x: 0, y: 0, width: 1100, height: 420 } });

  console.log("3. Approve one, reject the other");
  await page.click(`[data-suggestion="${firstId}"] [data-approve]`);
  await page.waitForFunction((id) => !document.querySelector(`[data-suggestion="${id}"]`), firstId, { timeout: 20000 }).catch(() => {});
  await settle();
  check(await countEntries() === entries + 1, "approved: the cellar entry is saved");
  const saved = await page.evaluate((n) => { const b = data.batches.find((x) => x.batchNumber === n); return data.cellar.filter((c) => c.batchId === b.id).find((c) => (c.notes || "").startsWith("suggested")); }, batchNumber);
  const keyId = await page.evaluate((name) => Object.entries(data.keyNames).find(([, n]) => n === name)?.[0], `Assistant ${run}`);
  check(saved?.viaKey === keyId && saved.occurredOn === await page.evaluate(() => today()), "still marked via the key, dated when it was suggested");
  await page.click(`[data-suggestion="${secondId}"] [data-reject]`);
  await settle();
  check(!(await page.isVisible("#review-box")), "rejected: nothing left to review");
  check(await page.evaluate(() => data.tanks.every((t) => t.status !== "maintenance" || t.name.startsWith("FV-M"))), "the rejected change wasn't made");
  await settings(page, "api");
  await page.waitForFunction(() => /approved by/.test(document.getElementById("key-activity").textContent), null, { timeout: 10000 }).catch(() => {});
  const activity = await page.textContent("#key-activity");
  check(/approved by brewer1@example.test/.test(activity) && /rejected by brewer1@example.test/.test(activity), "the activity list says who approved and who rejected");
  r = await call(key, "POST", `/suggestions/${firstId}/approve`, {});
  check(r.status === 401 || r.status === 404, `a key can't approve its own suggestions (${r.status})`);
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await page.evaluate(async (run) => {
    for (const c of data.cellar.filter((x) => (x.notes || "") === `suggested ${run}`)) await db.from("cellar_entries").delete().eq("id", c.id);
    for (const [id, n] of Object.entries(data.keyNames || {})) if (n === `Assistant ${run}`) await db.rpc("revoke_api_key", { p_id: id });
  }, run).catch((e) => console.log("tidy-up failed:", e.message));
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
