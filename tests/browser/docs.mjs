// The user guide (guide.html) and the in-app help: every screen's "?" opens its own part of the
// guide, every link in the guide goes somewhere, every button the guide names exists, and the
// guide's lists (stages, permissions, alert kinds...) match the app's. Real Chrome, local test copy.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { settings, floor, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test"; // admin of "Example Brewing"
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
const errors = [];
await onDialog(page, (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));

// Open the help on the screen we're on; answer which guide section it showed
async function help() {
  await page.click("#open-help");
  await page.waitForSelector("#help-dialog[open] #help-body section");
  const shown = await page.evaluate(() => ({
    id: document.querySelector("#help-body section").id,
    words: document.querySelector("#help-body").innerText.trim().length,
    full: document.getElementById("help-full").getAttribute("href"),
  }));
  await page.click("#help-dialog button[type=submit]");
  await page.waitForFunction(() => !document.getElementById("help-dialog").open);
  return shown;
}

try {
  console.log("1. The guide itself (no app needed)");
  const guideHtml = readFileSync(new URL("../../guide.html", import.meta.url), "utf8");
  // (the app's own files: the page, its code, and the demo tour)
  const appText = ["index.html", "app.js", "tour.js", "tryit.js"].map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8")).join("\n");
  const buttons = [...new Set([...guideHtml.matchAll(/class="ui">([^<]+)</g)].map((m) => m[1].replace(/&amp;/g, "&")))];
  const missing = buttons.filter((b) => !appText.includes(b));
  check(missing.length === 0, `every button the guide names is in the app (${buttons.length} names; missing: ${missing.join(", ") || "none"})`);
  check(readFileSync(new URL("../../sw.js", import.meta.url), "utf8").includes('"./guide.html"'), "the guide is kept for offline use (sw.js)");

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

  console.log("2. The guide's links and lists match the app");
  const report = await page.evaluate(async () => {
    const guide = new DOMParser().parseFromString(await (await fetch("guide.html")).text(), "text/html");
    const text = (id) => guide.getElementById(id)?.textContent.replace(/\s+/g, " ") || "";
    const all = guide.body.textContent.replace(/\s+/g, " ");
    const brokenLinks = [...guide.querySelectorAll("a[href^='#']")].map((a) => a.getAttribute("href").slice(1)).filter((id) => !guide.getElementById(id));
    const settingsPages = [...document.querySelectorAll("#settings-nav [data-page]")].map((b) => b.dataset.page);
    // The permissions table: one row per permission, in the app's words, ticked as the usual levels are
    const rows = [...guide.querySelectorAll("#permissions td[data-permission]")].map((td) => td.closest("tr"));
    const table = rows.map((tr) => {
      const id = tr.querySelector("[data-permission]").dataset.permission;
      const cells = [...tr.querySelectorAll("td")].slice(1).map((td) => td.textContent.includes("✓"));
      return { id, label: tr.querySelector("td").textContent.trim(), cells };
    });
    const levels = ROLES.map((r) => r.id);
    const tableWrong = PERMISSIONS.filter((p) => {
      const row = table.find((t) => t.id === p.id);
      const usual = (lv) => lv === "admin" || (DEFAULT_LEVELS[lv] || []).includes(p.id);
      return !row || row.label !== p.label || levels.some((lv, i) => row.cells[i] !== usual(lv));
    }).map((p) => p.id);
    return {
      brokenLinks,
      noSection: settingsPages.filter((p) => !guide.getElementById(`settings-${p}`)),
      extraRows: table.filter((t) => !PERMISSIONS.some((p) => p.id === t.id)).map((t) => t.id),
      tableWrong,
      header: [...guide.querySelectorAll("#permissions th")].slice(1).map((th) => th.textContent),
      roles: ROLES.map((r) => r.label),
      stages: STAGES.filter((s) => !all.includes(s.label)).map((s) => s.label),
      actions: CELLAR_ACTIONS.filter((a) => !text("batch-page").includes(a.id)).map((a) => a.id),
      actionStages: CELLAR_ACTIONS.filter((a) => a.stage).filter((a) => !text("batch-page").includes(STAGES.find((s) => s.id === a.stage).label)).map((a) => a.id),
      planKinds: PLAN_KINDS.filter((k) => !text("calendar").includes(k.label)).map((k) => k.label),
      alertKinds: ALERT_KINDS.filter((k) => !text("settings-alerts").includes(k.label)).map((k) => k.label),
      tankTypes: TANK_TYPES.filter((t) => !text("settings-equipment").includes(t.label)).map((t) => t.label),
      removals: Object.entries(REMOVAL_KINDS).filter(([k]) => k !== "unknown")
        .filter(([, label]) => !text("inventory").toLowerCase().includes(label.toLowerCase())).map(([, l]) => l),
      // The board builder's choices: the guide names exactly the app's, no more and no fewer
      boardLists: [["layouts", BoardView.LAYOUTS], ["themes", BoardView.THEMES], ["fonts", BoardView.FONT_PAIRS]].map(([key, list]) => {
        const named = [...(guide.querySelector(`[data-board-list="${key}"]`)?.querySelectorAll("em") || [])].map((em) => em.textContent);
        const wrong = [...list.map((x) => x.label).filter((l) => !named.includes(l)).map((l) => `missing ${l}`),
          ...named.filter((n) => !list.some((x) => x.label === n)).map((n) => `not in the app: ${n}`)];
        return wrong.length ? `${key}: ${wrong.join(", ")}` : "";
      }).filter(Boolean),
    };
  });
  check(report.brokenLinks.length === 0, `every link inside the guide goes to a part of it (broken: ${report.brokenLinks.join(", ") || "none"})`);
  check(report.noSection.length === 0, `every Settings page has its part of the guide (missing: ${report.noSection.join(", ") || "none"})`);
  check(JSON.stringify(report.header) === JSON.stringify(report.roles), `the permissions table's columns are the app's levels (${report.header.join(", ")})`);
  check(report.tableWrong.length === 0 && report.extraRows.length === 0, `the permissions table matches the app, word for word and tick for tick (wrong: ${[...report.tableWrong, ...report.extraRows].join(", ") || "none"})`);
  check(report.stages.length === 0, `every stage is in the guide (missing: ${report.stages.join(", ") || "none"})`);
  check(report.actions.length === 0, `every cellar action is in "A batch's page" (missing: ${report.actions.join(", ") || "none"})`);
  check(report.actionStages.length === 0, `the stage each action moves to is named there (missing: ${report.actionStages.join(", ") || "none"})`);
  check(report.planKinds.length === 0, `every kind of calendar item is in "Planning calendar" (missing: ${report.planKinds.join(", ") || "none"})`);
  check(report.alertKinds.length === 0, `every kind of alert is in "Settings: Alerts" (missing: ${report.alertKinds.join(", ") || "none"})`);
  check(report.tankTypes.length === 0, `every tank type is in "Settings: Equipment" (missing: ${report.tankTypes.join(", ") || "none"})`);
  check(report.boardLists.length === 0, `the board builder's layouts, color schemes, and font pairings match the guide (${report.boardLists.join("; ") || "all match"})`);
  check(report.removals.length === 0, `every kind of removal is in "Inventory" (missing: ${report.removals.join(", ") || "none"})`);

  console.log("3. The ? on every screen opens that screen's part of the guide");
  await floor(page);
  let shown = await help();
  check(shown.id === "tank-board" && shown.words > 200 && shown.full === "guide.html#tank-board", `tank board → "${shown.id}" (${shown.words} characters, full guide link ${shown.full})`);

  const fullTank = await page.evaluate(() => [...document.querySelectorAll("#floor-view .card[data-tank]")]
    .find((c) => STAGES.some((s) => c.getAttribute("style")?.includes(`--${s.id})`)))?.dataset.tank);
  await page.click(`.card[data-tank="${fullTank}"]`);
  await page.waitForSelector("#batch-view:not([hidden])");
  shown = await help();
  check(shown.id === "batch-page", `a batch's page → "${shown.id}"`);
  await page.click("#bv-sheet");
  await page.waitForSelector("#bv-brewday:not([hidden])");
  shown = await help();
  check(shown.id === "brew-day-sheet", `the brew-day sheet → "${shown.id}"`);
  await floor(page);

  await page.click("#open-inventory");
  await page.waitForSelector("#inventory-view:not([hidden])");
  shown = await help();
  check(shown.id === "inventory", `inventory → "${shown.id}"`);
  await page.click('[data-inv-tab="raw"]');
  await page.waitForSelector("#inv-raw:not([hidden])");
  shown = await help();
  check(shown.id === "raw-materials", `raw materials → "${shown.id}"`);
  await page.click('[data-inv-tab="finished"]');
  await floor(page);
  await page.click("#open-calendar");
  await page.waitForSelector("#calendar-view:not([hidden])");
  shown = await help();
  check(shown.id === "calendar", `the calendar → "${shown.id}"`);
  await floor(page);

  const pages = await page.evaluate(() => [...document.querySelectorAll("#settings-nav [data-page]")].map((b) => b.dataset.page));
  const wrong = [];
  for (const p of pages) {
    await settings(page, p);
    shown = await help();
    if (shown.id !== `settings-${p}` || shown.words < 80) wrong.push(`${p} → ${shown.id} (${shown.words})`);
  }
  check(wrong.length === 0, `each of the ${pages.length} Settings pages → its own part (wrong: ${wrong.join("; ") || "none"})`);

  console.log("4. A link in the help opens that part of the guide in the help");
  await settings(page, "team");
  await page.click("#open-help");
  await page.waitForSelector("#help-dialog[open] #help-body section#settings-team");
  await page.click('#help-body a[href="#permissions"]');
  await page.waitForSelector("#help-body section#permissions");
  check(await page.isVisible("#help-body section#permissions table"), "Team → \"Who can do what\" shows the permissions table");
  await page.click("#help-dialog button[type=submit]");
  await floor(page);

  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
