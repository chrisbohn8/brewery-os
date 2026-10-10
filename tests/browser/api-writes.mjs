// API writes (docs/api-writes-design.md): a key does what the app does, by name, through the app's
// own actions: starts a batch, logs an addition, changes its stage, transfers it, checks its level,
// packages it, sells and counts the kegs, logs an acid cycle, receives malt, plans a brew, changes a
// beer's menu, and sets a draft line. Each write is stamped with the key ("via ...") and listed in
// the key's activity; retries save once; a narrower key is refused; bad input gets a clear answer.
// Real Chrome (Settings, and what the app shows) and plain requests. Makes its own records and removes them.
import { chromium } from "playwright-core";
import { settings, onDialog } from "./helpers.mjs";

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
const enc = encodeURIComponent;

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
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

let made = null, beerWas = null;
try {
  console.log("Setup: sign in, a key, two empty tanks, a taproom, and a raw material");
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
  made = await page.evaluate(async (run) => {
    const loc = data.locations[0];
    const fv = (await must(db.from("tanks").insert({ brewery_id: brewery.id, name: `API FV ${run}`, type: "fermenter", capacity_bbl: 15, location_id: loc.id }).select("id").single())).id;
    const bt = (await must(db.from("tanks").insert({ brewery_id: brewery.id, name: `API BT ${run}`, type: "brite", capacity_bbl: 15, location_id: loc.id }).select("id").single())).id;
    const tap = (await must(db.from("stock_places").insert({ brewery_id: brewery.id, location_id: loc.id, name: `API taproom ${run}`, kind: "taproom" }).select("id").single())).id;
    const item = (await must(db.from("raw_items").insert({ brewery_id: brewery.id, name: `API malt ${run}`, kind: "malt", unit: "lb" }).select("id").single())).id;
    await refresh();
    const beer = data.beers[0];
    return { fv, bt, tap, item, location: loc.name, beer: beer.name, beerId: beer.id };
  }, run);
  beerWas = await page.evaluate(async (id) => (await db.from("beers").select("menu_short").eq("id", id).single()).data, made.beerId);
  const key = await makeKey(`Writer ${run}`);
  const batch = `A${run}`;

  console.log("1. A batch's whole life, through the API");
  const startId = crypto.randomUUID();
  let r = await call(key, "POST", "/batches", { id: startId, number: batch, beer: made.beer, tank: `API FV ${run}`, size_bbl: 15, volume_bbl: 14.5 });
  check(r.status === 201 && r.json.stage === "fermenting", `start #${batch} in API FV ${run} (${r.status}: ${JSON.stringify(r.json)})`);
  r = await call(key, "POST", "/batches", { id: startId, number: batch, beer: made.beer, tank: `API FV ${run}`, size_bbl: 15, volume_bbl: 14.5 });
  check(r.status === 201, "sending it again (a retry) is fine");
  r = await call(key, "POST", `/batches/${batch}/additions`, { name: "Citra", amount: 10, unit: "lb", timing: "Dry hop", lot: `CIT-${run}` });
  check(r.status === 201, `an addition, with its lot (${r.status})`);
  r = await call(key, "POST", `/batches/${batch}/log`, { action: "Check", gravity_plato: 3.1, temp_f: 66 });
  check(r.status === 201, "cellar work");
  r = await call(key, "POST", `/batches/${batch}/stage`, { stage: "conditioning" });
  check(r.status === 201 && r.json.stage === "conditioning", `a new stage (${JSON.stringify(r.json)})`);
  r = await call(key, "POST", `/batches/${batch}/stage`, { stage: "carbonating", tank: `API BT ${run}`, volume_bbl: 14 });
  check(r.status === 201 && r.json.tank === `API BT ${run}`, `a transfer to API BT ${run}, 14 bbl (${JSON.stringify(r.json)})`);
  r = await call(key, "POST", `/batches/${batch}/level`, { volume_bbl: 13.8 });
  check(r.status === 201, "a level check");
  r = await call(key, "POST", `/batches/${batch}/package`, { counts: [{ package: "½ bbl keg", count: 20 }, { package: "⅙ bbl keg", count: 12 }], spent: true, place: `${made.location} Storage` });
  check(r.status === 201, `packaged into ${made.location} Storage, tank spent (${r.status}: ${JSON.stringify(r.json)})`);
  const after = await call(key, "GET", `/batches/${batch}`);
  check(after.json?.stage === "packaged", `the batch is packaged (${after.json?.stage})`);

  console.log("2. Finished goods, raw materials, the plan, the menu");
  r = await call(key, "POST", "/stock/moves", { from: `${made.location} Storage`, to: `API taproom ${run}`, lines: [{ beer: made.beer, package: "½ bbl keg", count: 2 }] });
  check(r.status === 201, `two kegs moved to the taproom (${r.status}: ${JSON.stringify(r.json)})`);
  r = await call(key, "POST", "/stock/moves", { from: `${made.location} Storage`, removal: "sold", account: `Test account ${run}`, lines: [{ beer: made.beer, package: "½ bbl keg", count: 3 }] });
  check(r.status === 201, "three sold to an account");
  r = await call(key, "POST", "/stock/counts", { place: `API taproom ${run}`, counts: [{ beer: made.beer, package: "½ bbl keg", count: 1 }], shortfall: "taproom", notes: "Weekly count" });
  check(r.status === 201, "a count of the taproom");
  r = await call(key, "POST", `/tanks/${enc(`API FV ${run}`)}/acid`, { note: "after the API test" });
  check(r.status === 201, "an acid cycle");
  r = await call(key, "POST", "/raw/receipts", { item: `API malt ${run}`, lot: `M-${run}`, amount: 550, supplier: "Test supplier" });
  check(r.status === 201, "a malt delivery, by lot");
  r = await call(key, "POST", "/plan", { kind: "brew", date: "2030-01-15", tank: `API FV ${run}`, beer: made.beer, notes: `planned by the API ${run}` });
  check(r.status === 201, "a planned brew day");
  r = await call(key, "PATCH", `/beers/${enc(made.beer)}`, { menu: { short: `From the API ${run}` } });
  check(r.status === 200, `the beer's short menu line (${r.status}: ${JSON.stringify(r.json)})`);
  r = await call(key, "PUT", `/lines/${enc(`API taproom ${run}`)}/1`, { beer: made.beer });
  check(r.status === 200 && r.json.pours === made.beer, `draft line 1 pours ${made.beer}`);

  console.log("3. Clear answers to mistakes");
  r = await call(key, "POST", `/batches/${batch}/stage`, { stage: "lagering" });
  check(r.status === 400 && /stage is one of/.test(r.json.error), `a stage that doesn't exist: ${r.status} "${r.json.error}"`);
  r = await call(key, "POST", "/stock/moves", { from: `${made.location} Storage`, removal: "sold", lines: [{ beer: "No such beer", package: "½ bbl keg", count: 1 }] });
  check(r.status === 404 && /No beer "No such beer"/.test(r.json.error), `a beer that isn't here: ${r.status} "${r.json.error}"`);
  r = await call(key, "POST", "/plan", { kind: "brew", date: "next Tuesday" });
  check(r.status === 400 && /Dates are written like/.test(r.json.error), `a date it can't read: ${r.status}`);
  const narrow = await makeKey(`Logger ${run}`, ["cellar_log"]);
  r = await call(narrow, "POST", "/stock/moves", { from: `${made.location} Storage`, removal: "sold", lines: [{ beer: made.beer, package: "½ bbl keg", count: 1 }] });
  check(r.status === 403, `a key that may only log cellar work can't sell kegs (${r.status}: ${r.json?.error})`);

  console.log("4. Attributed and listed");
  await page.evaluate(() => refresh());
  const stamped = await page.evaluate((keyName) => {
    const keyId = Object.entries(data.keyNames).find(([, n]) => n === keyName)?.[0];
    const b = data.batches.find((x) => x.batchNumber === keyName.replace("Writer ", "A"));
    const all = (list) => list.length > 0 && list.every((x) => x.viaKey === keyId);
    return {
      events: all(data.events.filter((e) => e.batchId === b?.id)),
      movements: all(data.movements.filter((m) => m.batchId === b?.id)),
      additions: all(data.additions.filter((a) => a.batchId === b?.id)),
      stock: all(data.stockMoves.filter((m) => m.batchId === b?.id)),
      batchId: b?.id,
    };
  }, `Writer ${run}`);
  check(!!stamped.batchId && stamped.events && stamped.movements && stamped.additions && stamped.stock, `every record it made is stamped with the key (${JSON.stringify(stamped)})`);
  await page.evaluate((id) => openBatchView(id), stamped.batchId);
  await page.waitForSelector("#batch-view:not([hidden])");
  check((await page.textContent("#bv-history")).includes(`via Writer ${run}`) && (await page.textContent("#bv-additions")).includes(`via Writer ${run}`),
    "the batch's page shows them as \"via\" the key");
  await settings(page, "api");
  await page.waitForFunction(() => document.querySelectorAll("#key-activity li").length > 5, null, { timeout: 10000 }).catch(() => {});
  const activity = await page.textContent("#key-activity");
  check(activity.includes(`Writer ${run}`) && activity.includes(`Started #${batch}`) && activity.includes("Packaged") && activity.includes("line 1"),
    "Settings → API keys lists what the key did");
  const count = await page.evaluate(() => document.querySelectorAll("#key-activity li").length);
  check(count >= 15, `every write listed (${count})`);
  check(!activity.includes(`Logger ${run}`), "the refused write isn't listed");

  console.log("5. Undo from the activity list");
  const row = (text) => page.evaluate((t) => [...document.querySelectorAll("#key-activity li")].find((li) => li.textContent.includes(t))?.querySelector("[data-undo-action]")?.dataset.undoAction || null, text);
  check(!(await row("Packaged #")), "packaging has no Undo (volumes and stock are corrected the usual way)");
  const addId = await row(`Citra to #${batch}`);
  check(!!addId, "the addition has Undo");
  await page.click(`[data-undo-action="${addId}"]`);
  await page.waitForFunction((id) => !document.querySelector(`[data-undo-action="${id}"]`), addId, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => refresh());
  check(await page.evaluate((n) => !data.additions.some((a) => a.batchId === data.batches.find((b) => b.batchNumber === n)?.id && a.name === "Citra"), batch),
    "undone: the addition is gone");
  check(/undone by brewer1@example.test/.test(await page.textContent("#key-activity")), "and the list says who undid it");
  const beerUndo = await row(`Changed ${made.beer}`);
  await page.click(`[data-undo-action="${beerUndo}"]`);
  await wait(1500);
  check(await page.evaluate(async (id) => (await db.from("beers").select("menu_short").eq("id", id).single()).data.menu_short, made.beerId) === (beerWas?.menu_short ?? ""),
    "undone: the beer's menu line is back to what it was");
  // A change someone made again since: undo won't erase it
  r = await call(key, "PATCH", `/tanks/${enc(`API BT ${run}`)}`, { status: "maintenance" });
  await page.evaluate((id) => db.from("tanks").update({ status: "cleaning" }).eq("id", id), made.bt);
  await settings(page, "account");
  await settings(page, "api");
  await page.waitForFunction((t) => [...document.querySelectorAll("#key-activity li")].some((li) => li.textContent.includes(t)), `API BT ${run} set to maintenance`, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { window.__told = []; const w = window.warn; window.warn = (t, o) => { window.__told.push(t); return w(t, o); }; });
  await page.click(`[data-undo-action="${await row(`API BT ${run} set to maintenance`)}"]`);
  await wait(1500);
  const said = await page.evaluate(() => [...window.__told, document.getElementById("toasts").textContent].join(" "));
  check(/changed since/.test(said) && await page.evaluate(async (id) => (await db.from("tanks").select("status").eq("id", id).single()).data.status, made.bt) === "cleaning",
    "changed since: undo refuses, and the newer status stays");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  if (made) {
    await page.evaluate(async ([made, run, was]) => {
      const batch = data.batches.find((b) => b.batchNumber === `A${run}`);
      await db.from("plan_items").delete().eq("tank_id", made.fv);
      await db.from("draft_lines").delete().eq("place_id", made.tap);
      if (batch) await db.from("batches").delete().eq("id", batch.id);
      await db.from("tank_cleanings").delete().eq("tank_id", made.fv);
      await db.from("tanks").delete().in("id", [made.fv, made.bt]);
      await db.from("stock_places").delete().eq("id", made.tap);
      await db.from("raw_items").delete().eq("id", made.item);
      if (was) await db.from("beers").update(was).eq("id", made.beerId);
      for (const k of data.keyNames ? Object.entries(data.keyNames).filter(([, n]) => n.endsWith(run)).map(([id]) => id) : []) await db.rpc("revoke_api_key", { p_key_id: k });
    }, [made, run, beerWas]).catch((e) => console.log("tidy-up failed:", e.message));
  }
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
