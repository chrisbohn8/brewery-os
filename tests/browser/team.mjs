// Team: an admin invites a coworker, the coworker joins by signing in, roles are changed and
// enforced, the last admin can't step down, removal works, and someone in two breweries can switch.
// Real Chrome against the local Supabase test copy (served by the preview server on port 8123).
import { chromium } from "playwright-core";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const ADMIN = "brewer1@example.test";        // admin of "Example Brewing"
const OTHER = "brewer2@example.test";        // admin of "Second Brewing"
const run = Date.now().toString(36).slice(-5);
const CREW = `crew-${run}@example.test`;     // a brand-new coworker
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  PASS" : "  FAIL", msg); if (!ok) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
const settle = (p) => p.waitForFunction(() => !busy);
const members = (p) => p.evaluate(() => [...document.querySelectorAll("#member-list .item")].map((li) => li.innerText.replace(/\s+/g, " ").trim()));
const roleOf = async (p, email) => p.evaluate((e) => data.members.find((m) => m.email === e)?.role, email);
const userIdOf = async (p, email) => p.evaluate((e) => data.members.find((m) => m.email === e)?.userId, email);

try {
  console.log("1. The admin invites a new coworker as a brewer");
  const admin = await person(ADMIN);
  check(await screen(admin) === "app-screen", "admin is in the app");
  check(await admin.isVisible("#invite-form"), "admin sees the invite form");
  await admin.fill('#invite-form [name="email"]', CREW.toUpperCase()); // capitals shouldn't matter
  await admin.selectOption('#invite-form [name="role"]', "brewer");
  await admin.click("#invite-form button[type=submit]");
  await settle(admin);
  const invited = await admin.evaluate(() => [...document.querySelectorAll("#invite-list .item")].map((li) => li.innerText));
  check(invited.some((t) => t.includes(CREW)), `invite listed: ${invited.find((t) => t.includes(CREW))?.replace(/\s+/g, " ")}`);
  const msg = await admin.textContent("#invite-message");
  check(msg.includes("sign in with that email"), `instructions shown: "${msg}"`);

  console.log("2. The coworker signs in and lands straight in the brewery");
  const crew = await person(CREW);
  check(await screen(crew) === "app-screen", "no 'create a brewery' screen: joined automatically");
  check((await crew.textContent("#brewery-name")) === "Example Brewing", "in Example Brewing");
  check(await crew.evaluate(() => brewery.role) === "brewer", "as a brewer");
  check(!(await crew.isVisible("#invite-form")), "a brewer doesn't see the invite form");
  check((await members(crew)).some((t) => t.includes(`${CREW} (you)`)), "sees themself on the team");

  console.log("3. The admin makes them a viewer; the database enforces it");
  await admin.reload();
  await admin.waitForSelector("#app-screen:not([hidden]) #member-list .item");
  check(!(await admin.evaluate(() => [...document.querySelectorAll("#invite-list .item")].length)) ||
        !(await admin.evaluate((e) => data.invites.some((i) => i.email === e), CREW)), "the used invite is gone");
  await admin.selectOption(`[data-role-for="${await userIdOf(admin, CREW)}"]`, "viewer");
  await settle(admin);
  check(await roleOf(admin, CREW) === "viewer", "role changed to viewer");
  await crew.reload();
  await crew.waitForSelector("#app-screen:not([hidden])");
  check(await crew.evaluate(() => brewery.role) === "viewer", "the coworker is now a viewer");
  await crew.click("#add-location");
  await crew.fill('#location-form [name="name"]', `Viewer test ${run}`);
  await crew.click("#location-form button[type=submit]");
  await settle(crew);
  check(crew.dialogs.some((d) => d.includes("permission")), `a viewer's change is refused: "${crew.dialogs.at(-1)}"`);
  check(!(await crew.evaluate((n) => data.locations.some((l) => l.name === n), `Viewer test ${run}`)), "and nothing was added");

  console.log("4. The only admin can't step down");
  admin.dialogs.length = 0;
  await admin.selectOption(`[data-role-for="${await userIdOf(admin, ADMIN)}"]`, "brewer");
  await settle(admin);
  check(admin.dialogs.some((d) => d.includes("needs at least one admin")), `refused: "${admin.dialogs.at(-1)}"`);
  check(await roleOf(admin, ADMIN) === "admin", "still the admin");

  console.log("5. Someone in two breweries can switch between them");
  await admin.fill('#invite-form [name="email"]', OTHER);
  await admin.selectOption('#invite-form [name="role"]', "brewer");
  await admin.click("#invite-form button[type=submit]");
  await settle(admin);
  const other = await person(OTHER);
  check(await other.isVisible("#brewery-switch-field"), "the brewery switcher appears");
  const startName = await other.textContent("#brewery-name");
  const target = startName === "Example Brewing" ? "Second Brewing" : "Example Brewing";
  await other.selectOption("#brewery-switch", { label: target });
  await other.waitForFunction((t) => document.getElementById("brewery-name").textContent === t, target);
  check(true, `switched from ${startName} to ${target}`);
  await other.reload();
  await other.waitForSelector("#app-screen:not([hidden])");
  check((await other.textContent("#brewery-name")) === target, "the choice is remembered after reloading");

  console.log("6. Removing people");
  await admin.reload();
  await admin.waitForSelector("#app-screen:not([hidden]) #member-list .item");
  for (const email of [CREW, OTHER]) {
    await admin.click(`[data-remove-member="${await userIdOf(admin, email)}"]`);
    await settle(admin);
  }
  check(!(await members(admin)).some((t) => t.includes(CREW) || t.includes(OTHER)), "both removed from the team");
  await crew.reload();
  await crew.waitForSelector("#setup-screen:not([hidden]), #app-screen:not([hidden])");
  check(await screen(crew) === "setup-screen", "the removed coworker no longer gets in (back to the welcome screen)");
  check(await crew.isVisible("#check-invites"), "with a 'Check for invites' button");
  check([admin, crew, other].every((p) => p.errors.length === 0), "no page errors");
} catch (e) {
  fails.push("crashed: " + e.message);
  console.log("CRASH", e.message);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
