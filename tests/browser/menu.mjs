// The menu's data (menu boards, step 1): an admin sets up pour sizes, sections, tags, and their own
// fields in Settings → Menu, then fills them in on a beer's "On the menu", with a different price at
// one taproom. Renaming a size changes it on the beer; removing one in use asks first.
// Real Chrome against the local Supabase test copy (served by the preview server on port 8123).
// Puts the brewery's menu lists and the beer's menu back as they were at the end.
import { chromium } from "playwright-core";
import { settings, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const ADMIN = "brewer1@example.test"; // admin of "Example Brewing"
const run = Date.now().toString(36).slice(-5);
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
const errors = [];
const dialogs = []; // [message, answer] for each question the app asks
let answer = null;  // what to type into the next question that asks for a name
await onDialog(page, async (d) => { dialogs.push(d.message()); await d.accept(answer ?? undefined); });
page.on("pageerror", (e) => errors.push(e.message));

const settle = async () => { await wait(150); await page.waitForFunction(() => !busy && !reloading); await wait(100); };
const list = (key) => `#menu-lists [data-list="${key}"]`;
const rowOf = (key, name) => page.evaluateHandle(([k, n]) => [...document.querySelectorAll(`#menu-lists [data-list="${k}"] .menu-row`)]
  .find((r) => r.querySelector(".menu-name").value === n), [key, name]);
const menu = () => page.evaluate(() => data.menu);
const names = async (key) => (await menu())[key].map((x) => x.name);

let saved = null, recipe = null, beerId = null, beforeBeer = null, addedTaprooms = [];
try {
  console.log("Sign in as the admin");
  await page.goto(APP);
  await page.waitForSelector("#signin-screen:not([hidden]), #app-screen:not([hidden])", { timeout: 20000 });
  const before = new Set(((await (await fetch(`${MAIL}/messages`)).json()).messages || []).map((m) => m.ID));
  await page.fill('#signin-form [name="email"]', ADMIN);
  await page.click("#signin-form button[type=submit]");
  await page.waitForSelector("#code-form:not([hidden])");
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    const msg = ((await (await fetch(`${MAIL}/messages`)).json()).messages || []).find((m) => !before.has(m.ID) && m.To.some((t) => t.Address === ADMIN));
    if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
    if (!code) await wait(300);
  }
  await page.fill('#code-form [name="code"]', code);
  await page.click("#code-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden])", { timeout: 20000 });
  await wait(300);

  // Start from empty lists (put back at the end), and two taprooms (for a taproom's own price)
  saved = await menu();
  // A beer with a recipe (for "Fill in"), given a color; put back at the end
  beerId = await page.evaluate(() => data.recipes[0]?.beerId || data.beers[0].id);
  recipe = await page.evaluate((id) => data.recipes.filter((r) => r.beerId === id).at(-1), beerId);
  if (recipe) await page.evaluate(async (id) => { await db.from("recipes").update({ color_srm: 7.5 }).eq("id", id); }, recipe.id);
  beforeBeer = await page.evaluate(async (id) => (await db.from("beers").select("menu_prices, menu_short, menu_srm, menu_section, menu_tags, menu_extra, menu_public").eq("id", id).single()).data, beerId);
  await page.evaluate(async () => { await db.from("breweries").update({ menu_sizes: [], menu_sections: [], menu_tags: [], menu_fields: [] }).eq("id", brewery.id); });
  const have = await page.evaluate(() => data.places.filter((p) => p.kind === "taproom" && p.active).length);
  for (let i = have; i < 2; i++) {
    addedTaprooms.push(await page.evaluate(async (name) => (await db.from("stock_places").insert({ brewery_id: brewery.id, name, kind: "taproom" })
      .select("id").single()).data.id, `Test taproom ${run} ${i + 1}`));
  }
  await page.reload();
  await page.waitForSelector("#app-screen:not([hidden])");

  console.log("1. Settings → Menu: the usual ones, your own, in order");
  await settings(page, "menu");
  check(await page.isVisible(`${list("sizes")} >> text=None yet`), "an empty list says so, and how to add");
  check(await page.isDisabled("#menu-setup-save"), "nothing to save yet");
  await page.click(`${list("sizes")} button:text-is("+ 16 oz")`);
  await page.click(`${list("sizes")} button:text-is("+ 10 oz")`);
  await page.click(`${list("sizes")} button:text-is("+ Flight (4 × 4 oz)")`);
  answer = `Half pour ${run}`;
  await page.click(`${list("sizes")} [data-add-own]`);
  await wait(200);
  answer = null;
  check(/Name of the new size/.test(dialogs.at(-1) || ""), "+ Your own size asks for its name");
  await (await rowOf("sizes", `Half pour ${run}`)).asElement().$('[data-prop="oz"]').then((el) => el.fill("8"));
  await (await rowOf("sizes", "Flight (4 × 4 oz)")).asElement().$('[data-move="-1"]').then((el) => el.click());
  check(await page.isVisible("text=Changes not saved yet.") && !(await page.isDisabled("#menu-setup-save")), "says there are changes to save");
  await page.click(`${list("sections")} button:text-is("+ IPAs")`);
  await page.click(`${list("sections")} button:text-is("+ Lagers")`);
  await page.click(`${list("tags")} button:text-is("+ New")`);
  await page.click(`${list("tags")} button:text-is("+ Contains lactose")`);
  await page.click(`${list("fields")} button:text-is("+ Hops")`);
  answer = "Glass";
  await page.click(`${list("fields")} [data-add-own]`);
  await wait(200);
  answer = null;
  await (await rowOf("fields", "Glass")).asElement().$('[data-prop="type"]').then((el) => el.selectOption("list"));
  await wait(100);
  await page.click("#menu-setup-save");
  await wait(400);
  check(/needs its choices/.test(await page.textContent("#toasts")), "a pick-from-a-list field needs its choices");
  await (await rowOf("fields", "Glass")).asElement().$('[data-prop="options"]').then((el) => el.fill("Tulip, Pint, Snifter"));
  await page.click("#menu-setup-save");
  await settle();
  let m = await menu();
  check(JSON.stringify(m.sizes.map((x) => [x.name, x.oz])) === JSON.stringify([["16 oz", 16], ["Flight (4 × 4 oz)", 16], ["10 oz", 10], [`Half pour ${run}`, 8]]),
    `pour sizes saved, in order, with ounces (${JSON.stringify(m.sizes.map((x) => [x.name, x.oz]))})`);
  check(JSON.stringify(await names("sections")) === '["IPAs","Lagers"]', "sections saved");
  check(JSON.stringify(m.tags.map((t) => t.kind)) === '["badge","allergen"]', "tags saved, with their kind");
  check(JSON.stringify(m.fields.map((f) => [f.name, f.type, f.options])) === '[["Hops","text",[]],["Glass","list",["Tulip","Pint","Snifter"]]]', "fields saved, with the list's choices");
  check(await page.isDisabled("#menu-setup-save") && !(await page.textContent("#menu-setup-status")), "nothing left to save");

  console.log("2. Two with the same name aren't saved");
  await (await rowOf("sections", "Lagers")).asElement().$(".menu-name").then((el) => el.fill("ipas"));
  await page.click("#menu-setup-save");
  await wait(400);
  check(/two sections called/.test(await page.textContent("#toasts")), "same name twice: says so");
  await page.click("#menu-setup-undo");
  check(JSON.stringify(await page.$$eval(`${list("sections")} .menu-name`, (els) => els.map((e) => e.value))) === '["IPAs","Lagers"]', "Undo changes goes back to what's saved");

  console.log("3. A beer's menu details");
  await settings(page, "beers");
  await page.click(`#beer-list [data-beer="${beerId}"]`);
  await page.waitForSelector("#beer-editor[open]");
  const taprooms = await page.$$eval("#menu-prices thead th", (ths) => ths.slice(2).map((th) => th.textContent));
  check(taprooms.length >= 2, `a price column for each taproom (${taprooms.join(", ")})`);
  check(JSON.stringify(await page.$$eval("#menu-prices tbody th", (ths) => ths.map((th) => th.textContent))) === JSON.stringify(m.sizes.map((x) => x.name)),
    "a row for each pour size, in order");
  await page.fill('#beer-form [name="menuShort"]', `Bright, juicy ${run}`);
  if (recipe) {
    await page.click("#menu-fill");
    check(await page.inputValue('#beer-form [name="menuSrm"]') === "7.5" && /color from the recipe/.test(await page.textContent("#menu-fill-note")),
      `"Fill in" takes the color from the recipe, and says so ("${await page.textContent("#menu-fill-note")}")`);
  }
  await page.fill('#beer-form [name="menuSrm"]', "6");
  check(await page.isVisible("#menu-swatch"), "the color shows as a swatch");
  await page.selectOption('#beer-form [name="menuSection"]', { label: "IPAs" });
  await page.check(`#menu-tags label:has-text("New") input`);
  await page.fill('#menu-extra label:has-text("Hops") input', "Citra, Mosaic");
  await page.selectOption('#menu-extra label:has-text("Glass") select', "Tulip");
  await page.fill('#menu-prices tr:has(th:text-is("16 oz")) .price-amount', "7");
  await page.fill('#menu-prices tr:has(th:text-is("10 oz")) .price-at >> nth=0', "5");
  await page.click("#beer-form button[type=submit]");
  await wait(400);
  check(/10 oz: a price at one taproom needs the usual price too/.test(await page.textContent("#toasts")) && await page.isVisible("#beer-editor[open]"),
    "a taproom's price without the usual one isn't saved");
  await page.fill('#menu-prices tr:has(th:text-is("10 oz")) .price-amount', "4.5");
  await page.check('#beer-form [name="menuHidden"]');
  await page.click("#beer-form button[type=submit]");
  await settle();
  const placeId = await page.evaluate(() => data.places.filter((p) => p.kind === "taproom" && p.active)[0].id);
  let beer = await page.evaluate((id) => data.beers.find((b) => b.id === id), beerId);
  m = await menu();
  const size = (name) => m.sizes.find((x) => x.name === name).id;
  check(beer.menuShort === `Bright, juicy ${run}` && beer.menuSrm === 6, "short line and color saved");
  check(beer.menuSection === m.sections[0].id && JSON.stringify(beer.menuTags) === JSON.stringify([m.tags[0].id]), "section and tag saved");
  check(beer.menuExtra[m.fields[0].id] === "Citra, Mosaic" && beer.menuExtra[m.fields[1].id] === "Tulip" && Object.keys(beer.menuExtra).length === 2, `own fields saved (${JSON.stringify(beer.menuExtra)})`);
  const tidy = (prices) => JSON.stringify(prices.map((p) => [p.size, p.price, p.at || null])); // (the database keeps keys in its own order)
  check(tidy(beer.menuPrices) === tidy([{ size: size("16 oz"), price: 7 }, { size: size("10 oz"), price: 4.5, at: { [placeId]: 5 } }]),
    `prices saved by pour size, with one taproom's own (${JSON.stringify(beer.menuPrices)})`);
  check(beer.menuPublic === false, "left off the public menu");

  console.log("4. Renaming a size changes it on the beer; removing one in use asks first");
  await settings(page, "menu");
  check(await page.isVisible(`${list("sizes")} >> text=on 1 beer`), "shows how many beers use a size");
  await (await rowOf("sizes", "16 oz")).asElement().$(".menu-name").then((el) => el.fill("Pint"));
  const asked = dialogs.length;
  await (await rowOf("sizes", "10 oz")).asElement().$("[data-remove]").then((el) => el.click());
  await wait(200);
  check(dialogs.length === asked + 1 && /1 beer uses "10 oz"/.test(dialogs.at(-1)), `removing a size in use asks first ("${dialogs.at(-1)}")`);
  await page.click("#menu-setup-save");
  await settle();
  await settings(page, "beers");
  await page.click(`#beer-list [data-beer="${beerId}"]`);
  await page.waitForSelector("#beer-editor[open]");
  check(JSON.stringify(await page.$$eval("#menu-prices tbody th", (ths) => ths.map((th) => th.textContent))) === JSON.stringify(["Pint", "Flight (4 × 4 oz)", `Half pour ${run}`]),
    "the beer shows the new name, and the removed size is gone");
  check(await page.inputValue('#menu-prices tr:has(th:text-is("Pint")) .price-amount') === "7", "the renamed size kept its price");
  await page.click("#beer-editor .cancel");

  console.log("5. The spreadsheet export reads by name");
  const row = await page.evaluate((id) => exportLists().beers.find((r) => r.Beer === data.beers.find((b) => b.id === id).name), beerId);
  check(row && /^Pint \$7/.test(row["Menu prices"]) && row["Menu section"] === "IPAs" && row["Menu: Glass"] === "Tulip" && row["On the public menu"] === "no",
    `beers export: ${JSON.stringify(row && { prices: row["Menu prices"], section: row["Menu section"] })}`);
  console.log("6. A backup from before the lists: typed prices become pour sizes");
  const old = await page.evaluate(() => upgradeData({ tanks: [], batches: [], beers: [{ id: "x", name: "A",
    menuPrices: [{ size: "16 oz", price: 7 }, { size: "Flight", price: 12 }] }, { id: "y", name: "B", menuPrices: [{ size: "16 OZ", price: 6 }] }] }));
  check(JSON.stringify(old.menu.sizes.map((x) => [x.name, x.oz])) === '[["16 oz",16],["Flight",null]]'
    && old.beers[1].menuPrices[0].size === old.menu.sizes[0].id, `sizes made once each, with ounces from the name (${JSON.stringify(old.menu.sizes.map((x) => x.name))})`);
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  // Put things back
  if (saved) {
    await page.evaluate(async ([m, id, b, taps, r]) => {
      await db.from("breweries").update({ menu_sizes: m.sizes, menu_sections: m.sections, menu_tags: m.tags, menu_fields: m.fields }).eq("id", brewery.id);
      if (b) await db.from("beers").update(b).eq("id", id);
      for (const tap of taps) await db.from("stock_places").delete().eq("id", tap);
      if (r) await db.from("recipes").update({ color_srm: r.colorSrm }).eq("id", r.id);
    }, [saved, beerId, beforeBeer, addedTaprooms, recipe]).catch((e) => console.log("tidy-up failed:", e.message));
  }
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
