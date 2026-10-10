// Menu boards, step 3b: the brewery's own fonts and logos. An Admin uploads a font and a logo
// (Settings → Menu → Fonts and logos); a board uses them (the builder's Logo and Fonts); the TV shows
// them without signing in, keeps them for no signal; a backup carries them; removing one asks first.
// Real Chrome against the local Supabase test copy (port 8123). Makes its own taproom and tidies up.
// The font is a real one, fetched from Google Fonts while the test runs (kept in memory only).
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { settings, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const ADMIN = "brewer1@example.test"; // admin of "Example Brewing"
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-5);
const FONT = `House Font ${run}`;
const LOGO = `Logo ${run}`;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A real font file (Pacifico, a free Google Font) and a small logo
let fontFile = null;
try {
  const css = await (await fetch("https://fonts.googleapis.com/css2?family=Pacifico&display=swap", { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" } })).text();
  // (Google splits a font by alphabet; the Latin part, with English letters, comes last)
  const url = [...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].at(-1)?.[1];
  if (url) fontFile = Buffer.from(await (await fetch(url)).arrayBuffer());
} catch {}
const logoFile = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80">
  <rect width="240" height="80" rx="12" fill="#f0a050"/><text x="120" y="52" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#111">LOGO</text></svg>`);

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const asked = [];
let answer = null; // what to type into the next question
await onDialog(page, (d) => { if (d.type() !== "alert") asked.push(d.message()); d.accept(d.type() === "prompt" && answer != null ? answer : undefined); });
page.on("pageerror", (e) => errors.push(e.message));
const settle = async () => { await wait(150); await page.waitForFunction(() => !busy && !reloading); await wait(100); };
async function upload(kind, name, file) {
  answer = name;
  const chooser = page.waitForEvent("filechooser");
  await page.click(`#${kind}-upload-btn`);
  await (await chooser).setFiles(file);
  await settle();
  answer = null;
}

let placeId = null;
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
  placeId = await page.evaluate(async ([run]) => {
    const place = (await db.from("stock_places").insert({ brewery_id: brewery.id, name: `Files taproom ${run}`, kind: "taproom" }).select("id").single()).data.id;
    await must(db.from("draft_lines").insert([{ brewery_id: brewery.id, place_id: place, line_no: 1, status: "beer", beer_id: data.beers[0].id, label: "" }]));
    await refresh();
    return place;
  }, [run]);

  console.log("1. Uploading a font and a logo");
  await settings(page, "menu");
  check(await page.isVisible("#font-upload-btn") && /right to use/.test(await page.textContent("#font-files-note")), "an Admin can upload a font, and is told to check its license");
  answer = "x";
  const tooBig = page.waitForEvent("filechooser");
  await page.click("#logo-upload-btn");
  await (await tooBig).setFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(400 * 1024, 1) });
  await wait(400);
  check(!(await page.evaluate(() => data.files.some((f) => f.name === "x"))), "a logo over 300 KB isn't uploaded");
  await upload("logo", LOGO, { name: "our-logo.svg", mimeType: "image/svg+xml", buffer: logoFile });
  check(await page.evaluate((n) => data.files.some((f) => f.kind === "logo" && f.name === n), LOGO), "the logo is uploaded");
  await page.waitForFunction(() => document.querySelector("#logo-files img.file-thumb")?.src.startsWith("data:image/svg+xml"), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => !!document.querySelector("#logo-files img.file-thumb")?.src.startsWith("data:image/svg+xml")), "and shown in the list");
  if (fontFile) {
    await upload("font", FONT, { name: "pacifico.woff2", mimeType: "font/woff2", buffer: fontFile });
    check(await page.evaluate((n) => data.files.some((f) => f.kind === "font" && f.name === n), FONT), `the font is uploaded (${Math.round(fontFile.length / 1024)} KB)`);
    await page.waitForFunction((n) => document.fonts.check(`16px "${n}"`) && [...document.fonts].some((f) => f.family.replace(/"/g, "") === n && f.status === "loaded"), FONT, { timeout: 5000 }).catch(() => {});
    check(await page.evaluate((n) => [...document.fonts].some((f) => f.family.replace(/"/g, "") === n && f.status === "loaded"), FONT), "and its name is shown in the font itself");
  } else console.log("  (skipped the font upload: couldn't fetch a font from Google Fonts)");

  console.log("2. A board uses them");
  await page.click(`#board-list [data-board="new:${placeId}"] [data-board-edit]`);
  await page.waitForSelector("#board-builder[open] #builder-frame .mb");
  const logoId = await page.evaluate((n) => data.files.find((f) => f.name === n).id, LOGO);
  await page.selectOption("#builder-logo", logoId);
  if (fontFile) { await page.fill('#board-form [name="head"]', FONT); await page.press('#board-form [name="head"]', "Tab"); }
  await page.waitForFunction(() => document.querySelector("#builder-frame img.mb-logo")?.src.startsWith("data:"), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => !!document.querySelector("#builder-frame img.mb-logo")?.src.startsWith("data:image/svg+xml")), "the preview shows the logo beside the title");
  if (fontFile) {
    await wait(500);
    check(await page.textContent("#builder-font-note") === "" &&
      (await page.evaluate(() => getComputedStyle(document.querySelector("#builder-frame .mb-head h1")).fontFamily)).includes(FONT), "and the title in the uploaded font (no 'Google doesn't have it' warning)");
  }
  await page.screenshot({ path: `${SHOTS}board-files-builder.png` });
  await page.click("#board-form button[type=submit]");
  await settle();
  const board = await page.evaluate((id) => data.boards.find((b) => b.placeId === id), placeId);
  check(board?.theme.logo === logoId, "saved with the logo");
  check(/Logo .* · on Menu board/.test((await page.textContent("#logo-files")).replace(/\s+/g, " ")), `the list says which board uses it: "${(await page.textContent("#logo-files")).replace(/\s+/g, " ").trim()}"`);

  console.log("3. The TV shows them, and keeps them for no signal");
  await page.click(`#board-list [data-board="${board.id}"] [data-link="tv"] [data-board-link="new"]`);
  await settle();
  const tvUrl = await page.inputValue(`#board-list [data-board="${board.id}"] [data-link="tv"] .board-url`);
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const tvErrors = [];
  tv.on("pageerror", (e) => tvErrors.push(e.message));
  await tv.goto(tvUrl);
  await tv.waitForFunction(() => document.querySelector("#board img.mb-logo")?.complete && document.querySelector("#board img.mb-logo").naturalWidth > 0, null, { timeout: 10000 }).catch(() => {});
  check(await tv.evaluate(() => document.querySelector("#board img.mb-logo")?.naturalWidth > 0), "the TV shows the logo, without signing in");
  if (fontFile) {
    await tv.waitForFunction((n) => [...document.fonts].some((f) => f.family.replace(/"/g, "") === n && f.status === "loaded"), FONT, { timeout: 8000 }).catch(() => {});
    check(await tv.evaluate((n) => [...document.fonts].some((f) => f.family.replace(/"/g, "") === n && f.status === "loaded"), FONT), "and the uploaded font");
  }
  await wait(600);
  await tv.screenshot({ path: `${SHOTS}board-files-tv.png` });
  await tv.route("**/rest/v1/rpc/**", (route) => route.abort());
  await tv.reload();
  await tv.waitForFunction(() => document.querySelector("#board img.mb-logo")?.naturalWidth > 0, null, { timeout: 10000 }).catch(() => {});
  check(await tv.evaluate(() => document.querySelector("#board img.mb-logo")?.naturalWidth > 0), "with no signal, the kept copy still has the logo");
  await tv.unroute("**/rest/v1/rpc/**");

  console.log("4. A backup carries them");
  const downloading = page.waitForEvent("download");
  await settings(page, "backup");
  await page.click("#export-data");
  const backup = JSON.parse(readFileSync(await (await downloading).path(), "utf8"));
  const kept = (backup.data.files || []).find((f) => f.name === LOGO);
  check(kept?.data?.length > 100 && kept.mime === "image/svg+xml", "the backup file has the logo itself, not just its name");

  console.log("5. Removing the logo asks first, and the board shows none");
  await settings(page, "menu");
  await page.click(`#logo-files [data-remove-file="${logoId}"]`);
  await settle();
  check(asked.some((m) => m.includes(`Remove the logo "${LOGO}"`) && /which will show no logo/.test(m)), "asked, saying which board uses it");
  check(!(await page.evaluate((id) => data.files.some((f) => f.id === id), logoId)), "it's gone");
  await tv.waitForFunction(() => !document.querySelector("#board img.mb-logo"), null, { timeout: 25000 }).catch(() => {});
  check(!(await tv.evaluate(() => !!document.querySelector("#board img.mb-logo"))), "the TV drops it on its next update");
  check(errors.length === 0 && tvErrors.length === 0, `no page errors (${[...errors, ...tvErrors].join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}board-files-crash.png` }).catch(() => {});
} finally {
  await page.evaluate(async ([place, names]) => {
    if (place) {
      await db.from("draft_lines").delete().eq("place_id", place);
      await db.from("menu_boards").delete().eq("place_id", place);
      await db.from("stock_places").delete().eq("id", place);
    }
    await db.from("brewery_files").delete().eq("brewery_id", brewery.id).in("name", names);
  }, [placeId, [FONT, LOGO, "x"]]).catch((e) => console.log("tidy-up failed:", e.message));
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
