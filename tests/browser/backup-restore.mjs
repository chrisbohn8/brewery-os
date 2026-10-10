// A backup file restores everything: tanks, beers, batches and history, volumes, the brew log
// (cellar log, ingredients, brew-day readings), and the brew sheet's setup. Copies the first test
// brewery's data into the second (empty) one, compares, then empties the second again.
import { chromium } from "playwright-core";
import { onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

async function signIn(email) {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  page.errors = [];
  await onDialog(page, (d) => { if (/couldn|wrong|error|isn|violat|null/i.test(d.message())) console.log("DIALOG:", d.message()); d.accept(); });
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(APP);
  await page.waitForSelector("#signin-screen:not([hidden])", { timeout: 20000 });
  const before = new Set(((await (await fetch(`${MAIL}/messages`)).json()).messages || []).map((m) => m.ID));
  await page.fill('#signin-form [name="email"]', email);
  await page.click("#signin-form button[type=submit]");
  await page.waitForSelector("#code-form:not([hidden])");
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    const msg = ((await (await fetch(`${MAIL}/messages`)).json()).messages || []).find((m) => !before.has(m.ID) && m.To.some((t) => t.Address === email));
    if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
    if (!code) await wait(300);
  }
  await page.fill('#code-form [name="code"]', code);
  await page.click("#code-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 20000 });
  await page.waitForFunction(() => !busy && !reloading && brewery?.id && data);
  return page;
}
// Empty a brewery (the test's own cleanup; deleting batches takes their history with them)
const empty = (page) => page.evaluate(async () => {
  const b = brewery.id;
  for (const table of ["plan_items", "stock_moves", "batches", "tanks", "beers", "stock_places", "raw_items", "brewery_files", "locations"]) {
    await must(db.from(table).delete().eq("brewery_id", b));
  }
  await must(db.from("breweries").update({ menu_sizes: [], menu_sections: [], menu_tags: [], menu_fields: [] }).eq("id", b));
  await refresh();
});
const counts = (page) => page.evaluate(() => ({
  tanks: data.tanks.length, batches: data.batches.length, events: data.events.length, movements: data.movements.length, packageCounts: data.packageCounts.length, stockMoves: data.stockMoves.length, onHand: stockOnHand().length, pars: data.pars.length, rawItems: data.rawItems.length, rawReceipts: data.rawReceipts.length, rawAdjustments: data.rawAdjustments.length, lines: data.lines.length, views: data.views.length, recipes: data.recipes.length, recipeIngredients: data.recipeIngredients.length,
  cellar: data.cellar.length, additions: data.additions.length, readings: data.readings.length,
  planItems: data.planItems.length, schedules: Object.keys(data.schedules).length, shifts: Object.keys(data.shifts).length, rawOrders: data.rawOrders.length,
  ownFields: (brewery.sheetCustomFields || []).length, sheetFields: (brewery.sheetFields || []).length,
}));

let firstPage = null, firstBefore = null;
try {
  console.log("1. Back up the first brewery");
  const first = firstPage = await signIn("brewer1@example.test");
  await first.evaluate(async () => { // a plan item and a beer schedule, so the backup has them to bring back
    const beer = data.beers[0], tank = data.tanks[0];
    if (!data.planItems.length) await save(() => must(db.from("plan_items").insert({ brewery_id: brewery.id, kind: "brew", planned_on: addDays(today(), 3), tank_id: tank.id, beer_id: beer.id })));
    if (!Object.keys(data.schedules).length) await save(() => must(db.from("beer_schedules").insert({ brewery_id: brewery.id, beer_id: beer.id, steps: [{ kind: "crash", day: 9 }] })));
  });
  // The menu's lists, and one beer's menu with a price at one place (put back at the end)
  const TEST_MENU = { sizes: [{ id: "bk-pint", name: "Pint", oz: 16 }], sections: [{ id: "bk-ipa", name: "IPAs" }],
    tags: [{ id: "bk-new", name: "New", kind: "badge" }], fields: [{ id: "bk-hops", name: "Hops", type: "text", options: [] }] };
  firstBefore = await first.evaluate(async (m) => {
    const beer = data.beers[0], place = data.places[0];
    const was = { menu: data.menu, beerId: beer.id, beer: (await db.from("beers").select("menu_prices, menu_short, menu_srm, menu_section, menu_tags, menu_extra, menu_public").eq("id", beer.id).single()).data };
    await must(db.from("breweries").update({ menu_sizes: m.sizes, menu_sections: m.sections, menu_tags: m.tags, menu_fields: m.fields }).eq("id", brewery.id));
    await must(db.from("beers").update({ menu_short: "Bright", menu_srm: 5, menu_section: "bk-ipa", menu_tags: ["bk-new"], menu_extra: { "bk-hops": "Citra" },
      menu_public: false, menu_prices: [{ size: "bk-pint", price: 7, at: { [place.id]: 8 } }] }).eq("id", beer.id));
    await refresh();
    return was;
  }, TEST_MENU);
  // A font, a logo, and (at a taproom) a board that uses both: the backup carries the files themselves
  firstBefore.files = await first.evaluate(async () => {
    const tiny = { data: "YWJjZGVm", bytes: 6 }; // (the database checks the size against the contents)
    const font = newId(), logo = newId();
    await must(db.from("brewery_files").insert([{ id: font, brewery_id: brewery.id, kind: "font", name: "Backup font", mime: "font/woff2", ...tiny },
      { id: logo, brewery_id: brewery.id, kind: "logo", name: "Backup logo", mime: "image/png", ...tiny }]));
    const taproom = data.places.find((p) => p.kind === "taproom");
    const board = taproom ? newId() : null;
    if (board) await must(db.from("menu_boards").insert({ id: board, brewery_id: brewery.id, place_id: taproom.id, name: "Backup board",
      theme: { scheme: "auto", head: "Backup font", logo } }));
    await refresh();
    return { ids: [font, logo], board, taproom: taproom?.name };
  });
  const backup = await first.evaluate(async () => ({ ...structuredClone(data),
    files: await must(db.from("brewery_files").select("id, kind, name, mime, bytes, data").eq("brewery_id", brewery.id)) })); // (as "Download" makes it)
  const source = await counts(first);
  check(source.movements > 0 && source.cellar > 0 && source.additions > 0 && source.readings > 0,
    `the backup has volumes and a brew log: ${JSON.stringify(source)}`);

  console.log("2. Restore it into the second (empty) brewery");
  const second = await signIn("brewer2@example.test");
  if (await second.evaluate(() => brewery.name) !== "Second Brewing") {
    await second.evaluate(() => { const s = document.getElementById("brewery-switch"); s.value = [...s.options].find((o) => o.text === "Second Brewing").value; s.dispatchEvent(new Event("change")); });
    await second.waitForFunction(() => brewery.name === "Second Brewing" && !busy && !reloading);
  }
  await empty(second);
  check(await second.evaluate(() => isEmptyBrewery()), "the second brewery starts empty");

  console.log("2a. A backup that fails partway loads nothing at all");
  second.dialogs = [];
  await onDialog(second, (d) => second.dialogs.push(d.message()));
  const broken = structuredClone(backup);
  broken.readings[broken.readings.length - 1].batchId = "no-such-batch"; // the very last thing loaded
  await second.evaluate((d) => loadIntoBrewery(d, "a broken backup"), broken);
  await second.evaluate(() => refresh());
  check(second.dialogs.some((m) => m.startsWith("Couldn't save") && m.endsWith("Nothing was loaded.")), `the failure is reported (${second.dialogs.at(-1)})`);
  check(await second.evaluate(() => isEmptyBrewery() && !data.stockMoves.length && !data.rawItems.length && !data.events.length),
    "and the brewery is still completely empty");

  console.log("2b. The real backup loads");
  await second.evaluate(() => { const original = explain; window.explain = (e) => (console.log("RAW", JSON.stringify(e)), original(e)); });
  second.on("console", (m) => { if (m.text().startsWith("RAW")) console.log(m.text()); });
  await second.evaluate((d) => loadIntoBrewery(d, "the test backup"), backup);
  await second.evaluate(() => refresh());
  const restored = await counts(second);
  check(JSON.stringify(restored) === JSON.stringify(source), `everything came back: ${JSON.stringify(restored)}`);
  const balances = (page) => page.evaluate(() => data.tanks.map((t) => {
    const b = batchInTank(t.id);
    return `${t.name}:${b ? tankBalance(b.id, t.id) : "-"}`;
  }).sort().join(","));
  const [a, b2] = [(await balances(first)).split(","), (await balances(second)).split(",")];
  const menuOf = (page, name) => page.evaluate((n) => {
    const b = data.beers.find((x) => x.name === n);
    return { menu: data.menu, short: b.menuShort, srm: b.menuSrm, section: b.menuSection, tags: b.menuTags, extra: b.menuExtra, public: b.menuPublic,
      prices: b.menuPrices.map((p) => ({ size: p.size, price: p.price, at: Object.entries(p.at || {}).map(([id, v]) => [data.places.find((pl) => pl.id === id)?.name, v]) })) };
  }, name);
  const beerName = await first.evaluate((id) => data.beers.find((b) => b.id === id).name, firstBefore.beerId);
  const tidy = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
  const [menuA, menuB] = [await menuOf(first, beerName), await menuOf(second, beerName)];
  check(tidy(menuA) === tidy(menuB) && menuB.prices[0].at[0][1] === 8, `the menu's lists and the beer's menu came back, with its price at one place (${tidy(menuB.prices)})`);
  const filesBack = await second.evaluate(async () => (await must(db.from("brewery_files").select("id, kind, name, bytes, data").eq("brewery_id", brewery.id)))
    .map((f) => `${f.kind}:${f.name}:${f.bytes}:${f.data}`).sort());
  check(filesBack.join() === "font:Backup font:6:YWJjZGVm,logo:Backup logo:6:YWJjZGVm", `the fonts and logos came back, contents and all (${filesBack.join(", ")})`);
  if (firstBefore.files.board) {
    const logoOk = await second.evaluate((place) => {
      const board = data.boards.find((b) => b.name === "Backup board" && data.places.find((p) => p.id === b.placeId)?.name === place);
      return !!board && board.theme.logo === data.files.find((f) => f.name === "Backup logo")?.id && board.theme.head === "Backup font";
    }, firstBefore.files.taproom);
    check(logoOk, "and the board still shows its logo (the new copy) and font");
  } else console.log("  (no taproom in the first brewery: skipped the board's logo)");
  const diff = a.filter((x, i) => x !== b2[i]).slice(0, 5);
  check(!diff.length, `every tank holds the same volume${diff.length ? ` (first differences: ${diff.join(" ")} vs ${b2.filter((x) => !a.includes(x)).slice(0, 5).join(" ")})` : ""}`);

  console.log("3. Empty the second brewery again");
  await empty(second);
  check(await second.evaluate(() => isEmptyBrewery()), "emptied");
  check([first, second].every((p) => p.errors.length === 0), `no page errors (${[first, second].flatMap((p) => p.errors).join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  if (firstBefore) await firstPage?.evaluate(async (w) => {
    await db.from("breweries").update({ menu_sizes: w.menu.sizes, menu_sections: w.menu.sections, menu_tags: w.menu.tags, menu_fields: w.menu.fields }).eq("id", brewery.id);
    await db.from("beers").update(w.beer).eq("id", w.beerId);
    if (w.files?.board) await db.from("menu_boards").delete().eq("id", w.files.board);
    if (w.files) await db.from("brewery_files").delete().in("id", w.files.ids);
  }, firstBefore).catch((e) => console.log("tidy-up failed:", e.message));
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
