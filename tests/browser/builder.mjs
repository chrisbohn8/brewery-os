// Menu boards, step 3a: the board builder. A layout, what each beer shows and in what order (by the
// arrows and by dragging), sections in order, color schemes with a readability check, fonts (a
// pairing, or any Google Font by name, with a warning for a name Google doesn't have), a live
// preview as a TV, a phone, and paper; several boards for one taproom, each with its own link and
// look; removing a board stops its link. Real Chrome against the local Supabase test copy (port 8123).
// Makes its own taproom and tidies up after itself. Screenshots go to tests/browser/shots/.
import { chromium } from "playwright-core";
import { settings, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const ADMIN = "brewer1@example.test"; // admin of "Example Brewing"
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-5);
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Google Fonts is on the internet: the font checks need it (and are skipped, saying so, without it)
const online = await fetch("https://fonts.googleapis.com/css2?family=Oswald&display=swap").then((r) => r.ok).catch(() => false);

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
const asked = [];
await onDialog(page, (d) => { if (d.type() !== "alert") asked.push(d.message()); d.accept(); });
page.on("pageerror", (e) => errors.push(e.message));
const settle = async () => { await wait(150); await page.waitForFunction(() => !busy && !reloading); await wait(100); };
const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
// The preview, once it's drawn again after a change
const preview = async () => { await wait(400); return page.evaluate(() => {
  const mb = document.querySelector("#builder-frame .mb");
  return mb && { classes: mb.className, text: mb.textContent.replace(/\s+/g, " "), style: mb.getAttribute("style") || "",
    groups: [...mb.querySelectorAll(".mb-group-head h2")].map((h) => h.textContent), facts: mb.querySelector(".mb-facts")?.textContent || "",
    firstTitle: mb.querySelector(".mb-name")?.innerHTML || "" };
}); };
const partOrder = () => page.evaluate(() => [...document.querySelectorAll("#builder-parts li")].map((li) => li.dataset.part));

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

  // A taproom with two beers in two sections, and a cider (all put back at the end)
  saved = await page.evaluate(() => ({ sizes: data.menu.sizes, sections: data.menu.sections }));
  beers = await page.evaluate(async () => {
    const [a, b] = data.beers;
    const was = async (id) => (await db.from("beers").select("menu_prices, menu_short, menu_public, menu_abv, menu_ibu, menu_section").eq("id", id).single()).data;
    return [{ id: a.id, name: a.name, was: await was(a.id) }, { id: b.id, name: b.name, was: await was(b.id) }];
  });
  placeId = await page.evaluate(async ([run, a, b]) => {
    await db.from("breweries").update({ menu_sizes: [{ id: `bb-pint-${run}`, name: "16 oz", oz: 16 }],
      menu_sections: [{ id: `bb-hoppy-${run}`, name: "Hoppy" }, { id: `bb-dark-${run}`, name: "Dark" }] }).eq("id", brewery.id);
    const place = (await db.from("stock_places").insert({ brewery_id: brewery.id, name: `Builder taproom ${run}`, kind: "taproom" }).select("id").single()).data.id;
    await db.from("beers").update({ menu_short: `Bright ${run}`, menu_public: true, menu_abv: 6.5, menu_ibu: 45, menu_section: `bb-hoppy-${run}`,
      menu_prices: [{ size: `bb-pint-${run}`, price: 7 }] }).eq("id", a);
    await db.from("beers").update({ menu_public: true, menu_abv: 8, menu_ibu: 30, menu_section: `bb-dark-${run}`,
      menu_prices: [{ size: `bb-pint-${run}`, price: 8 }] }).eq("id", b);
    await must(db.from("draft_lines").insert([{ brewery_id: brewery.id, place_id: place, line_no: 1, status: "beer", beer_id: a, label: "" },
      { brewery_id: brewery.id, place_id: place, line_no: 2, status: "beer", beer_id: b, label: "" },
      { brewery_id: brewery.id, place_id: place, line_no: 3, status: "other", beer_id: null, label: `Cider ${run}` }]));
    await refresh();
    return place;
  }, [run, beers[0].id, beers[1].id]);

  console.log("1. The builder opens with a live preview");
  await settings(page, "menu");
  await page.click(`#board-list [data-board="new:${placeId}"] [data-board-edit]`);
  await page.waitForSelector("#board-builder[open] #builder-frame .mb-tv");
  let p = await preview();
  check(p.text.includes(beers[0].name) && p.text.includes(`Cider ${run}`) && p.text.includes("$7"), "the TV preview shows the taproom's menu");
  check(p.classes.includes("mb-layout-list"), "a new board starts as the classic list");
  await page.screenshot({ path: `${SHOTS}builder-start.png` });

  console.log("2. Layout");
  await page.click('#builder-layouts [data-layout="cards"]');
  p = await preview();
  check(p.classes.includes("mb-layout-cards") && await page.getAttribute('#builder-layouts [data-layout="cards"]', "aria-checked") === "true", "Cards: the preview changes at once");

  console.log("3. What each beer shows, and in what order");
  await page.uncheck('#builder-parts [data-part="ibu"] [data-part-on]');
  p = await preview();
  check(!p.text.includes("45 IBU") && p.text.includes("6.5%"), "unticking IBU hides it");
  check(await page.isDisabled('#builder-parts [data-part="name"] [data-part-on]'), "the name can't be hidden");
  await page.click('#builder-parts [data-part="abv"] [data-move="up"]'); // ABV before Style
  p = await preview();
  check(p.facts.startsWith("6.5%"), `the arrows put ABV before the style ("${p.facts}")`);
  check(await page.isDisabled('#builder-parts li:first-child [data-move="up"]'), "the first one's up arrow is off");
  // Drag "Tags" to the top by its handle, like a finger would
  const handle = await page.locator('#builder-parts [data-part="tags"] .handle').boundingBox();
  const top = await page.locator("#builder-parts li:first-child").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, top.y + 4, { steps: 8 });
  await page.mouse.up();
  check((await partOrder())[0] === "tags", `dragging moves Tags to the top (${(await partOrder()).slice(0, 3).join(", ")})`);

  console.log("4. Sections in order");
  await page.selectOption('#board-form [name="orderBy"]', "sections");
  p = await preview();
  check(p.groups.slice(0, 2).join(",") === "Hoppy,Dark", `by section, in the brewery's order (${p.groups.join(", ")})`);
  await page.click(`#builder-sections [data-section="bb-dark-${run}"] [data-move="up"]`);
  p = await preview();
  check(p.groups.slice(0, 2).join(",") === "Dark,Hoppy", `this board's own order (${p.groups.join(", ")})`);

  console.log("5. Colors, with a readability check");
  await page.selectOption("#builder-scheme", "chalkboard");
  p = await preview();
  check(p.style.includes("--mb-bg:#1f2b24") && /Easy to read/.test(await page.textContent("#builder-contrast")), "Chalkboard: the preview's colors, and it's easy to read");
  await page.selectOption("#builder-scheme", "custom");
  check(await page.isVisible("#builder-custom-colors"), "My own colors: three color pickers");
  await page.evaluate(() => { const f = document.getElementById("board-form"); f.bg.value = "#777777"; f.text.value = "#888888"; f.accent.value = "#999999"; f.bg.dispatchEvent(new Event("input", { bubbles: true })); });
  await wait(300);
  check(/Hard to read/.test(await page.textContent("#builder-contrast")), `grey on grey: "${await page.textContent("#builder-contrast")}"`);
  await page.evaluate(() => { const f = document.getElementById("board-form"); f.bg.value = "#101820"; f.text.value = "#fefefe"; f.accent.value = "#ffb000"; f.bg.dispatchEvent(new Event("input", { bubbles: true })); });
  p = await preview();
  check(p.style.includes("--mb-bg:#101820") && /Easy to read/.test(await page.textContent("#builder-contrast")), "my own readable colors, in the preview");

  console.log("6. Fonts");
  await page.selectOption("#builder-pairs", "taproom");
  check(await page.inputValue('#board-form [name="head"]') === "Oswald" && await page.inputValue('#board-form [name="body"]') === "Roboto", "a pairing fills in both fonts");
  p = await preview();
  check(p.style.includes("Oswald"), "the preview uses them");
  if (online) {
    await page.waitForFunction(() => document.fonts.check('700 16px "Oswald"'), null, { timeout: 8000 }).catch(() => {});
    check(await page.evaluate(() => document.fonts.check('700 16px "Oswald"')), "the font is loaded from Google Fonts");
    await page.fill('#board-form [name="head"]', `Notafont Xyzzy`);
    await page.press('#board-form [name="head"]', "Tab");
    await page.waitForFunction(() => /doesn't have a font/.test(document.getElementById("builder-font-note").textContent), null, { timeout: 8000 }).catch(() => {});
    check(/doesn't have a font called "Notafont Xyzzy"/.test(await page.textContent("#builder-font-note")), "a name Google doesn't have: the builder says so");
    check(await page.inputValue("#builder-pairs") === "", "and the pairing shows 'Your own choice'");
    await page.fill('#board-form [name="head"]', "Bebas Neue");
    await page.press('#board-form [name="head"]', "Tab");
    await wait(1500);
    check(await page.textContent("#builder-font-note") === "", "any Google Font by name (Bebas Neue): no warning");
  } else console.log("  (skipped the Google Fonts checks: no internet)");

  console.log("7. Phone and paper previews");
  await page.click('[data-builder-as="public"]');
  await page.waitForSelector("#builder-frame .mb-public");
  check(await page.evaluate(() => document.querySelector("#builder-frame .mb").getAttribute("style").includes("--mb-bg:#101820")), "the phone preview has the board's colors");
  await page.click('[data-builder-as="print"]');
  await page.waitForSelector("#builder-frame .mb-print");
  check(await page.evaluate(() => !document.querySelector("#builder-frame .mb").getAttribute("style")?.includes("--mb-bg")), "paper stays black on white");
  await page.click('[data-builder-as="tv"]');
  await page.fill('#board-form [name="name"]', `TV 1 ${run}`);
  await page.fill('#board-form [name="title"]', `On tap ${run}`);
  await page.screenshot({ path: `${SHOTS}builder-styled.png` });

  console.log("8. Save, and the TV shows the look");
  await page.click("#board-form button[type=submit]");
  await settle();
  const board1 = await page.evaluate((id) => data.boards.find((b) => b.placeId === id), placeId);
  check(board1?.layout === "cards" && board1.theme.scheme === "custom" && board1.parts[0] === "tags" && !board1.parts.includes("ibu") && board1.orderBy === "sections",
    "saved: layout, colors, parts, and order");
  const card1 = `#board-list [data-board="${board1.id}"]`;
  check(/Cards · My own colors/.test(await page.textContent(`${card1} .board-summary`)), `the board's summary: "${await page.textContent(`${card1} .board-summary`)}"`);
  await page.click(`${card1} [data-link="tv"] [data-board-link="new"]`);
  await settle();
  const tv1Url = await page.inputValue(`${card1} [data-link="tv"] .board-url`);
  const tv = await tvContext.newPage();
  await tv.goto(tv1Url);
  await tv.waitForSelector("#board .mb-tv.mb-layout-cards");
  const tvLook = await tv.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, text: document.getElementById("board").textContent,
    fits: document.querySelector(".mb").scrollHeight <= innerHeight }));
  check(tvLook.bg === "rgb(16, 24, 32)" && tvLook.text.includes(`On tap ${run}`) && tvLook.fits, `the TV: cards, my colors around the board too, and it fits (${tvLook.bg})`);
  if (online) {
    await tv.waitForFunction(() => document.fonts.check('16px "Bebas Neue"') && document.fonts.check('16px "Roboto"'), null, { timeout: 10000 }).catch(() => {});
    const used = await tv.evaluate(() => ({ head: getComputedStyle(document.querySelector(".mb-head h1")).fontFamily, body: getComputedStyle(document.querySelector(".mb")).fontFamily,
      loaded: document.fonts.check('16px "Bebas Neue"') && document.fonts.check('16px "Roboto"') }));
    const first = (f) => f.split(",")[0].replace(/"/g, "").trim(); // (the browser writes "Roboto" without quotes)
    check(used.loaded && first(used.head) === "Bebas Neue" && first(used.body) === "Roboto", `the TV loads the board's fonts (${used.head.split(",")[0]} / ${used.body.split(",")[0]})`);
    await wait(500); // (the text is sized again once the fonts are in)
  }
  await tv.screenshot({ path: `${SHOTS}builder-tv.png` });

  console.log("9. A second board for the same taproom");
  await page.click(`#board-list [data-taproom="${placeId}"] [data-board-add]`);
  await page.waitForSelector("#board-builder[open]");
  check(await page.inputValue('#board-form [name="name"]') === "TV 2", "suggested name: TV 2");
  await page.fill('#board-form [name="name"]', `TV 2 ${run}`);
  await page.uncheck('#board-form [name="showOnTap"]');
  await page.uncheck('#board-form [name="showComingSoon"]');
  await page.uncheck('#board-form [name="showToGo"]');
  await page.click("#board-form button[type=submit]");
  await wait(400);
  check(await page.isVisible("#board-builder[open]"), "a board with nothing on it isn't saved");
  await page.check('#board-form [name="showToGo"]');
  await page.click('#builder-layouts [data-layout="compact"]');
  await page.click("#board-form button[type=submit]");
  await settle();
  const boards = await page.evaluate((id) => data.boards.filter((b) => b.placeId === id), placeId);
  check(boards.length === 2 && boards[1].layout === "compact" && !boards[1].showOnTap && boards[1].showToGo, "two boards, each with its own settings");
  const card2 = `#board-list [data-board="${boards[1].id}"]`;
  await page.click(`${card2} [data-link="tv"] [data-board-link="new"]`);
  await settle();
  const tv2Url = await page.inputValue(`${card2} [data-link="tv"] .board-url`);
  check(tv2Url !== tv1Url, "its own TV link");

  console.log("10. Removing a board stops its link");
  await page.click(`${card2} [data-board-edit]`);
  await page.waitForSelector("#board-builder[open]");
  await page.click("#delete-board");
  await settle();
  check(asked.some((m) => /Remove the board/.test(m)) && !(await page.isVisible(card2)) && await page.isVisible(card1), "asked first; the board is gone, the first one stays");
  const tv2 = await tvContext.newPage();
  await tv2.goto(tv2Url);
  await tv2.waitForSelector("#board .note");
  check(/turned off or replaced/.test(await tv2.textContent("#board")), "its link shows nothing");

  console.log("11. On a phone, the builder puts the preview on top");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click(`${card1} [data-board-edit]`);
  await page.waitForSelector("#board-builder[open] #builder-frame .mb");
  const phone = await page.evaluate(() => ({ previewFirst: document.querySelector(".builder-preview").getBoundingClientRect().top < document.querySelector(".builder-controls").getBoundingClientRect().top,
    sideways: document.getElementById("board-builder").scrollWidth > document.getElementById("board-builder").clientWidth + 1 }));
  const wide = await page.evaluate(() => { const d = document.getElementById("board-builder"); const w = d.getBoundingClientRect().right;
    return [...d.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > w + 1 && el.offsetParent).slice(0, 4)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${[...el.classList].join(".")} (${Math.round(el.getBoundingClientRect().right)} > ${Math.round(w)})`); });
  check(phone.previewFirst && !phone.sideways, `preview first, no sideways scrolling${wide.length ? ` (too wide: ${wide.join(", ")})` : ""}`);
  await page.screenshot({ path: `${SHOTS}builder-phone.png` });
  await page.click("#board-builder .cancel");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}builder-crash.png` }).catch(() => {});
} finally {
  if (placeId) {
    await page.evaluate(async ([place, saved, beers]) => {
      await db.from("draft_lines").delete().eq("place_id", place);
      await db.from("menu_boards").delete().eq("place_id", place);
      await db.from("stock_places").delete().eq("id", place);
      await db.from("breweries").update({ menu_sizes: saved.sizes, menu_sections: saved.sections }).eq("id", brewery.id);
      for (const b of beers) await db.from("beers").update(b.was).eq("id", b.id);
    }, [placeId, saved, beers]).catch((e) => console.log("tidy-up failed:", e.message));
  }
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
