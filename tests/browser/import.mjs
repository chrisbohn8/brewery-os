// Import from a spreadsheet: pasted cells and a CSV file; columns matched by name; a preview of
// what's created, skipped, or a problem; then tanks, beers, batches, and cellar logs saved; and
// importing the same thing again skips it all. Real Chrome, local test copy.
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { settings, floor, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [], dialogs = [];
await onDialog(page, (d) => { dialogs.push(d.message()); d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim(), sel);
const allSent = () => page.waitForFunction(() => !busy && !sending && !reloading, null, { timeout: 30000 });
async function importPasted(kind, tsv) {
  await page.selectOption("#import-kind", kind);
  await page.fill("#import-text", tsv);
  await page.click("#import-paste");
}
async function go() {
  await page.click("#import-go");
  await page.waitForFunction(() => /^Imported \d+ rows?\.$|before a problem/.test(document.getElementById("import-result").textContent), null, { timeout: 60000 });
  await allSent();
}

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
  await settings(page, "import");
  const existing = await page.evaluate(() => data.tanks[0].name);

  console.log("1. Tanks from pasted cells (columns matched by name; one already there; one bad type)");
  await importPasted("tanks", [`Vessel\tKind\tCapacity (bbl)\tLocation`, `I1-${run}\tFermenter\t30\tCellar ${run}`, `I2-${run}\tBrite\t15 bbl\tCellar ${run}`,
    `${existing}\tFermenter\t10\t`, `I3-${run}\tSubmarine\t10\t`].join("\n"));
  const mapped = await page.evaluate(() => importMap);
  check(mapped.name === 0 && mapped.type === 1 && mapped.capacity === 2 && mapped.location === 3, `columns matched: ${JSON.stringify(mapped)}`);
  const preview = await text("#import-preview");
  check(preview.includes("2 to import") && preview.includes("1 already there") && preview.includes("1 with a problem"), `preview: "${preview.slice(0, 90)}"`);
  check(preview.includes(`new location "Cellar ${run}"`) && preview.includes('unknown type "Submarine"'), "the preview says what it'll do and why not");
  await page.screenshot({ path: SHOTS + "import.png", fullPage: true });
  await go();
  const t1 = await page.evaluate((n) => data.tanks.find((t) => t.name === n), `I1-${run}`);
  const t2 = await page.evaluate((n) => data.tanks.find((t) => t.name === n), `I2-${run}`);
  check(t1?.capacityBbl === 30 && t2?.type === "brite" && t2?.capacityBbl === 15, "tanks made, with type and capacity (\"15 bbl\" read as 15)");
  check(await page.evaluate((n) => data.locations.some((l) => l.name === n), `Cellar ${run}`), "and the new location");

  console.log("2. Beers from a CSV file (in °P)");
  await mkdir(SHOTS, { recursive: true });
  await writeFile(SHOTS + "beers.csv", `﻿Beer,Style,OG,FG\r\n"Imp Ale ${run}","Pale Ale, hoppy",12.5,2.5\r\n`);
  await page.selectOption("#import-kind", "beers");
  await page.setInputFiles("#import-csv", SHOTS + "beers.csv");
  await page.waitForFunction(() => document.getElementById("import-preview").textContent.includes("to import"));
  await go();
  const beer = await page.evaluate((n) => data.beers.find((b) => b.name === n), `Imp Ale ${run}`);
  check(beer?.style === "Pale Ale, hoppy" && Math.abs(beer.targetOg - 1.0505) < 0.001, `beer with a quoted comma and an OG in °P: ${beer?.style}, ${beer?.targetOg}`);

  console.log("3. Batches in tanks (a new beer made on the way; a missing tank is a problem)");
  await importPasted("batches", [`Batch\tBeer\tTank\tBrew date\tSize\tStage`, `B${run}\tImp Ale ${run}\tI1-${run}\t10/1/2026\t30\tConditioning`,
    `C${run}\tBrand New ${run}\tI2-${run}\t2026-10-02\t15\tfermenting`, `D${run}\tImp Ale ${run}\tNowhere-${run}\t10/3/26\t10\t`].join("\n"));
  check((await text("#import-preview")).includes(`no tank called "Nowhere-${run}"`), "a missing tank is a problem, not a guess");
  await go();
  const batches = await page.evaluate((r) => data.batches.filter((b) => b.batchNumber.endsWith(r)).map((b) => `${b.batchNumber}:${b.stage}:${b.brewDate}`), run);
  check(batches.includes(`B${run}:conditioning:2026-10-01`) && batches.includes(`C${run}:fermenting:2026-10-02`) && batches.length === 2, `batches: ${batches.join(", ")}`);
  check(await page.evaluate((n) => data.beers.some((b) => b.name === n), `Brand New ${run}`), "the new beer was made");
  check(await page.evaluate((n) => tankBalance(data.batches.find((b) => b.batchNumber === n).id, data.batches.find((b) => b.batchNumber === n).tankId), `B${run}`) === 30, "30 bbl in the tank");

  console.log("4. Cellar log, and importing the same again skips it");
  const log = [`Batch\tDate\tAction\tGravity\tTemp\tNotes`, `B${run}\t10/5/2026\tCheck\t4.2\t64\tfrom a sheet ${run}`].join("\n");
  await importPasted("cellar", log);
  await go();
  const entry = await page.evaluate((n) => data.cellar.find((c) => c.notes === n), `from a sheet ${run}`);
  check(entry && Math.abs(entry.gravitySg - 1.0165) < 0.0005 && Math.abs(entry.tempC - 17.78) < 0.01 && entry.occurredOn === "2026-10-05", "logged in °P and °F, stored in standard units");
  await importPasted("cellar", log);
  check((await text("#import-preview")).includes("0 to import") && await page.isDisabled("#import-go"), "the same rows again: nothing to import");

  console.log("4b. A calendar plan from a sheet: days, someday, the sheet's own words, who; a missing beer is a problem");
  const plan = [`Day\tWhat\tTank\tBeer\tWho\tNotes`, `10/20/2026\tBrew\tI1-${run}\tImp Ale ${run}\tbrewer1\tfrom a sheet ${run}`,
    `10/21/2026\tGlycol service ${run}\t\t\t\t`, `Fall\t\t\tImp Ale ${run}\t\t`, `10/22/2026\tBrew\t\tNo Such Beer ${run}\t\t`].join("\n");
  await importPasted("plan", plan);
  const planPreview = await text("#import-preview");
  check(planPreview.includes("3 to import") && planPreview.includes(`no beer called "No Such Beer ${run}"`) && planPreview.includes('someday: "Fall"'),
    `preview: "${planPreview.slice(0, 120)}"`);
  await go();
  const imported = await page.evaluate((r) => data.planItems.filter((p) => (p.notes || "").includes(r) || (p.title || "").includes(r) || findBeer(p.beerId)?.name.endsWith(r))
    .map((p) => `${p.kind}|${p.plannedOn || p.someday}|${p.title}|${p.assignedTo ? "who" : ""}`).sort(), run);
  check(imported.includes("brew|2026-10-20||who") && imported.includes(`other|2026-10-21|Glycol service ${run}|`) && imported.includes("brew|Fall||"),
    `on the calendar: ${imported.join(", ")}`);
  await importPasted("plan", plan);
  check((await text("#import-preview")).includes("0 to import"), "the same sheet again: nothing new");
  await page.evaluate(async (r) => save(() => must(db.from("plan_items").delete().in("id",
    data.planItems.filter((p) => (p.notes || "").includes(r) || (p.title || "").includes(r) || findBeer(p.beerId)?.name.endsWith(r)).map((p) => p.id)))), run);

  console.log("5. A Google Sheets link that isn't one");
  dialogs.length = 0;
  await page.fill("#import-sheet-url", "https://example.com/not-a-sheet");
  await page.click("#import-sheet");
  await page.waitForFunction(() => !document.getElementById("import-sheet").disabled);
  await wait(300);
  check(dialogs.some((d) => d.includes("isn't a Google Sheets link")), `refused: "${dialogs[0]}"`);

  console.log("6. A real Google Sheet (Google's public example sheet; skipped without internet)");
  const online = await fetch("https://docs.google.com", { method: "HEAD" }).then(() => true, () => false);
  if (online) {
    await page.selectOption("#import-kind", "beers");
    await page.fill("#import-sheet-url", "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0");
    await page.click("#import-sheet");
    await page.waitForFunction(() => !document.getElementById("import-sheet").disabled, null, { timeout: 30000 });
    const headers = await page.evaluate(() => importTable?.headers);
    check(Array.isArray(headers) && headers.includes("Student Name"), `read the sheet's columns: ${JSON.stringify(headers?.slice(0, 3))}`);
    check(await page.evaluate(() => importTable.rows.length) > 10, "and its rows");
  } else {
    console.log("  SKIP no internet");
  }
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
