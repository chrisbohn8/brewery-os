// The API (Phase 6½): a key made in Settings works from outside the app, as its maker, through
// the same database rules; a narrower key can do less; a revoked key stops working; retries are safe.
// Real Chrome for the Settings part, then plain requests like an AI agent would make. Local test copy.
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
  const res = await fetch(`${API}${path}`, { method, headers: { ...(key && { Authorization: `Bearer ${key}` }), "Content-Type": "application/json" },
    body: body && JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
await onDialog(page, (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
async function makeKey(name, only, mode = "direct") {
  await settings(page, "api");
  await page.fill('#key-form [name="name"]', name);
  await page.check(`#key-form [name="mode"][value="${mode}"]`); // (new keys suggest changes unless told otherwise)
  if (only) await page.evaluate((keep) => document.querySelectorAll("#key-permissions input").forEach((i) => { i.checked = keep.includes(i.value); }), only);
  await page.click("#key-form button[type=submit]");
  await page.waitForSelector("#new-key:not([hidden])");
  return (await page.textContent("#new-key-value")).trim();
}

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

  console.log("1. Make a key in Settings → API keys");
  const key = await makeKey(`Agent ${run}`);
  check(key.startsWith("bos_") && key.length === 52, "the key is shown once");
  check((await page.textContent("#key-list")).includes(`Agent ${run}`), "and listed (by name and its first characters)");

  console.log("2. Use it like an AI agent would");
  check((await call(null, "GET", "/me")).status === 401, "no key: refused");
  const me = await call(key, "GET", "/me");
  check(me.status === 200 && me.json.brewery === "Example Brewing" && me.json.signed_in_as === EMAIL, `me: ${me.json?.brewery} as ${me.json?.signed_in_as}`);
  const tanks = await call(key, "GET", "/tanks");
  const full = tanks.json.find((t) => t.batch), empty = tanks.json.find((t) => !t.batch && t.status === "empty");
  check(tanks.status === 200 && full && full.batch.beer, `tanks: ${tanks.json.length}, e.g. ${full?.name} has ${full?.batch?.beer} (${full?.batch?.stage})`);
  const one = await call(key, "GET", `/tanks/${encodeURIComponent(full.name)}`);
  check(one.status === 200 && one.json.id === full.id, "a tank by its name");
  const cleaned = await call(key, "PATCH", `/tanks/${encodeURIComponent(empty.name)}`, { status: "cleaning" });
  check(cleaned.status === 200 && cleaned.json.status === "cleaning", `set ${empty.name} to cleaning`);
  await call(key, "PATCH", `/tanks/${encodeURIComponent(empty.name)}`, { status: "empty" });

  const number = full.batch.number;
  const entryId = crypto.randomUUID();
  const logged = await call(key, "POST", `/batches/${encodeURIComponent(number)}/log`, { id: entryId, action: "Check", gravity_plato: 4.2, temp_f: 64, notes: `from the API ${run}` });
  check(logged.status === 201, `logged a reading on #${number}`);
  await call(key, "POST", `/batches/${encodeURIComponent(number)}/log`, { id: entryId, action: "Check", gravity_plato: 4.2, temp_f: 64, notes: `from the API ${run}` });
  const batch = await call(key, "GET", `/batches/${encodeURIComponent(number)}`);
  const mine = batch.json.log.filter((e) => e.notes === `from the API ${run}`);
  check(mine.length === 1, "sending the same entry twice (a retry) saves it once");
  check(Math.abs(mine[0].gravity.plato - 4.2) < 0.05 && Math.abs(mine[0].temperature.f - 64) < 0.05, `stored and returned in both units: ${JSON.stringify(mine[0].gravity)} ${JSON.stringify(mine[0].temperature)}`);
  const beers = await call(key, "GET", "/beers");
  check(beers.status === 200 && beers.json.length > 0 && "ingredients" in beers.json[0] && Array.isArray(beers.json[0].recipes), `beers: ${beers.json.length}, with targets, recipes, and ingredients`);
  const menu = beers.json[0]?.menu || {};
  check(["short", "section", "tags", "fields", "prices", "on_public_menu"].every((k) => k in menu) && menu.prices.every((p) => typeof p.size === "string" && Array.isArray(p.at_taprooms)),
    `each beer's menu reads by name (${JSON.stringify(menu.prices)})`);
  check((await call(key, "GET", "/inventory")).status === 200, "inventory");
  check((await call(key, "GET", "/nowhere")).status === 404, "an unknown address says so");

  console.log("3. A narrower key can do less, and a revoked key stops working");
  const narrow = await makeKey(`Logger ${run}`, ["cellar_log"]);
  check(JSON.stringify(await page.evaluate((n) => apiKeys.find((k) => k.name === n)?.permissions, `Logger ${run}`)) === JSON.stringify(["cellar_log"]),
    "the key was made with only the ticked permission");
  const refused = await call(narrow, "PATCH", `/tanks/${encodeURIComponent(empty.name)}`, { status: "cleaning" });
  check(refused.status === 403 || refused.status === 404, `a key without "tank status" can't change a tank (${refused.status})`);
  check((await call(narrow, "POST", `/batches/${encodeURIComponent(number)}/log`, { notes: `narrow ${run}` })).status === 201, "but it can log cellar work");
  check(JSON.stringify((await call(narrow, "GET", "/me")).json.permissions) === JSON.stringify(["cellar_log"]), "and /me says what it may do");
  const id = await page.evaluate((n) => apiKeys.find((k) => k.name === n).id, `Logger ${run}`);
  await page.click(`[data-revoke-key="${id}"]`);
  await page.waitForFunction((k) => apiKeys.find((x) => x.id === k)?.revoked_at, id);
  check((await call(narrow, "GET", "/me")).status === 401, "a revoked key is refused");
  await page.click(`[data-revoke-key="${await page.evaluate((n) => apiKeys.find((k) => k.name === n).id, `Agent ${run}`)}"]`); // tidy up
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
