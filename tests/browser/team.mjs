// Team and permissions: an admin invites a cellar person, who can transfer beer but not start
// batches; the admin adjusts that one person ("just them") and then a whole level ("everyone at
// Cellar"); the last admin can't step down; switching breweries; removing people.
// Real Chrome against the local Supabase test copy (served by the preview server on port 8123).
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { settings, floor, openBatchForm } from "./helpers.mjs";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const ADMIN = "brewer1@example.test";        // admin of "Example Brewing"
const OTHER = "brewer2@example.test";        // admin of "Second Brewing"
const run = Date.now().toString(36).slice(-5);
const CREW = `cellar-${run}@example.test`;   // a brand-new cellar person
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the email service: the local send-invite function "sends" here
// (see supabase/functions/.env), so the test can read the invite email without sending one
const sentEmails = [];
const fakeEmail = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    sentEmails.push({ auth: req.headers.authorization, ...JSON.parse(body || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"fake"}');
  });
}).listen(54399);

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

// Each person gets their own browser (their own sign-in)
async function person(email) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  page.dialogs = [];
  page.errors = [];
  page.on("dialog", async (d) => { page.dialogs.push(d.message()); await d.accept(); });
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(APP);
  await page.waitForSelector("#signin-screen:not([hidden])", { timeout: 20000 });
  const before = new Set(((await (await fetch(`${MAIL}/messages`)).json()).messages || []).map((m) => m.ID));
  await page.fill('#signin-form [name="email"]', email);
  await page.click("#signin-form button[type=submit]");
  await page.waitForSelector("#code-form:not([hidden])");
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    const list = await (await fetch(`${MAIL}/messages`)).json();
    const msg = (list.messages || []).find((m) => !before.has(m.ID) && (m.To || []).some((t) => t.Address === email));
    if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
    if (!code) await wait(300);
  }
  await page.fill('#code-form [name="code"]', code);
  await page.click("#code-form button[type=submit]");
  await page.waitForSelector("#app-screen:not([hidden]), #setup-screen:not([hidden])", { timeout: 20000 });
  await wait(300);
  return page;
}
const screen = (p) => p.evaluate(() => ["signin-screen", "setup-screen", "app-screen"].find((id) => !document.getElementById(id).hidden));
const settle = async (p) => { await wait(150); await p.waitForFunction(() => !busy); await wait(100); };
const perms = (p) => p.evaluate(() => brewery.permissions);
const userIdOf = (p, email) => p.evaluate((e) => data.members.find((m) => m.email === e)?.userId, email);
const tankIdOf = (p, name) => p.evaluate((n) => data.tanks.find((t) => t.name === n)?.id, name);
async function openMember(admin, email) {
  await settings(admin, "team");
  await admin.click(`[data-member="${await userIdOf(admin, email)}"]`);
  await admin.waitForSelector("#member-editor[open]");
}
async function toggleForMember(admin, permission, scope) { // scope: "person" or "level"
  await admin.click(`[data-member-permission="${permission}"]`);
  await admin.waitForSelector("#scope-editor[open]");
  await admin.click(scope === "person" ? "#scope-person" : "#scope-level");
  await settle(admin);
}

