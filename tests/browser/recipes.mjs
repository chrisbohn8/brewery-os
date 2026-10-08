// Recipes from recipe software (BeerXML): imported with a preview, matched to a beer (or a new one
// with the recipe's targets), shown with ingredients in the brewery's units, and copied to a
// batch's brew-day sheet (dry hops left for the cellar). Real Chrome, local test copy.
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { settings, floor } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A made-up recipe, the way BeerSmith and friends write BeerXML (kg, liters, minutes)
const BEERXML = `<?xml version="1.0" encoding="ISO-8859-1"?>
<RECIPES><RECIPE><NAME>Test Pale ${run}</NAME><VERSION>1</VERSION><TYPE>All Grain</TYPE><BREWER>Someone</BREWER>
<STYLE><NAME>American Pale Ale</NAME></STYLE><BATCH_SIZE>117.348</BATCH_SIZE><OG>1.052</OG><FG>1.011</FG><IBU>38.5 IBUs</IBU>
<NOTES>Mash at 152.</NOTES>
<FERMENTABLES>
 <FERMENTABLE><NAME>Pale Malt (2 Row)</NAME><TYPE>Grain</TYPE><AMOUNT>5.0</AMOUNT></FERMENTABLE>
 <FERMENTABLE><NAME>Cane Sugar</NAME><TYPE>Sugar</TYPE><AMOUNT>0.2</AMOUNT></FERMENTABLE>
</FERMENTABLES>
<HOPS>
 <HOP><NAME>Cascade</NAME><AMOUNT>0.05</AMOUNT><USE>Boil</USE><TIME>60</TIME></HOP>
 <HOP><NAME>Citra</NAME><AMOUNT>0.1</AMOUNT><USE>Aroma</USE><TIME>20</TIME></HOP>
 <HOP><NAME>Mosaic</NAME><AMOUNT>0.2</AMOUNT><USE>Dry Hop</USE><TIME>4320</TIME></HOP>
</HOPS>
<MISCS>
 <MISC><NAME>Gypsum</NAME><TYPE>Water Agent</TYPE><USE>Mash</USE><TIME>60</TIME><AMOUNT>0.01</AMOUNT><AMOUNT_IS_WEIGHT>TRUE</AMOUNT_IS_WEIGHT></MISC>
 <MISC><NAME>Whirlfloc</NAME><TYPE>Fining</TYPE><USE>Boil</USE><TIME>15</TIME><AMOUNT>0.002</AMOUNT><AMOUNT_IS_WEIGHT>TRUE</AMOUNT_IS_WEIGHT></MISC>
</MISCS>
<YEASTS><YEAST><NAME>American Ale</NAME><LABORATORY>Some Lab</LABORATORY><PRODUCT_ID>001</PRODUCT_ID><AMOUNT>0.1</AMOUNT></YEAST></YEASTS>
</RECIPE></RECIPES>`;

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);
const allSent = () => page.waitForFunction(() => !busy && !sending && outbox.length === 0, null, { timeout: 30000 });
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

  console.log("1. Import a BeerXML file as a new beer");
  await mkdir(SHOTS, { recursive: true });
  await writeFile(SHOTS + "recipe.xml", BEERXML);
  await settings(page, "beers");
  await page.setInputFiles("#import-beerxml", SHOTS + "recipe.xml");
  await page.waitForSelector("#recipe-import[open]");
  const preview = await text("#recipe-import-list");
  check(preview.includes(`Test Pale ${run}`) && preview.includes("1 bbl") && preview.includes("39 IBU") && preview.includes("8 ingredients"), `preview: "${preview.slice(0, 120)}"`);
  check((await page.inputValue("[data-recipe-beer]")) === "new", "no beer by that name yet: a new one");
  await page.click("#recipe-import-form button[type=submit]");
  await allSent();
  const beer = await page.evaluate((n) => data.beers.find((b) => b.name === n), `Test Pale ${run}`);
  check(beer && Math.abs(beer.targetOg - 1.052) < 1e-6 && beer.style === "American Pale Ale", "the beer, with the recipe's targets and style");

  console.log("2. The recipe, in the brewery's units");
  await page.click(`[data-recipe="${await page.evaluate((id) => data.recipes.find((r) => r.beerId === id).id, beer.id)}"]`);
  await page.waitForSelector("#recipe-view[open]");
  const ingredients = await text("#recipe-ingredients");
  check(ingredients.includes("Pale Malt (2 Row) 11.02 lb · Mash") && ingredients.includes("Cascade 1.76 oz · Boil 60 min"), `malt in lb, hops in oz: "${ingredients.slice(0, 90)}"`);
  check(ingredients.includes("Citra 3.53 oz · Whirlpool 20 min") && ingredients.includes("Mosaic 7.05 oz · Dry hop 3 days · in the cellar"), "whirlpool and dry hop timing");
  check(ingredients.includes("Gypsum 0.35 oz · Mash") && ingredients.includes("American Ale (Some Lab 001)"), "salts and yeast");
  await page.click("#recipe-view button[type=submit]");

  console.log("3. A batch of it copies the recipe's brew-day ingredients");
  const tankName = `RC-${run}`;
  await settings(page, "equipment");
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', tankName);
  await page.click("#tank-form button[type=submit]");
  await page.waitForFunction((n) => data.tanks.some((t) => t.name === n), tankName);
  await floor(page);
  const tankId = await page.evaluate((n) => data.tanks.find((t) => t.name === n).id, tankName);
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-editor[open]");
  await page.fill('#batch-form [name="batchId"]', `R${run}`);
  await page.selectOption('#batch-form [name="beerId"]', beer.id);
  await page.click("#batch-form button[type=submit]");
  await allSent();
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  await page.click("#bv-sheet");
  check((await text("#sheet-ingredients")).includes(`Copy from the recipe Test Pale ${run}`), "offered: copy from the recipe");
  await page.click("[data-copy-recipe]");
  await allSent();
  const copied = await page.evaluate((n) => { const b = data.batches.find((x) => x.batchNumber === n); return data.additions.filter((a) => a.batchId === b.id).map((a) => a.name); }, `R${run}`);
  check(copied.length === 7 && !copied.includes("Mosaic"), `7 brew-day ingredients copied, the dry hop left for the cellar (${copied.length})`);
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
  await page.screenshot({ path: SHOTS + "crash.png" }).catch(() => {});
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
