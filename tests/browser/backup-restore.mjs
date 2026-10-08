// A backup file restores everything: tanks, beers, batches and history, volumes, the brew log
// (cellar log, ingredients, brew-day readings), and the brew sheet's setup. Copies the first test
// brewery's data into the second (empty) one, compares, then empties the second again.
import { chromium } from "playwright-core";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

async function signIn(email) {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  page.errors = [];
  page.on("dialog", (d) => { if (/couldn|wrong|error|isn|violat|null/i.test(d.message())) console.log("DIALOG:", d.message()); d.accept(); });
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
  await page.waitForFunction(() => !busy && brewery?.id && data);
  return page;
}
const counts = (page) => page.evaluate(() => ({
  tanks: data.tanks.length, batches: data.batches.length, events: data.events.length, movements: data.movements.length, packageCounts: data.packageCounts.length, stockMoves: data.stockMoves.length, onHand: stockOnHand().length, pars: data.pars.length, rawItems: data.rawItems.length, rawReceipts: data.rawReceipts.length, rawAdjustments: data.rawAdjustments.length,
  cellar: data.cellar.length, additions: data.additions.length, readings: data.readings.length,
  ownFields: (brewery.sheetCustomFields || []).length, sheetFields: (brewery.sheetFields || []).length,
}));

try {
  console.log("1. Back up the first brewery");
  const first = await signIn("brewer1@example.test");
  const backup = await first.evaluate(() => structuredClone(data));
  const source = await counts(first);
  check(source.movements > 0 && source.cellar > 0 && source.additions > 0 && source.readings > 0,
    `the backup has volumes and a brew log: ${JSON.stringify(source)}`);

  console.log("2. Restore it into the second (empty) brewery");
  const second = await signIn("brewer2@example.test");
  if (await second.evaluate(() => brewery.name) !== "Second Brewing") {
    await second.evaluate(() => { const s = document.getElementById("brewery-switch"); s.value = [...s.options].find((o) => o.text === "Second Brewing").value; s.dispatchEvent(new Event("change")); });
    await second.waitForFunction(() => brewery.name === "Second Brewing" && !busy);
  }
  await second.evaluate(() => clearBrewery());
  await second.evaluate(() => refresh());
  check(await second.evaluate(() => isEmptyBrewery()), "the second brewery starts empty");
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
  const diff = a.filter((x, i) => x !== b2[i]).slice(0, 5);
  check(!diff.length, `every tank holds the same volume${diff.length ? ` (first differences: ${diff.join(" ")} vs ${b2.filter((x) => !a.includes(x)).slice(0, 5).join(" ")})` : ""}`);

  console.log("3. Empty the second brewery again");
  await second.evaluate(() => clearBrewery());
  await second.evaluate(() => refresh());
  check(await second.evaluate(() => isEmptyBrewery()), "emptied");
  check([first, second].every((p) => p.errors.length === 0), `no page errors (${[first, second].flatMap((p) => p.errors).join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