try {
  console.log("Setup: the admin adds two tanks and starts a batch in the first");
  const admin = await person(ADMIN);
  const [T1, T2] = [`P1-${run}`, `P2-${run}`];
  await settings(admin, "equipment");
  for (const t of [T1, T2]) {
    await admin.click("#add-tank");
    await admin.fill('#tank-form [name="name"]', t);
    await admin.click("#tank-form button[type=submit]");
    await admin.waitForFunction((n) => data.tanks.some((x) => x.name === n), t);
  }
  await floor(admin);
  await openBatchForm(admin, `.card[data-tank="${await tankIdOf(admin, T1)}"]`);
  await admin.fill('#batch-form [name="batchId"]', `P${run}`);
  await admin.selectOption('#batch-form [name="beerId"]', await admin.evaluate(() => data.beers[0].id));
  await admin.click("#batch-form button[type=submit]");
  await admin.waitForFunction((n) => data.batches.some((b) => b.batchNumber === n), `P${run}`);

  console.log("1. The admin invites a cellar person");
  await settings(admin, "team");
  await admin.fill('#invite-form [name="email"]', CREW.toUpperCase()); // capitals shouldn't matter
  check((await admin.inputValue('#invite-form [name="role"]')) === "cellar", "the invite form suggests Cellar");
  await admin.click("#invite-form button[type=submit]");
  await settle(admin);
  check((await admin.textContent("#invite-list")).includes(CREW), "the invite is listed");
  await admin.waitForFunction(() => /Emailed|couldn't|aren't/.test(document.getElementById("invite-message").textContent), null, { timeout: 60000 }); // the email function may start cold
  check((await admin.textContent("#invite-message")).startsWith(`Emailed ${CREW}`), `message: "${await admin.textContent("#invite-message")}"`);
  const email = sentEmails.find((m) => m.to?.[0] === CREW);
  check(!!email && email.subject === "You're invited to join Example Brewing on Brewery OS", `email sent: "${email?.subject}"`);
  check(email?.text.includes(`${ADMIN} invited you`) && email.text.includes("as Cellar") && email.text.includes(`sign in with this email address (${CREW})`),
    "it says who invited them, the level, and which address to sign in with");
  check(email?.reply_to === ADMIN, "replies go to the admin who invited");
  await admin.waitForFunction(() => document.getElementById("invite-list").textContent.includes("Email again"), null, { timeout: 15000 }).catch(() => {});
  check((await admin.textContent("#invite-list")).includes("Email again"), "the invite shows it was emailed, with 'Email again'");
  const before = sentEmails.length;
  await admin.click("[data-email-invite]");
  await admin.waitForFunction(() => /moment ago/.test(document.getElementById("invite-message").textContent), null, { timeout: 60000 }); // the email function may start cold
  check(sentEmails.length === before, "a second email right away is held back (a double tap doesn't send twice)");

  console.log("2. The cellar person can move beer but not start batches or change setup");
  const crew = await person(CREW);
  globalThis.pages = { admin, crew };
  check(await screen(crew) === "app-screen", "joined the brewery automatically");
  check(await crew.evaluate(() => brewery.role) === "cellar", "as Cellar");
  check(!(await crew.textContent(`.card[data-tank="${await tankIdOf(crew, T2)}"]`)).includes("Tap to start a batch"),
    "empty tanks don't offer to start a batch");
  await openBatchForm(crew, `.card[data-tank="${await tankIdOf(crew, T1)}"]`);
  check(await crew.isDisabled('#batch-form [name="batchId"]'), "the batch number is locked");
  check(!(await crew.isDisabled('#batch-form [name="tankId"]')), "the tank can be changed");
  await crew.selectOption('#batch-form [name="tankId"]', await tankIdOf(crew, T2));
  await crew.click("#batch-form button[type=submit]");
  await settle(crew);
  check((await crew.textContent(`.card[data-tank="${await tankIdOf(crew, T2)}"]`)).includes(`#P${run}`), "the transfer saved");
  await settings(crew, "equipment");
  check(!(await crew.isVisible("#add-tank")) && !(await crew.isVisible("#add-location")), "no 'add tank' or 'add location' buttons");
  await settings(crew, "team");
  check(!(await crew.isVisible("#invite-form")), "no invite form");
  check(await crew.isDisabled('#levels-table input >> nth=0'), "can see what levels include, but not change them");
  await floor(crew);

  const inviteToken = await crew.evaluate(async () => (await db.auth.getSession()).data.session.access_token);
  const sneaky = await fetch("http://127.0.0.1:54321/functions/v1/send-invite", {
    method: "POST", headers: { Authorization: `Bearer ${inviteToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inviteId: crypto.randomUUID() }),
  });
  check(sneaky.status === 404, `someone who isn't an admin can't send invite emails (${sneaky.status})`);

  console.log("3. The admin removes packaging for just this person");
  await admin.reload();
  await admin.waitForSelector("#app-screen:not([hidden])");
  await openMember(admin, CREW);
  await toggleForMember(admin, "package", "person");
  check((await admin.textContent("#member-permissions")).includes("removed for them"), "shown as 'removed for them'");
  await admin.click("#member-editor .cancel");
  await crew.reload();
  await crew.waitForSelector("#app-screen:not([hidden])");
  check(!(await perms(crew)).includes("package"), "the cellar person can no longer package");
  await openBatchForm(crew, `.card[data-tank="${await tankIdOf(crew, T2)}"]`);
  check(await crew.evaluate(() => batchForm.stage.querySelector('[value="packaged"]').disabled), "'Packaged' is greyed out for them");
  await crew.keyboard.press("Escape");

  console.log("4. The admin lets everyone at Cellar start batches");
  await openMember(admin, CREW);
  await toggleForMember(admin, "start_batch", "level");
  await admin.click("#member-editor .cancel");
  check(await admin.evaluate(() => levelPermissions("cellar").includes("start_batch")), "the Cellar level now includes it");
  await crew.reload();
  await crew.waitForSelector("#app-screen:not([hidden])");
  check((await perms(crew)).includes("start_batch") && !(await perms(crew)).includes("package"),
    "the cellar person can now start batches (and still can't package)");
  await settings(admin, "team");
  await admin.click("#reset-levels");
  await settle(admin);
  check(!(await admin.evaluate(() => levelPermissions("cellar").includes("start_batch"))), "levels can be reset to the defaults");

  console.log("5. The only admin can't step down");
  admin.dialogs.length = 0;
  await openMember(admin, ADMIN);
  await admin.selectOption('#member-form [name="role"]', "brewer");
  await settle(admin);
  check(admin.dialogs.some((d) => d.includes("needs at least one admin")), `refused: "${admin.dialogs.at(-1)}"`);
  check(await admin.evaluate(() => brewery.role) === "admin", "still the admin");
  await admin.click("#member-editor .cancel");

  console.log("6. Someone in two breweries can switch between them");
  await admin.fill('#invite-form [name="email"]', OTHER);
  await admin.click("#invite-form button[type=submit]");
  await settle(admin);
  const other = await person(OTHER);
  await settings(other, "account");
  check(await other.isVisible("#brewery-switch-field"), "the brewery switcher appears");
  const startName = await other.textContent("#brewery-name");
  const target = startName === "Example Brewing" ? "Second Brewing" : "Example Brewing";
  await other.selectOption("#brewery-switch", { label: target });
  await other.waitForFunction((t) => document.getElementById("brewery-name").textContent === t, target);
  check(true, `switched from ${startName} to ${target}`);
  await other.reload();
  await other.waitForSelector("#app-screen:not([hidden])");
  check((await other.textContent("#brewery-name")) === target, "the choice is remembered after reloading");

  console.log("7. Removing people");
  await admin.reload();
  await admin.waitForSelector("#app-screen:not([hidden])");
  for (const email of [CREW, OTHER]) {
    await openMember(admin, email);
    await admin.click("#remove-member");
    await settle(admin);
  }
  check(!(await admin.evaluate((es) => data.members.some((m) => es.includes(m.email)), [CREW, OTHER])), "both removed from the team");
  await crew.reload();
  await crew.waitForSelector("#setup-screen:not([hidden]), #app-screen:not([hidden])");
  check(await screen(crew) === "setup-screen", "the removed person no longer gets in");
  check([admin, crew, other].every((p) => p.errors.length === 0), `no page errors (${[admin, crew, other].flatMap((p) => p.errors).join("; ")})`);
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message.split("\n")[0]);
  for (const [who, p] of Object.entries(globalThis.pages || {})) {
    console.log(who, "dialogs:", p.dialogs, "errors:", p.errors,
      "state:", await p.evaluate(() => ({ role: brewery?.role, perms: brewery?.permissions, screen: ["signin-screen","setup-screen","app-screen"].find((id) => !document.getElementById(id).hidden) })).catch((x) => x.message));
  }
} finally {
  await browser.close();
  fakeEmail.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
