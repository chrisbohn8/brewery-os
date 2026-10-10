// The demo brewery (docs/demo-design.md, demo.js): made for today, loaded in one step through the
// database's usual rules, and every part of the app has something real on it: tanks in every
// stage, one-, two-, and three-turn batches, a split and a blend, volumes that add up, finished
// goods that never go below zero, raw materials by lot, the calendar, alerts, menus and boards.
// Also: the same brewery for every day of the week (brew days line up differently each day).
// Loads into the second test brewery (empty), then empties it again. Real Chrome, local test copy.
import { chromium } from "playwright-core";
import { onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
const told = [];
await onDialog(page, (d) => { told.push(d.message()); d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));

// Empty a brewery (deleting batches takes their history with them)
const empty = () => page.evaluate(async () => {
  const b = brewery.id;
  for (const table of ["plan_items", "menu_boards", "stock_moves", "batches", "tanks", "beers", "stock_places", "raw_items", "brewery_files", "inventory_views", "locations"]) {
    await must(db.from(table).delete().eq("brewery_id", b));
  }
  await must(db.from("breweries").update({ menu_sizes: [], menu_sections: [], menu_tags: [], menu_fields: [] }).eq("id", b));
  await refresh();
});

try {
  console.log("1. The generator, for each day of the week");
  await page.goto(APP);
  const week = await page.evaluate(() => Array.from({ length: 7 }, (_, i) => {
    const day = addDays(today(), i);
    const d = DemoBrewery.make(day);
    const now = {};
    for (const e of d.events) now[e.batchId] = e;
    const inTanks = Object.values(now).filter((e) => e.tankId);
    const perTank = {};
    for (const e of inTanks) perTank[e.tankId] = (perTank[e.tankId] || 0) + 1;
    const stock = {};
    let negative = 0;
    for (const m of d.stockMoves) {
      const k = (p) => [p, m.beerId, m.batchId, m.packageTypeId].join("|");
      if (m.toPlaceId) stock[k(m.toPlaceId)] = (stock[k(m.toPlaceId)] || 0) + m.count;
      if (m.fromPlaceId && (stock[k(m.fromPlaceId)] = (stock[k(m.fromPlaceId)] || 0) - m.count) < 0) negative++;
    }
    return { day, stages: new Set(inTanks.map((e) => e.stage)).size, doubled: Object.values(perTank).some((n) => n > 1), negative,
      turns: [1, 2, 3].every((t) => d.batches.some((b) => b.turns === t)), split: d.batches.some((b) => /-2$/.test(b.batchNumber)),
      blend: d.batches.some((b) => b.batchNumber.includes("/")), same: JSON.stringify(DemoBrewery.make(day)) === JSON.stringify(d),
      // a batch fermenting or dry hopping with no gravity for 3+ days (the "no gravity logged" alert)
      quiet: inTanks.some((e) => ["fermenting", "dry-hopping"].includes(e.stage) && (d.cellar.filter((c) => c.batchId === e.batchId && c.gravitySg != null)
        .map((c) => c.occurredOn).sort().at(-1) || "") <= addDays(day, -3)) };
  }));
  const bad = week.filter((w) => w.stages < 3 || w.doubled || w.negative || !w.turns || !w.split || !w.blend || !w.same || !w.quiet);
  check(!bad.length, `every day of the week: 3+ stages in the tanks, one batch per tank, stock never below zero, 1-, 2-, and 3-turn batches, a split and a blend, a batch with no gravity lately, the same each time${bad.length ? ` (not on ${bad.map((w) => JSON.stringify(w)).join("; ")})` : ""}`);

  console.log("2. Load today's demo into an empty brewery");
  const before = new Set(((await (await fetch(`${MAIL}/messages`)).json()).messages || []).map((m) => m.ID));
  await page.fill('#signin-form [name="email"]', "brewer2@example.test");
  await page.click("#signin-form button[type=submit]");
  await page.waitForSelector("#code-form:not([hidden])");
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    const msg = ((await (await fetch(`${MAIL}/messages`)).json()).messages || []).find((m) => !before.has(m.ID) && m.To.some((t) => t.Address === "brewer2@example.test"));
    if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
    if (!code) await wait(300);
  }
  await page.fill('#code-form [name="code"]', code);
  await page.click("#code-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 20000 });
  await page.waitForFunction(() => !busy && !reloading && brewery?.id && data);
  if (await page.evaluate(() => brewery.name) !== "Second Brewing") {
    await page.evaluate(() => { const s = document.getElementById("brewery-switch"); s.value = [...s.options].find((o) => o.text === "Second Brewing").value; s.dispatchEvent(new Event("change")); });
    await page.waitForFunction(() => brewery.name === "Second Brewing" && !busy && !reloading);
  }
  await empty();
  check(await page.evaluate(() => isEmptyBrewery()), "the brewery starts empty");
  const made = await page.evaluate(() => { const d = DemoBrewery.make(today()); return { batches: d.batches.length, tanks: d.tanks.length, kb: Math.round(JSON.stringify(d).length / 1024) }; });
  const t0 = Date.now();
  await page.evaluate(() => loadIntoBrewery(DemoBrewery.make(today()), "the demo"));
  await page.evaluate(() => refresh());
  const seconds = (Date.now() - t0) / 1000;
  const problem = told.find((m) => /Nothing was loaded|Couldn't/.test(m));
  check(!problem && await page.evaluate((n) => data.batches.length === n, made.batches),
    `loaded in one step (${made.kb} KB, ${made.batches} batches, ${seconds.toFixed(1)} s)${problem ? `: ${problem}` : ""}`);

  console.log("3. Everything adds up");
  const facts = await page.evaluate(() => {
    const inTanks = data.tanks.map((t) => batchInTank(t.id)).filter(Boolean);
    const volumes = inTanks.map((b) => tankBalance(b.id, b.tankId));
    const lots = data.rawItems.flatMap((i) => rawLots(i));
    return {
      tanks: data.tanks.length, locations: data.locations.length, inTanks: inTanks.length,
      stages: [...new Set(inTanks.map((b) => b.stage))], volumesOk: volumes.every((v) => v != null && v > 0),
      volumes: volumes.map((v) => +(v ?? -1).toFixed(1)),
      stockNegative: stockOnHand().filter((h) => h.count < 0).length, onHand: stockOnHand().length,
      lotsNegative: lots.filter((l) => l.onHand < -0.001).map((l) => `${l.lot}:${l.onHand.toFixed(1)}`),
      lots: lots.length, low: data.rawItems.filter((i) => i.reorderLevel != null && rawLots(i).reduce((s, l) => s + l.onHand, 0) < i.reorderLevel).map((i) => i.name),
      threeTurns: data.batches.some((b) => b.turns === 3 && data.readings.filter((r) => r.batchId === b.id && r.fieldKey === "ko_gravity").length === 3),
      split: data.batches.some((b) => /-2$/.test(b.batchNumber)), blend: data.batches.some((b) => b.batchNumber.includes("/")),
      alerts: (data.alerts || []).filter((a) => !a.acknowledgedAt).map((a) => a.kind),
      plans: data.planItems.length, recipes: data.recipes.length, lines: data.lines.length, boards: (data.boards || []).length,
      views: data.views.length, pars: data.pars.length, cleanings: data.cleanings.length,
    };
  });
  check(facts.tanks === 18 && facts.locations === 2, `two locations, 18 tanks (${facts.locations}, ${facts.tanks})`);
  check(facts.stages.length >= 4, `beer in ${facts.stages.length} stages: ${facts.stages.join(", ")}`);
  check(facts.volumesOk, `every tank's volume is worked out and above zero (${facts.volumes.join(", ")})`);
  check(facts.stockNegative === 0 && facts.onHand > 10, `finished goods on hand, none below zero (${facts.onHand} lines)`);
  check(!facts.lotsNegative.length && facts.lots > 20, `raw materials by lot, none used beyond what was received (${facts.lots} lots${facts.lotsNegative.length ? `; below zero: ${facts.lotsNegative.join(", ")}` : ""})`);
  check(facts.low.length > 0, `something is low on raw materials (${facts.low.join(", ")})`);
  check(facts.threeTurns && facts.split && facts.blend, `a three-turn batch with a sheet for each turn (${facts.threeTurns}), a split (${facts.split}), and a blend (${facts.blend})`);
  check(["no_gravity", "under_par", "low_stock", "stalled"].every((k) => facts.alerts.includes(k)), `alerts on the tank board (${Object.entries(facts.alerts.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  check(facts.plans >= 10 && facts.recipes >= 10 && facts.lines >= 10 && facts.boards === 4 && facts.views === 1 && facts.pars >= 10 && facts.cleanings > 0,
    `the calendar, recipes, draft lines, menu boards, a view, pars, acid cycles (${JSON.stringify({ plans: facts.plans, recipes: facts.recipes, lines: facts.lines, boards: facts.boards, pars: facts.pars, cleanings: facts.cleanings })})`);
  await page.screenshot({ path: `${SHOTS}demo-tanks.png`, fullPage: false });

  console.log("4. Empty the brewery again");
  await empty();
  check(await page.evaluate(() => isEmptyBrewery()), "emptied");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}demo-crash.png` }).catch(() => {});
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
