// End-to-end walk through Brewery OS on the local Supabase stack.
import { chromium } from "playwright-core";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = "brewer1@example.test";
const OUT = new URL("./shots/", import.meta.url).pathname;
const log = (...a) => console.log("•", ...a);
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
let n = 0;
const shot = async (name) => page.screenshot({ path: `${OUT}${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true });

// 1. Sign in with an emailed code
await fetch(`${MAIL}/messages`, { method: "DELETE" }).catch(() => {});
await page.goto(APP);
await page.waitForSelector("#signin-screen:not([hidden]), #app-screen:not([hidden])", { timeout: 15000 });
if (await page.isVisible("#signin-screen")) {
  log("Signing in as", EMAIL);
  await page.fill('#signin-form input[name="email"]', EMAIL);
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector("#code-form:not([hidden])", { timeout: 15000 });
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    const list = await (await fetch(`${MAIL}/messages`)).json();
    const msg = (list.messages || []).find((m) => (m.To || []).some((t) => t.Address === EMAIL));
    if (msg) {
      const full = await (await fetch(`${MAIL}/message/${msg.ID}`)).json();
      code = (full.Text || full.HTML || "").match(/\b(\d{6,10})\b/)?.[1];
    }
    if (!code) await new Promise((r) => setTimeout(r, 500));
  }
  check(!!code, "sign-in code arrived by email");
  await page.fill('#code-form input[name="code"]', code);
  await page.click('#code-form button[type="submit"]');
}
await page.waitForSelector("#app-screen:not([hidden])", { timeout: 15000 });
check(true, "signed in and reached the tank screen");
log("Brewery:", (await page.textContent("#brewery-name"))?.trim());
await page.waitForTimeout(800);

if (await page.isVisible("#empty-state")) {
  log("Empty brewery: loading sample data");
  await page.click("#load-sample");
  await page.waitForSelector("#empty-state", { state: "hidden", timeout: 15000 });
}
await page.waitForSelector("#tanks .card");
await shot("tanks");

// Helpers
const emptyTankIds = () => page.$$eval("#tanks .card", (cs) =>
  cs.filter((c) => c.querySelector(".beer.none") && /start a batch/i.test(c.textContent)).map((c) => c.dataset.tank));
const openTank = async (id) => {
  await page.click(`#tanks .card[data-tank="${id}"]`);
  await page.waitForSelector("#batch-editor[open]");
};
const saveForm = async () => {
  await page.click('#batch-form button[type="submit"]');
  await page.waitForSelector("#batch-editor:not([open])", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(800); // let it reload from the database
};
const cardText = (id) => page.textContent(`#tanks .card[data-tank="${id}"]`);

// Add three empty tanks for this run (the sample brewery's tanks are all in use)
const tag = String(Date.now()).slice(-4);
for (const name of [`E2E-A${tag}`, `E2E-B${tag}`, `E2E-C${tag}`]) {
  log("Adding tank", name);
  await page.click("#add-tank");
  await page.waitForSelector("#tank-editor[open]");
  await page.fill('#tank-form input[name="name"]', name);
  await page.fill('#tank-form input[name="capacityBbl"]', "15");
  await page.click('#tank-form button[type="submit"]');
  await page.waitForSelector("#tank-editor:not([open])", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(800);
}
let empties = await emptyTankIds();
check(empties.length >= 2, `at least two empty tanks to work with (found ${empties.length})`);
const [tankA, tankB] = empties;
const batchNo = String(9000 + Math.floor(Math.random() * 900));

// 2. Start a batch
log("Starting batch", batchNo, "in tank", tankA);
await openTank(tankA);
await page.fill('#batch-form input[name="batchId"]', batchNo);
await page.fill('#batch-form input[name="sizeBbl"]', "10");
const beerOpts = await page.$$eval('#batch-form select[name="beerId"] option', (os) => os.map((o) => o.value).filter((v) => v && !v.startsWith("__")));
await page.selectOption('#batch-form select[name="beerId"]', beerOpts[0]);
await saveForm();
check((await cardText(tankA)).includes(batchNo), "new batch shows on its tank card");
await shot("batch-started");

// 3. Change its stage
const stages = await page.$$eval('#batch-form select[name="stage"] option', (os) => os.map((o) => o.value));
await openTank(tankA);
const nextStage = stages[1];
log("Changing stage to", nextStage);
await page.selectOption('#batch-form select[name="stage"]', nextStage);
await saveForm();
check(/dry|hop/i.test(await cardText(tankA)) || (await cardText(tankA)).toLowerCase().includes(nextStage.replace("-", " ")), `card shows new stage (${nextStage})`);

// 4. Transfer to another tank
log("Transferring to tank", tankB);
await openTank(tankA);
await page.selectOption('#batch-form select[name="tankId"]', tankB);
await saveForm();
check((await cardText(tankB)).includes(batchNo), "batch now shows on the new tank");
check(!(await cardText(tankA)).includes(batchNo), "old tank no longer shows the batch");
check(/clean/i.test(await cardText(tankA)), "old tank marked Cleaning");
await shot("transferred");

// 5. Package it
log("Packaging");
await openTank(tankB);
await page.selectOption('#batch-form select[name="stage"]', "packaged");
await saveForm();
check(!(await cardText(tankB)).includes(batchNo), "packaged batch left its tank");
const packaged = await page.textContent("#packaged-list").catch(() => "");
check(packaged.includes(batchNo), "batch appears in Packaged batches list");
await shot("packaged");

// 6. History saved in the database (read as the signed-in brewer)
const history = await page.evaluate(async (no) => {
  const { data: b, error: e1 } = await db.from("batches").select("*").eq("batch_number", no);
  if (e1) return { error: e1.message };
  if (!b?.length) return { error: "batch not found", cols: null };
  const { data: ev, error: e2 } = await db.from("batch_events").select("*").eq("batch_id", b[0].id);
  return { error: e2?.message, batch: b[0], events: ev };
}, batchNo).catch((e) => ({ error: e.message }));
if (history.error) log("History query:", history.error);
else {
  log("History events:", history.events.map((e) => `${e.stage}@${e.tank_id ? e.tank_id.slice(0, 8) : "no tank"} ${e.happened_on ?? e.event_date ?? ""}`).join(" → "));
  check(history.events.length >= 4, `history has 4 entries: start, stage change, transfer, package (found ${history.events.length})`);
}

// 7. Guardrail: duplicate batch number is refused
log("Trying a duplicate batch number");
empties = await emptyTankIds();
await openTank(empties[0]);
await page.fill('#batch-form input[name="batchId"]', batchNo);
await page.selectOption('#batch-form select[name="beerId"]', beerOpts[0]);
await page.click('#batch-form button[type="submit"]');
await page.waitForTimeout(1500);
const stillOpen = await page.isVisible("#batch-editor[open]");
const msgs = dialogs.join(" | ") + " " + ((await page.textContent("#batch-editor").catch(() => "")) || "");
check(stillOpen || /already|unique|duplicate/i.test(msgs), "duplicate batch number refused");
await shot("duplicate");
if (stillOpen) await page.click("#batch-form .cancel").catch(() => {});

// 8. Reload: data survives
await page.reload();
await page.waitForSelector("#app-screen:not([hidden])", { timeout: 15000 });
await page.waitForTimeout(1000);
check((await page.textContent("#packaged-list").catch(() => "")).includes(batchNo), "after reload, packaged batch is still there");

console.log("\nDialogs:", dialogs);
console.log("Errors:", errors.length ? errors : "none");
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
await browser.close();
