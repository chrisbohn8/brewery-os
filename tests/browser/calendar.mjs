// The planning calendar: a beer's schedule; planning a brew in a tank lays out its expected steps;
// a second brew in the same tank too soon is a clash, shown before it happens; moving an item,
// ticking it done, someday plans, and deleting. Real Chrome against the local test copy.
import { chromium } from "playwright-core";
import { floor, onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-4).toUpperCase();
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
await onDialog(page, (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const settle = () => page.waitForFunction(() => !busy && !sending && !reloading);
const plusDays = (n) => page.evaluate((k) => addDays(today(), k), n);
const chips = (sel = "#cal-grid") => page.evaluate((s) => [...document.querySelectorAll(`${s} .cal-chip`)].map((c) => ({
  text: c.textContent.trim(), cls: c.className, tank: c.closest("[data-cell-tank]")?.dataset.cellTank, date: c.closest("[data-cell-date]")?.dataset.cellDate,
})), sel);

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
  await settle();

  console.log("Setup: a beer and an empty tank for this test");
  const BEER = `Cal Lager ${run}`, TANK = `C-${run}`;
  const ids = await page.evaluate(async ([beer, tank]) => {
    const beerId = newId(), tankId = newId();
    await save(async () => {
      await must(db.from("beers").insert({ id: beerId, brewery_id: brewery.id, code: `cal-${tank.toLowerCase()}`, name: beer }));
      await must(db.from("tanks").insert({ id: tankId, brewery_id: brewery.id, name: tank, capacity_bbl: 10, location_id: data.locations[0].id }));
    });
    return { beerId, tankId };
  }, [BEER, TANK]);

  console.log("1. The calendar: tanks down the side, days across the top");
  await page.click("#open-calendar");
  await page.waitForSelector("#calendar-view:not([hidden])");
  check(await page.textContent("#view-title") === "Calendar", "the Calendar screen opens from the tank board");
  const heads = await page.$$eval(".cal-head", (h) => h.length);
  check(heads === 4, `a phone shows three days (${heads - 1})`);
  check((await page.textContent("#cal-grid")).includes("Whole brewery") && (await page.textContent("#cal-grid")).includes(TANK),
    "a row for the whole brewery and one per tank");

  console.log("2. A beer's schedule");
  await page.click("#cal-schedules");
  await page.waitForSelector("#schedule-editor[open]");
  await page.selectOption("#schedule-form [name=beerId]", ids.beerId);
  for (const [kind, day] of [["dry_hop", "5"], ["package", "12"]]) {
    await page.click("#add-step");
    await page.selectOption("#schedule-steps li:last-child select", kind);
    await page.fill("#schedule-steps li:last-child input", day);
  }
  await page.click("#save-schedule");
  await settle();
  check((await page.evaluate((b) => data.schedules[b].map((s) => `${s.kind}@${s.day}`).join(" "), ids.beerId)) === "dry_hop@5 package@12",
    "saved: dry hop on day 5, package on day 12");
  await page.click("#schedule-editor .cancel");

  console.log("3. Plan a brew in the tank tomorrow: its steps show as expected");
  const tomorrow = await plusDays(1);
  await page.click(`[data-cell-tank="${ids.tankId}"][data-cell-date="${tomorrow}"]`);
  await page.waitForSelector("#plan-editor[open]");
  check(await page.inputValue("#plan-form [name=tankId]") === ids.tankId && await page.inputValue("#plan-form [name=plannedOn]") === tomorrow,
    "tapping a square fills in its tank and day");
  await page.selectOption("#plan-form [name=beerId]", ids.beerId);
  await page.click("#save-plan");
  await settle();
  let found = await chips();
  check(found.some((c) => c.tank === ids.tankId && c.date === tomorrow && c.text === `Brew day: ${BEER}` && !c.cls.includes("clash")),
    "the brew is on the calendar, in its tank and day");
  await page.click("#cal-next");
  await page.click("#cal-next");
  found = await chips();
  check(found.some((c) => c.tank === ids.tankId && c.text === `Dry hop: ${BEER}` && c.cls.includes("expected")),
    "the dry hop shows 5 days after, in the tank, as expected");
  check(found.find((c) => c.text === `Dry hop: ${BEER}`)?.date === await plusDays(6), "on the right day");
  await page.screenshot({ path: SHOTS + "calendar-phone.png" });

  console.log("4. A second brew in the same tank too soon is a clash, shown before it happens");
  await page.click("#cal-today");
  const inThree = await plusDays(2);
  await page.click(`[data-cell-tank="${ids.tankId}"][data-cell-date="${inThree}"]`);
  await page.waitForSelector("#plan-editor[open]");
  await page.selectOption("#plan-form [name=beerId]", ids.beerId);
  await page.click("#save-plan");
  await settle();
  const second = (await chips()).find((c) => c.date === inThree && c.tank === ids.tankId);
  check(second?.cls.includes("clash"), `marked as a clash: "${second?.text}"`);
  await page.click(`[data-cell-date="${inThree}"][data-cell-tank="${ids.tankId}"] .cal-chip`);
  await page.waitForSelector("#plan-editor[open]");
  const clash = await page.textContent("#plan-clash");
  check(clash.includes(`${TANK} is planned for ${BEER}`) && clash.includes("expected out"), `and says why: "${clash}"`);
  await page.click("#plan-editor .cancel");
  const label = page.locator(".cal-tank", { hasText: TANK });
  await label.scrollIntoViewIfNeeded();
  const box = await label.boundingBox();
  await page.screenshot({ path: SHOTS + "calendar-row.png", clip: { x: 0, y: box.y - 4, width: 390, height: box.height + 8 } });
  await page.click(`[data-cell-date="${inThree}"][data-cell-tank="${ids.tankId}"] .cal-chip`);
  await page.waitForSelector("#plan-editor[open]");

  console.log("5. Move it after the first one's packaging: no clash");
  const later = await plusDays(15);
  await page.fill("#plan-form [name=plannedOn]", later);
  await page.click("#save-plan");
  await settle();
  const moved = await page.evaluate(([t, d]) => data.planItems.find((p) => p.tankId === t && p.plannedOn === d), [ids.tankId, later]);
  check(!!moved && !(await page.evaluate((id) => planClash(data.planItems.find((p) => p.id === id)), moved.id)), "moved, and no longer a clash");

  console.log("6. Someday plans, and ticking one done");
  await page.click("#cal-add");
  await page.waitForSelector("#plan-editor[open]");
  await page.selectOption("#plan-form [name=beerId]", ids.beerId);
  await page.check('#plan-form [name=when][value="someday"]');
  await page.fill("#plan-form [name=someday]", "Fall");
  await page.click("#save-plan");
  await settle();
  check((await page.textContent("#cal-someday")).includes(`Fall · Brew day: ${BEER}`), "a someday plan is listed above the week");
  await page.click("#cal-someday .cal-chip");
  await page.waitForSelector("#plan-editor[open]");
  await page.check("#plan-form [name=done]");
  await page.click("#save-plan");
  await settle();
  check((await chips("#cal-someday"))[0]?.cls.includes("done"), "ticked done, it's crossed out");

  console.log("7. Delete");
  await page.click("#cal-someday .cal-chip");
  await page.waitForSelector("#plan-editor[open]");
  await page.click("#delete-plan");
  await page.waitForFunction(() => !document.getElementById("plan-editor").open, null, { timeout: 10000 });
  await settle();
  check(!(await page.textContent("#cal-someday")).includes("Fall"), "deleted");

  console.log("8. A computer shows the whole week");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForFunction(() => document.querySelectorAll(".cal-head").length === 8);
  check(true, "seven days");
  await page.screenshot({ path: SHOTS + "calendar-computer.png" });

  // Clean up
  await page.evaluate(async ([t, b]) => {
    await save(async () => {
      await must(db.from("plan_items").delete().eq("beer_id", b));
      await must(db.from("tanks").delete().eq("id", t));
      await must(db.from("beers").delete().eq("id", b));
    });
  }, [ids.tankId, ids.beerId]);
  await floor(page).catch(() => {});
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
