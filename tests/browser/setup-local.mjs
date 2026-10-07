// Set up the local test copy for the browser tests (run once after `supabase db reset`):
//   brewer1@example.test -> admin of "Example Brewing", loaded with the sample data
//   brewer2@example.test -> admin of "Second Brewing" (empty)
// Safe to run again: anyone who already has a brewery is left as is.
import { chromium } from "playwright-core";

const APP = "http://localhost:8123/";
const MAIL = "http://127.0.0.1:54324/api/v1";
const PEOPLE = [
  { email: "brewer1@example.test", brewery: "Example Brewing", sample: true },
  { email: "brewer2@example.test", brewery: "Second Brewing", sample: false },
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  for (const person of PEOPLE) {
    const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(APP);
    await page.waitForSelector("#signin-screen:not([hidden])", { timeout: 20000 });
    const before = new Set(((await (await fetch(`${MAIL}/messages`)).json()).messages || []).map((m) => m.ID));
    await page.fill('#signin-form [name="email"]', person.email);
    await page.click("#signin-form button[type=submit]");
    await page.waitForSelector("#code-form:not([hidden])");
    let code = null;
    for (let i = 0; i < 40 && !code; i++) {
      const msg = ((await (await fetch(`${MAIL}/messages`)).json()).messages || [])
        .find((m) => !before.has(m.ID) && m.To.some((t) => t.Address === person.email));
      if (msg) code = ((await (await fetch(`${MAIL}/message/${msg.ID}`)).json()).Text || "").match(/\b(\d{6})\b/)?.[1];
      if (!code) await wait(300);
    }
    await page.fill('#code-form [name="code"]', code);
    await page.click("#code-form button[type=submit]");
    await page.waitForSelector("#app-screen:not([hidden]), #setup-screen:not([hidden])", { timeout: 20000 });
    let created = false;
    if (await page.isVisible("#setup-screen")) {
      await page.fill('#setup-form [name="name"]', person.brewery);
      await page.click("#setup-form button[type=submit]");
      await page.waitForSelector("#app-screen:not([hidden])", { timeout: 20000 });
      created = true;
    }
    await wait(500);
    const loadSample = person.sample && await page.evaluate(() => data.tanks.length === 0);
    if (loadSample) {
      await page.click("#load-sample"); // offered on the empty tank board
      await page.waitForFunction(() => data.tanks.length > 0 && !busy, null, { timeout: 30000 });
    }
    console.log(`${person.email}: ${created ? `created ${person.brewery}` : "already set up"}${loadSample ? ", loaded the sample data" : ""}`);
  }
} finally {
  await browser.close();
}
