// The Taproom level and beers' menu details: an admin fills in a beer's menu (description, prices,
// ABV and IBU filled in for them to check), invites a taproom manager, who keeps finished goods and
// the menu but nothing on the brewhouse side (no batches, no raw materials, not the beer itself).
// Real Chrome against the local Supabase test copy (served by the preview server on port 8123).
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { settings, floor, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const ADMIN = "brewer1@example.test"; // admin of "Example Brewing"
const run = Date.now().toString(36).slice(-5);
const TAP = `taproom-${run}@example.test`;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the email service (see supabase/functions/.env), so no real invite is sent
const fakeEmail = createServer((req, res) => {
  req.resume();
  req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"fake"}'));
}).listen(54399);

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const pages = [];
async function person(email) {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  page.errors = [];
  await onDialog(page, (d) => d.accept());
  page.on("pageerror", (e) => page.errors.push(e.message));
  pages.push(page);
  await page.goto(APP);
  await page.waitForSelector("#signin-screen:not([hidden])", { timeout: 20000 });
  const before = new Set(((await (await fetch(`${MAIL}/messages`)).json()).messages || []).map((m) => m.ID));
  await page.fill('#signin-form [name="email"]', email);
  await page.click("#signin-form button[type=submit]");
  await page.waitForSelector("#code-form:not([hidden])");
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    const msg = ((await (await fetch(`${MAIL}/messages`)).json()).messages || []).find((m) => !before.has(m.ID) && (m.To || []).some((t) => t.Address === email));
    if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
    if (!code) await wait(300);
  }
  await page.fill('#code-form [name="code"]', code);
  await page.click("#code-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden]), #setup-screen:not([hidden])", { timeout: 20000 });
  await wait(300);
  return page;
}
const settle = async (p) => { await wait(150); await p.waitForFunction(() => !busy && !reloading); await wait(100); };
const beerOf = (p, id) => p.evaluate((i) => data.beers.find((b) => b.id === i), id);
async function openBeer(p, id) {
  await settings(p, "beers");
  await p.click(`#beer-list [data-beer="${id}"]`);
  await p.waitForSelector("#beer-editor[open]");
}

