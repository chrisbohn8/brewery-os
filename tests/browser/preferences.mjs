// Brewery preferences: numbers are shown and typed in the brewery's units, stored in standard
// units, and an unchanged form never alters a stored value. Real Chrome, local test copy.
import { chromium } from "playwright-core";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test"; // admin of "Example Brewing"
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
const errors = [];
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));
// Wait until a save has started and finished (checking too early would see the old data)
const settle = async () => { await wait(150); await page.waitForFunction(() => !busy); await wait(100); };
const beerRow = (name) => page.evaluate((n) => [...document.querySelectorAll("#beer-list .row")].find((r) => r.innerText.includes(n))?.innerText.replace(/\s+/g, " "), name);
const stored = (expr, arg) => page.evaluate(expr, arg);

async function setUnits(gravity, volume, temperature = "F") {
  await page.selectOption('#settings-form [name="gravityUnit"]', gravity);
  await page.selectOption('#settings-form [name="volumeUnit"]', volume);
  await page.selectOption('#settings-form [name="temperatureUnit"]', temperature);
  await page.click("#save-settings");
  await settle();
}

try {
  console.log("Sign in as the admin");
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
  await setUnits("plato", "bbl"); // start from the defaults

  console.log("1. Plato: targets are shown and typed in °P, stored as SG");
  check((await beerRow("House Hazy"))?.includes("OG 16.1 °P"), `House Hazy (stored 1.066) shows in °P: "${await beerRow("House Hazy")}"`);
  check((await page.textContent("#beer-editor label")).includes("") && (await page.evaluate(() => document.querySelector(".gravity-unit").textContent)) === "°P", "the form says °P");
  const beerName = `Units Test ${run}`;
  await page.click("#add-beer");
  await page.fill('#beer-form [name="name"]', beerName);
  await page.fill('#beer-form [name="targetOg"]', "12.5");
  await page.fill('#beer-form [name="targetFg"]', "2.5");
  await page.dispatchEvent('#beer-form [name="targetFg"]', "input");
  const abvShown = await page.textContent("#target-abv");
  check(abvShown === "5.3%", `ABV works out from °P: ${abvShown}`);
  await page.click("#beer-form button[type=submit]");
  await page.waitForFunction((n) => data.beers.some((b) => b.name === n), beerName);
  const og = await stored((n) => data.beers.find((b) => b.name === n).targetOg, beerName);
  check(Math.abs(og - 1.0504) < 0.0002, `12.5 °P is stored as SG ${og}`);
  check((await beerRow(beerName))?.includes("OG 12.5 °P · FG 2.5 °P"), `and shown back as typed: "${await beerRow(beerName)}"`);

  console.log("2. Saving a form without changes keeps the exact stored value");
  await page.click(`#beer-list .row >> text=${beerName}`);
  await page.waitForSelector("#beer-editor[open]");
  await page.click("#beer-form button[type=submit]");
  await settle();
  check(await stored((n) => data.beers.find((b) => b.name === n).targetOg, beerName) === og, "target OG unchanged to the last digit");

  console.log("3. Volume in hectoliters");
  const tankName = `U-${run}`;
  await page.click("#add-tank");
  await page.fill('#tank-form [name="name"]', tankName);
  await page.fill('#tank-form [name="capacityBbl"]', "15");
  await page.click("#tank-form button[type=submit]");
  await page.waitForFunction((n) => data.tanks.some((t) => t.name === n), tankName);
  await setUnits("plato", "hl");
  const tankId = await stored((n) => data.tanks.find((t) => t.name === n).id, tankName);
  const card = await page.locator(`.card[data-tank="${tankId}"]`).innerText();
  check(card.includes("17.6 hL"), `15 bbl shows as 17.6 hL: "${card.replace(/\s+/g, " ")}"`);
  check((await page.evaluate(() => document.querySelector(".volume-unit").textContent)) === "hL", "form labels say hL");
  await page.click(`.card[data-tank="${tankId}"]`);
  await page.waitForSelector("dialog[open]");
  if (await page.isVisible("#batch-editor[open]")) { // an empty tank opens the batch form; go to its settings
    await page.click("#open-tank-settings");
    await page.waitForSelector("#tank-editor[open]");
  }
  check((await page.inputValue('#tank-form [name="capacityBbl"]')) === "17.6", "the tank form shows 17.6");
  await page.click("#tank-form button[type=submit]");
  await settle();
  check(!(await page.isVisible("#tank-editor[open]")), "the tank form saves and closes (17.6 isn't refused by the browser)");
  check(await stored((id) => data.tanks.find((t) => t.id === id).capacityBbl, tankId) === 15, "saved unchanged: still exactly 15 bbl (not 14.998)");

  console.log("4. Specific gravity");
  await setUnits("sg", "bbl");
  check((await beerRow(beerName))?.includes("OG 1.050 SG"), `shown in SG: "${await beerRow(beerName)}"`);
  check((await beerRow("House Hazy"))?.includes("OG 1.066 SG"), "House Hazy shows its original 1.066");

  console.log("5. Back to the brewery's units");
  await setUnits("plato", "bbl");
  check((await beerRow("House Hazy"))?.includes("OG 16.1 °P"), "back to °P");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("dialogs:", dialogs);
  console.log("CRASH", e.message);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
