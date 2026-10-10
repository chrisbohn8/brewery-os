// Menu boards (step 2): a taproom's board in Settings → Menu → Menu boards. Its title (in the builder), a preview,
// print, and its links: the TV page (no sign-in) fills the screen, updates on its own, and keeps the
// last good copy with no signal; the public page leaves off staff-only beers; a replaced or
// turned-off link stops working. Real Chrome against the local Supabase test copy (port 8123).
// Makes its own taproom and tidies up after itself.
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
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] })).newPage();
const errors = [];
await onDialog(page, (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const settle = async () => { await wait(150); await page.waitForFunction(() => !busy && !reloading); await wait(100); };
// A TV: a separate browser with no sign-in, 1920 × 1080
const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const tvErrors = [];

let placeId = null, saved = null, beers = null;
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

  // A taproom with three lines: a beer with its menu, a staff-only beer, and a cider (all put back at the end)
  saved = await page.evaluate(() => data.menu.sizes);
  beers = await page.evaluate(async () => {
    const [a, b] = data.beers;
    const was = async (id) => (await db.from("beers").select("menu_prices, menu_short, menu_public").eq("id", id).single()).data;
    return [{ id: a.id, name: a.name, was: await was(a.id) }, { id: b.id, name: b.name, was: await was(b.id) }];
  });
  placeId = await page.evaluate(async ([run, a, b]) => {
    await db.from("breweries").update({ menu_sizes: [{ id: `bd-pint-${run}`, name: "16 oz", oz: 16 }] }).eq("id", brewery.id);
    const place = (await db.from("stock_places").insert({ brewery_id: brewery.id, name: `Board taproom ${run}`, kind: "taproom" }).select("id").single()).data.id;
    await db.from("beers").update({ menu_short: `Bright ${run}`, menu_public: true, menu_prices: [{ size: `bd-pint-${run}`, price: 7, at: { [place]: 8 } }] }).eq("id", a);
    await db.from("beers").update({ menu_public: false }).eq("id", b);
    await must(db.from("draft_lines").insert([{ brewery_id: brewery.id, place_id: place, line_no: 1, status: "beer", beer_id: a, label: "" },
      { brewery_id: brewery.id, place_id: place, line_no: 2, status: "beer", beer_id: b, label: "" },
      { brewery_id: brewery.id, place_id: place, line_no: 3, status: "other", beer_id: null, label: `Cider ${run}` }]));
    await refresh();
    return place;
  }, [run, beers[0].id, beers[1].id]);

  console.log("1. The board's settings");
  await settings(page, "menu");
  // (a taproom with no board yet shows the one it would have; it's saved with its first change)
  check(await page.isVisible(`#board-list [data-board="new:${placeId}"]`), "a board for the taproom");
  await page.click(`#board-list [data-board="new:${placeId}"] [data-board-edit]`);
  await page.waitForSelector("#board-builder[open]");
  await page.fill('#board-form [name="title"]', `On tap ${run}`);
  await page.click("#board-form button[type=submit]");
  await settle();
  const boardId = await page.evaluate((id) => data.boards.find((b) => b.placeId === id && b.title)?.id, placeId);
  check(!!boardId && await page.evaluate((id) => data.boards.find((b) => b.id === id).title, boardId) === `On tap ${run}`, "the title saved");
  const card = `#board-list [data-board="${boardId}"]`;

  console.log("2. Preview and print");
  await page.click(`${card} [data-board-preview]`);
  await page.waitForSelector("#board-preview[open] #board-preview-frame .mb-tv");
  let shown = await page.textContent("#board-preview-frame");
  check(shown.includes(`On tap ${run}`) && shown.includes(beers[0].name) && shown.includes(beers[1].name) && shown.includes("$8"),
    "the TV preview: the title, both beers, and this taproom's own price");
  check(await page.evaluate(() => { const f = document.getElementById("board-preview-frame"); return f.querySelector(".mb").scrollHeight <= f.clientHeight; }), "it fits the frame");
  await page.click('[data-preview-as="public"]');
  await page.waitForSelector("#board-preview-frame .mb-public");
  shown = await page.textContent("#board-preview-frame");
  check(shown.includes(beers[0].name) && !shown.includes(beers[1].name), "the public preview leaves off the staff-only beer");
  await page.click("#board-preview button[type=submit]");
  await page.evaluate(() => { window.printed = 0; window.print = () => { window.printed++; }; });
  await page.click(`${card} [data-board-print]`);
  await page.waitForFunction(() => window.printed === 1);
  check((await page.textContent("#print-sheet")).includes(`Cider ${run}`) && await page.evaluate(() => !!document.querySelector("#print-sheet .mb-print")), "Print: the board, on paper");

  console.log("3. The TV link");
  await page.click(`${card} [data-link="tv"] [data-board-link="new"]`);
  await settle();
  const tvUrl = await page.inputValue(`${card} [data-link="tv"] .board-url`);
  check(/board\.html#t=tv_/.test(tvUrl), `a TV link (${tvUrl.slice(0, 50)}…)`);
  await page.click(`${card} [data-link="tv"] [data-board-copy="url"]`);
  check(await page.evaluate(() => navigator.clipboard.readText()) === tvUrl, "Copy puts the link on the clipboard");
  const tv = await tvContext.newPage();
  tv.on("pageerror", (e) => tvErrors.push(e.message));
  await tv.goto(tvUrl);
  await tv.waitForSelector("#board .mb-tv");
  const tvText = await tv.textContent("#board");
  check(tvText.includes(`On tap ${run}`) && tvText.includes(beers[1].name) && tvText.includes(`Bright ${run}`), "the TV shows the board, without signing in (short lines, staff-only beers too)");
  const fits = await tv.evaluate(() => ({ scroll: document.documentElement.scrollHeight, height: innerHeight, font: parseFloat(document.getElementById("board").style.fontSize) }));
  check(fits.scroll <= fits.height && fits.font >= 30, `it fills the screen without scrolling (text ${fits.font.toFixed(0)}px)`);

  console.log("4. A change shows on the TV by itself");
  await page.evaluate(async ([id, run]) => { await db.from("beers").update({ menu_short: `Now hazier ${run}` }).eq("id", id); }, [beers[0].id, run]);
  await tv.waitForFunction((t) => document.getElementById("board").textContent.includes(t), `Now hazier ${run}`, { timeout: 25000 }).catch(() => {});
  check((await tv.textContent("#board")).includes(`Now hazier ${run}`), "within 15 seconds or so, with no one touching the TV");

  console.log("5. No signal: the TV keeps the menu up");
  await tv.route("**/rest/v1/rpc/**", (route) => route.abort());
  await wait(16000);
  check((await tv.textContent("#board")).includes(`Now hazier ${run}`), "after a failed update, the menu stays on screen");
  await tv.reload();
  await tv.waitForSelector("#board .mb-tv", { timeout: 10000 }).catch(() => {});
  check((await tv.textContent("#board")).includes(`Now hazier ${run}`), "and after a reload with no signal, the copy kept on the TV shows");
  await tv.unroute("**/rest/v1/rpc/**");

  console.log("6. The public link");
  await page.click(`${card} [data-link="public"] [data-board-link="new"]`);
  await settle();
  const publicUrl = await page.inputValue(`${card} [data-link="public"] .board-url`);
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.goto(publicUrl);
  await phone.waitForSelector("#board .mb-public");
  const pub = await phone.textContent("#board");
  check(pub.includes(beers[0].name) && !pub.includes(beers[1].name) && pub.includes("16 oz") && pub.includes("$8"), "the public page: the menu, without the staff-only beer");
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone-width, no sideways scrolling");
  await page.click(`${card} [data-link="public"] [data-board-copy="embed"]`);
  check((await page.evaluate(() => navigator.clipboard.readText())).startsWith(`<iframe src="${publicUrl}"`), "Copy embed code: an iframe for a website");

  console.log("7. A new link stops the old one; Turn off stops it too");
  await page.click(`${card} [data-link="tv"] [data-board-link="new"]`);
  await settle();
  check(await page.inputValue(`${card} [data-link="tv"] .board-url`) !== tvUrl, "a new TV link");
  await tv.reload();
  await tv.waitForSelector("#board .note");
  check(/turned off or replaced/.test(await tv.textContent("#board")), "the old TV link says it's been replaced (and the kept copy is cleared)");
  await page.click(`${card} [data-link="public"] [data-board-link="off"]`);
  await settle();
  await phone.reload();
  await phone.waitForSelector("#board .note");
  check(/turned off or replaced/.test(await phone.textContent("#board")) && await page.isVisible(`${card} [data-link="public"] [data-board-link="new"]`),
    "the public link is off (and can be made again)");

  console.log("8. A TV fits 8 to 30 lines");
  const sizes = [];
  for (const n of [8, 30]) {
    await tv.goto(`${APP}board.html`);
    sizes.push(await tv.evaluate((n) => {
      const board = { title: "Fit test", brewery: "Test", order: "lines", public: false, sizes: [{ id: "p", name: "16 oz" }, { id: "h", name: "10 oz" }], sections: [],
        lines: Array.from({ length: n }, (_, i) => ({ no: i + 1, kind: "beer", beer: { name: `A beer with a longish name ${i + 1}`, style: "West Coast IPA", abv: 6.8, ibu: 60,
          short: "Pine, grapefruit, and a dry finish", tags: [{ name: "New", kind: "badge" }], prices: [{ size: "p", price: 7 }, { size: "h", price: 5 }] } })),
        coming_soon: [{ name: "Stout" }], to_go: [] };
      const box = document.getElementById("board");
      box.className = "tv";
      box.innerHTML = BoardView.render(board, "tv");
      BoardView.fit(box);
      const mb = box.querySelector(".mb");
      return { fits: mb.scrollHeight <= box.clientHeight && mb.scrollWidth <= box.clientWidth, font: parseFloat(box.style.fontSize) };
    }, n));
  }
  check(sizes.every((s) => s.fits) && sizes[0].font >= 30 && sizes[1].font >= 16,
    `8 lines and 30 lines both fit, text readable across a room (${sizes.map((s) => s.font.toFixed(0) + "px").join(", ")})`);
  check(errors.length === 0 && tvErrors.length === 0, `no page errors (${[...errors, ...tvErrors].join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  if (placeId) {
    await page.evaluate(async ([place, sizes, beers]) => {
      await db.from("draft_lines").delete().eq("place_id", place);
      await db.from("menu_boards").delete().eq("place_id", place); // (no delete permission: the place's own delete takes it)
      await db.from("stock_places").delete().eq("id", place);
      await db.from("breweries").update({ menu_sizes: sizes }).eq("id", brewery.id);
      for (const b of beers) await db.from("beers").update(b.was).eq("id", b.id);
    }, [placeId, saved, beers]).catch((e) => console.log("tidy-up failed:", e.message));
  }
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
