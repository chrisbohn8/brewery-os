// Try it yourself (docs/demo-design.md): every job done the way a visitor would, by following the
// guidance (tap what pulses, fill in the form the hint points to), and each ticked off only once its
// record exists; the result is pointed at; the demo bar counts them. Also one job on a phone.
// Real Chrome against the local test copy. Deletes the demos it made.
import { chromium } from "playwright-core";
import { onDialog } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const made = [];

async function demo(width, height) {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  page.errors = [];
  await onDialog(page, (d) => d.accept());
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${APP}#demo`);
  await page.click("#try-demo");
  await page.waitForFunction(() => typeof DemoTour !== "undefined" && DemoTour.open, null, { timeout: 60000 });
  made.push(page);
  return page;
}
const hintText = (page) => page.evaluate(() => document.querySelector(".coach-hint .coach-text")?.textContent || "");

// What a brewer would type into each job's form
const FILL = {
  check: async (page) => {
    await page.fill('#cellar-form [name="gravity"]', "4.5");
    await page.fill('#cellar-form [name="ph"]', "4.32");
    await page.click('#cellar-form button[type="submit"]');
  },
  dryhop: async (page) => {
    const lot = await page.evaluate(() => rawLots(data.rawItems.find((i) => i.name === "Citra")).filter((l) => l.onHand > 5).at(-1)?.lot);
    await page.fill('#addition-form [name="name"]', "Citra");
    await page.fill('#addition-form [name="amount"]', "10");
    await page.fill('#addition-form [name="lot"]', lot);
    await page.click('#addition-form button[type="submit"]');
  },
  transfer: async (page) => {
    const brite = (await hintText(page)).match(/Choose (\S+) as the tank/)?.[1];
    const id = await page.evaluate((n) => data.tanks.find((t) => t.name === n)?.id, brite);
    await page.selectOption('#batch-form [name="tankId"]', id);
    await page.selectOption('#batch-form [name="stage"]', "carbonating");
    await page.click('#batch-form button[type="submit"]');
  },
  package: async (page) => {
    const first = page.locator("#package-rows input").first();
    await first.fill("40");
    await page.check('#package-form [name="spent"][value="yes"]').catch(() => page.locator('#package-form [name="spent"]').last().check());
    await page.click('#package-form button[type="submit"]');
  },
  bringup: async (page) => { await page.click('#stock-form button[type="submit"]'); },
  line: async (page) => {
    const beer = await page.evaluate(() => [...document.querySelectorAll('#line-form [name="beerId"] option')].map((o) => o.value).filter(Boolean).at(-1));
    await page.selectOption('#line-form [name="beerId"]', beer);
    await page.click('#line-form button[type="submit"]');
  },
  plan: async (page) => {
    await page.selectOption('#plan-form [name="kind"]', "brew");
    await page.evaluate(() => {
      const f = document.getElementById("plan-form");
      f.beerId.value = [...f.beerId.options].map((o) => o.value).filter(Boolean)[0];
      f.tankId.value = [...f.tankId.options].map((o) => o.value).filter(Boolean)[0];
      f.plannedOn.value = addDays(today(), 7);
      for (const el of [f.beerId, f.tankId, f.plannedOn]) el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click('#plan-form button[type="submit"]');
  },
};

// Follow the guidance for one job: tap what pulses until a form opens, fill it in, until it says done
async function doJob(page, id) {
  await page.evaluate(() => TryIt.open());
  await page.click(`#tryit-list [data-show="${id}"]`);
  const hints = [];
  for (let i = 0; i < 12; i++) {
    await wait(700);
    const text = await hintText(page);
    if (hints.at(-1) !== text) hints.push(text);
    if (/: done\./.test(text)) break;
    const formOpen = await page.evaluate(() => ["cellar-editor", "addition-editor", "batch-editor", "package-editor", "stock-editor", "line-editor", "plan-editor"]
      .find((d) => document.getElementById(d).open));
    if (formOpen) { await FILL[id](page); await wait(1500); continue; }
    const pulsing = page.locator(".coach-target").first();
    if (await pulsing.count()) await pulsing.click();
  }
  return hints;
}

try {
  console.log("1. Every job, on a computer");
  const page = await demo(1280, 900);
  await page.click('.tour-card [data-tour="skip"]');
  await page.evaluate(() => TryIt.open());
  check(await page.isVisible("#tryit-panel") && /0 of 7 done/.test(await page.textContent("#tryit-count")), "the list: 7 jobs, none done yet");
  check((await page.textContent("#try-it")).includes("0 of 7"), `the demo bar: "${await page.textContent("#try-it")}"`);
  await page.screenshot({ path: `${SHOTS}tryit-list.png` });
  await page.evaluate(() => document.getElementById("tryit-panel").close());
  for (const id of ["check", "dryhop", "transfer", "package", "bringup", "line", "plan"]) {
    const hints = await doJob(page, id);
    const last = hints.at(-1) || "";
    check(/: done\./.test(last), `${id}: guided step by step (${hints.length} hints), then "${last.slice(0, 90)}…"`);
    await page.screenshot({ path: `${SHOTS}tryit-${id}.png` });
    await page.evaluate(() => { TryIt.stop(); document.querySelectorAll("dialog[open]").forEach((d) => d.close()); });
  }
  await page.evaluate(() => refresh());
  await page.evaluate(() => TryIt.open());
  check(/7 of 7 done/.test(await page.textContent("#tryit-count")) && (await page.locator("#tryit-list .tryit-job.done").count()) === 7, `all ticked: ${await page.textContent("#tryit-count")}`);
  check((await page.textContent("#try-it")).includes("7 of 7"), "and the demo bar says so");
  await page.click('#tryit-list [data-see="check"]');
  await wait(800);
  check(/Log today's check: done/.test(await hintText(page)) && await page.isVisible("#bv-chart"), "See it shows the result again");
  await page.evaluate(() => TryIt.stop());

  console.log("2. Ticks come from the records, not clicks");
  const fresh = await demo(1280, 900);
  await fresh.click('.tour-card [data-tour="skip"]');
  await fresh.evaluate(() => TryIt.open());
  await fresh.click('#tryit-list [data-show="check"]');
  await wait(800);
  await fresh.locator(".coach-target").first().click();
  await wait(700);
  await fresh.locator(".coach-target").first().click();
  await wait(700);
  await fresh.click("#cellar-editor .cancel");
  await wait(900);
  check(/Tap \+ Log cellar work/.test(await hintText(fresh)) && (await fresh.evaluate(() => TryIt.doneCount())) === 0,
    "cancel the form: the hint goes back a step, and nothing is ticked");

  console.log("3. A job on a phone");
  const phone = await demo(390, 844);
  await phone.click('.tour-card [data-tour="skip"]');
  const hints = await doJob(phone, "check");
  const box = await phone.evaluate(() => { const r = document.querySelector(".coach-hint").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; });
  check(/: done\./.test(hints.at(-1) || "") && box, "the hint sits at the bottom, on screen, and the job gets done");
  await phone.screenshot({ path: `${SHOTS}tryit-phone.png` });
  check([page, fresh, phone].every((p) => p.errors.length === 0), `no page errors (${[page, fresh, phone].flatMap((p) => p.errors).join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
} finally {
  for (const p of made) await p.evaluate(() => db.rpc("delete_brewery", { p_brewery_id: brewery.id })).catch(() => {});
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
