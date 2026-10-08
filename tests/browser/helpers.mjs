// Shared steps for the browser tests.

// Open a Settings page ("brewery", "equipment", "beers", "cleaning", "team", "backup", "account")
export async function settings(page, name) {
  if (await page.isVisible("#open-settings")) await page.click("#open-settings");
  await page.click(`#settings-nav [data-page="${name}"]`);
  await page.waitForSelector(`.settings-page[data-page="${name}"]:not([hidden])`);
}

// Back to the tank board
export async function floor(page) {
  if (await page.isVisible("#close-settings")) await page.click("#close-settings");
  await page.waitForSelector("#floor-view:not([hidden])");
}

// Open the batch form (stage, transfer, packaging) for a tank card. Tapping a FULL tank opens the
// batch's page first, where "Stage / transfer…" opens the form; an empty tank opens it directly.
export async function openBatchForm(page, cardSelector) {
  await floor(page);
  await page.click(cardSelector);
  await page.waitForSelector("#batch-editor[open], #batch-view:not([hidden]), #tank-editor[open]");
  if (await page.isVisible("#batch-view")) {
    await page.click("#bv-edit");
    await page.waitForSelector("#batch-editor[open]");
  }
}

// The app asks questions and shows messages on the page (not the browser's pop-ups). This hands
// them to `handler` the way page.on("dialog") handed over pop-ups, so tests read the same:
// d.message(), d.type() ("confirm", "prompt", or "alert" for a message), d.accept(text), d.dismiss().
// A question nobody answers is accepted. Call it before or after the page opens.
export async function onDialog(page, handler) {
  page.dialogHandlers ??= [];
  page.dialogHandlers.push(handler);
  if (page.dialogsWatched) return;
  page.dialogsWatched = true;
  await page.exposeBinding("__appDialog", async (_source, d) => {
    let answer = { ok: true, text: d.value ?? "" };
    const dialog = {
      message: () => d.message,
      type: () => d.type,
      accept: async (text) => { answer = { ok: true, text: text ?? d.value ?? "" }; },
      dismiss: async () => { answer = { ok: false }; },
    };
    for (const h of page.dialogHandlers) await h(dialog);
    return answer;
  });
  const watch = () => {
    // Changes are sent right away in tests, without the few seconds' wait for Undo (undo.mjs tests that)
    window.BREWERY_UNDO_SECONDS ??= 0;
    if (window.__dialogWatch) return;
    window.__dialogWatch = true;
    const start = () => {
      const box = document.getElementById("ask-dialog");
      const toasts = document.getElementById("toasts");
      if (!box || !toasts) return setTimeout(start, 50);
      new MutationObserver(async () => {
        if (!box.open || box.dataset.answering) return;
        box.dataset.answering = "1";
        const input = document.getElementById("ask-input");
        const a = await window.__appDialog({ message: document.getElementById("ask-text").textContent, type: input.hidden ? "confirm" : "prompt", value: input.value });
        if (!input.hidden && a.ok) input.value = a.text;
        delete box.dataset.answering;
        box.close(a.ok ? "ok" : "cancel");
      }).observe(box, { attributes: true, attributeFilter: ["open"] });
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          if (n.classList?.contains("toast")) window.__appDialog({ message: n.querySelector(".toast-text").textContent, type: "alert" });
        }
      }).observe(toasts, { childList: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  };
  await page.addInitScript(watch);
  await page.evaluate(watch).catch(() => {});
}
