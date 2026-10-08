// Export as spreadsheets: each list downloads as a CSV file with readable columns in the brewery's
// units, and "Everything" downloads a zip of them all. Real Chrome, local test copy.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { settings } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
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

  console.log("1. One list as a CSV file");
  await settings(page, "backup");
  check(await page.locator("#export-lists [data-export]").count() >= 12, `lists offered: ${await page.locator("#export-lists [data-export]").count()}`);
  const [tanksFile] = await Promise.all([page.waitForEvent("download"), page.click('[data-export="tanks"]')]);
  const csv = await readFile(await tanksFile.path(), "utf8");
  check(tanksFile.suggestedFilename().endsWith(".csv") && tanksFile.suggestedFilename().includes("tanks"), `file: ${tanksFile.suggestedFilename()}`);
  check(csv.startsWith("﻿Tank,Type,Status,Location,Capacity (bbl),Batch,Beer,Stage,In the tank (bbl)"), `columns: ${csv.split("\r\n")[0].slice(1)}`);
  check(csv.split("\r\n").length - 1 === await page.evaluate(() => data.tanks.length), "a row per tank");
  const [cellarFile] = await Promise.all([page.waitForEvent("download"), page.click('[data-export="cellar-log"]')]);
  check((await readFile(await cellarFile.path(), "utf8")).split("\r\n")[0].includes("Gravity (°P)"), "readings in the brewery's units (°P)");

  console.log("2. Everything as one zip");
  const [zipFile] = await Promise.all([page.waitForEvent("download"), page.click("#export-all")]);
  const zip = await readFile(await zipFile.path());
  check(zipFile.suggestedFilename().endsWith(".zip") && zip.subarray(0, 2).toString() === "PK", `a zip file: ${zipFile.suggestedFilename()} (${zip.length} bytes)`);
  check(zip.includes(Buffer.from("batches.csv")) && zip.includes(Buffer.from("stock-moves.csv")), "with the lists inside");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