try {
  console.log("1. The admin fills in a beer's menu details");
  const admin = await person(ADMIN);
  // A beer with a recipe IBU, if there is one (so "Fill in" has something to use)
  const beerId = await admin.evaluate(() => (data.recipes.find((r) => r.ibu != null)?.beerId) || data.beers[0].id);
  await openBeer(admin, beerId);
  check(await admin.isVisible("#beer-menu") && !(await admin.isDisabled('#beer-form [name="name"]')), "the form has an 'On the menu' part, and the beer itself can be changed");
  // (start from no prices: an earlier run may have left some)
  while (await admin.$("#menu-prices .price-row button")) await admin.click("#menu-prices .price-row button");
  await admin.fill('#beer-form [name="menuDescription"]', `Bright and juicy ${run}`);
  await admin.click("#menu-add-price");
  await admin.fill("#menu-prices .price-row:last-child .price-size", "16 oz");
  await admin.fill("#menu-prices .price-row:last-child .price-amount", "7");
  await admin.click("#menu-add-price");
  await admin.fill("#menu-prices .price-row:last-child .price-size", "Flight");
  await admin.fill("#menu-prices .price-row:last-child .price-amount", "12.5");
  await admin.click("#menu-fill");
  const note = await admin.textContent("#menu-fill-note");
  const filledAbv = await admin.inputValue('#beer-form [name="menuAbv"]');
  check(/Check them, then Save|Nothing to fill in/.test(note), `"Fill in" says where the numbers came from: "${note}"`);
  if (!filledAbv) await admin.fill('#beer-form [name="menuAbv"]', "6.2");
  await admin.click("#beer-form button[type=submit]");
  await settle(admin);
  let beer = await beerOf(admin, beerId);
  check(beer.menuDescription === `Bright and juicy ${run}`, "the description saved");
  check(JSON.stringify(beer.menuPrices) === JSON.stringify([{ size: "16 oz", price: 7 }, { size: "Flight", price: 12.5 }]), `the prices saved, in order (${JSON.stringify(beer.menuPrices)})`);
  check(beer.menuAbv === Number(filledAbv || "6.2"), `the ABV saved (${beer.menuAbv})`);

  console.log("2. A price needs a size and an amount");
  await openBeer(admin, beerId);
  await admin.click("#menu-add-price");
  await admin.fill("#menu-prices .price-row:last-child .price-size", "Crowler");
  await admin.click("#beer-form button[type=submit]");
  await wait(400);
  check(await admin.isVisible("#beer-editor[open]") && /Each price needs a size and an amount/.test(await admin.textContent("#toasts")), "half a price isn't saved");
  await admin.click("#menu-prices .price-row:last-child button");
  await admin.click("#beer-editor .cancel");

  console.log("3. The admin invites a taproom manager");
  await settings(admin, "team");
  check(await admin.evaluate(() => [...document.querySelectorAll('#invite-form [name="role"] option')].some((o) => o.value === "taproom" && o.textContent === "Taproom")),
    "Taproom is one of the levels");
  await admin.fill('#invite-form [name="email"]', TAP);
  await admin.selectOption('#invite-form [name="role"]', "taproom");
  await admin.click("#invite-form button[type=submit]");
  await settle(admin);
  check(await admin.evaluate((e) => data.invites.find((i) => i.email === e)?.role, TAP) === "taproom", "invited as Taproom");

  console.log("4. The taproom manager: finished goods and the menu, not the brewhouse");
  const tap = await person(TAP);
  check(await tap.evaluate(() => brewery.role) === "taproom", "joined as Taproom");
  check(JSON.stringify(await tap.evaluate(() => [...brewery.permissions].sort())) === JSON.stringify(["inventory", "menu"]), "can do: finished goods and the menu");
  await floor(tap);
  check(!(await tap.evaluate(() => document.getElementById("tanks").textContent.includes("Tap to start a batch"))), "empty tanks don't offer to start a batch");
  await tap.click("#open-inventory");
  await tap.waitForSelector("#inventory-view:not([hidden])");
  check(await tap.isVisible("#inv-count") && await tap.isVisible("#inv-move"), "can count and move finished goods");
  await tap.click('[data-inv-tab="raw"]');
  await tap.waitForSelector("#inv-raw:not([hidden])");
  check(!(await tap.isVisible("#raw-receive")) && !(await tap.isVisible("#raw-count")) && !(await tap.isVisible("#raw-items-open")), "raw materials: look only (no Receive, Count, or Items)");
  await tap.click('[data-inv-tab="finished"]');
  await openBeer(tap, beerId);
  check(await tap.isDisabled('#beer-form [name="name"]') && await tap.isDisabled('#beer-form [name="targetOg"]'), "the beer itself is locked");
  check(!(await tap.isDisabled('#beer-form [name="menuDescription"]')) && await tap.isVisible("#beer-form button[type=submit]"), "its menu details can be changed and saved");
  await tap.fill('#beer-form [name="menuDescription"]', `Now pouring ${run}`);
  await tap.click("#beer-form button[type=submit]");
  await settle(tap);
  beer = await beerOf(tap, beerId);
  check(beer.menuDescription === `Now pouring ${run}` && beer.menuPrices.length === 2, "the menu change saved (and the prices stayed)");
  const sneaky = await tap.evaluate(async (id) => (await db.from("beers").update({ name: "Renamed" }).eq("id", id)).error?.message, beerId);
  check(/menu details, but not the beer itself/.test(sneaky || ""), `the database refuses a change to the beer itself ("${sneaky}")`);
  const raw = await tap.evaluate(async () => (await db.from("raw_items").insert({ brewery_id: brewery.id, name: "Sneaky hops", kind: "hop", unit: "lb" })).error?.code);
  check(raw === "42501", `the database refuses raw materials (${raw})`);
  await settings(tap, "beers");
  check(!(await tap.isVisible("#add-beer")), "no 'add beer' button");

  console.log("5. The admin removes the taproom manager (tidy up)");
  await admin.reload();
  await admin.waitForSelector("#app-screen:not([hidden])");
  const removed = await admin.evaluate(async (e) => {
    const m = data.members.find((x) => x.email === e);
    return m ? (await db.from("memberships").delete().eq("brewery_id", brewery.id).eq("user_id", m.userId)).error?.message || "ok" : "not found";
  }, TAP);
  check(removed === "ok", `removed (${removed})`);
  check(pages.every((p) => p.errors.length === 0), `no page errors (${pages.flatMap((p) => p.errors).join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
  fakeEmail.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
