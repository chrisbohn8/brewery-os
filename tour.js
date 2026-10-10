// Brewery OS — the demo tour (docs/demo-design.md, step 4)
//
// A short walk through the demo brewery, on the real screens with the demo's own records: each
// step opens a screen the way a person would, puts a spotlight on what it's about, and says in a
// sentence or two why a brewer would care. About two minutes; Back, Next, and Skip; the keyboard
// works (→ / Enter, ←, Esc). On a phone the words sit at the bottom so the spotlight stays visible.
//
// It never assumes what's in the demo today (dates move, so what's in each tank changes): every
// step picks its example from the records (the batch with the most turns, a taproom with pars...),
// and a step whose example isn't there today is left out. tests/browser/tour.mjs checks every step.
//
//   DemoTour.start()      from the first step
//   DemoTour.offer()      starts it the first time a demo opens on this device
//   DemoTour.steps()      the steps it would show now (for the tests)
(function () {
  const SEEN_KEY = "brewery-os.tour-seen";
  let steps = [], at = -1, layer = null, spot = null, card = null, busyStep = false;

  // ---------- What the tour shows: picked from the demo's records ----------
  const inTank = () => data.batches.filter((b) => isInTank(b));
  const gravityReadings = (b) => data.cellar.filter((c) => c.batchId === b.id && c.gravitySg != null).length;
  // The batch to show: brewed in the most turns (three, at the 30 bbl brewhouse), with a fermentation chart
  function showcaseBatch() {
    const options = inTank().filter((b) => gravityReadings(b) >= 3 && data.readings.some((r) => r.batchId === b.id));
    return options.sort((x, y) => (y.turns || 1) - (x.turns || 1) || gravityReadings(y) - gravityReadings(x))[0] || null;
  }
  const taprooms = () => (data.places || []).filter((p) => p.kind === "taproom" && p.active);
  const taproomWithPars = () => taprooms().find((p) => (data.pars || []).some((x) => x.placeId === p.id)) || null;
  const openAlerts = () => (data.alerts || []).filter((a) => !a.acknowledgedAt);
  const visible = (el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  const firstVisible = (selector) => [...document.querySelectorAll(selector)].find(visible) || null;
  const sheetTurnText = (b) => `${b.turns} ${b.turns === 1 ? "turn" : "turns"}`;

  function buildSteps() {
    const b = showcaseBatch();
    const tank = b ? data.tanks.find((t) => t.id === b.tankId) : null;
    const beer = b ? findBeer(b.beerId) : null;
    const taproom = taproomWithPars();
    // The board to show: one with what's on tap, at the taproom pouring the most
    const lines = (placeId) => (data.lines || []).filter((l) => l.placeId === placeId && l.status === "beer").length;
    const board = (data.boards || []).filter((x) => x.showOnTap && lines(x.placeId) > 0)
      .sort((x, y) => lines(y.placeId) - lines(x.placeId) || (x.layout === "compact") - (y.layout === "compact"))[0] || (data.boards || [])[0];
    const batches = data.batches.length;
    return [
      { id: "welcome", title: `Welcome to ${brewery.name}`,
        text: `A made-up brewery with ${data.locations.length} locations, ${data.tanks.length} tanks, and ${batches} batches brewed over the last three months, right up to today. This tour takes about two minutes. Everything here is yours to change.` },
      { id: "tanks", title: "Every tank at a glance",
        before: () => showSettings(false),
        target: () => [...document.querySelectorAll("#tanks .card[data-tank]")].find((c) => visible(c) && batchInTank(c.dataset.tank)) || null,
        text: "What's in each tank, its stage, how many days it's been there, and how much beer is in it. That volume isn't typed in: it's worked out from every knockout, transfer, and packaging run, so it's always right." },
      { id: "alerts", title: "What needs attention comes to you", when: () => openAlerts().length > 0,
        before: () => { showSettings(false); const d = document.querySelector("#alerts-box details"); if (d) d.open = true; },
        target: () => document.getElementById("alerts-box"),
        text: `Right now: ${openAlerts().slice(0, 2).map((a) => `"${a.title}"`).join(" and ")}${openAlerts().length > 2 ? `, and ${openAlerts().length - 2} more` : ""}. The app checks every 15 minutes, clears an alert by itself when it's dealt with, and can email the people you choose.` },
      { id: "batch", title: "Every batch's whole story", when: () => !!b,
        before: () => openBatchView(b.id),
        target: () => (visible(document.querySelector("#bv-chart svg, #bv-chart canvas")) ? document.getElementById("bv-chart") : document.getElementById("bv-cellar")),
        text: b ? `${beer?.name} #${b.batchNumber}: the fermentation chart from its gravity readings, the cellar log, every addition with its lot number, and every transfer with its volume. Tap anything to fix it; the history keeps both.` : "" },
      { id: "sheet", title: "The brew-day sheet, turn by turn", when: () => !!b,
        before: () => { openBatchView(b.id); showSheet(true); },
        target: () => (visible(document.getElementById("turn-tabs")) ? document.getElementById("turn-tabs") : document.getElementById("bv-brewday")),
        text: b ? `This batch went into ${tank?.name} (${tank?.capacityBbl} bbl) in ${sheetTurnText(b)}, so its sheet has a tab for each. It follows your paper sheet's order, flags a number far from its target ("Typo?"), works with no signal, and prints for the clipboard.` : "" },
      { id: "inventory", title: "Kegs and cases, everywhere",
        before: () => { showView("inventory"); inventoryPlace = "all"; inventoryView = null; inventoryTab = "finished"; renderInventory(); showInventoryTab(); },
        target: () => document.getElementById("inv-table"),
        text: "On hand at every place, from packaging runs, moves, sales, and counts. Stock always leaves oldest batch first, and every keg can be traced to its batch." },
      { id: "pars", title: "Pars say what to bring up", when: () => !!taproom,
        before: () => { showView("inventory"); inventoryTab = "finished"; inventoryPlace = taproom.id; inventoryView = null; renderInventory(); showInventoryTab(); },
        target: () => document.getElementById("inv-pars"),
        text: taproom ? `${placeName(taproom.id)}: each beer's par, what's over or under, and what to bring up from storage. One tap fills in the move.` : "" },
      { id: "raw", title: "Malt and hops, by lot",
        before: () => { showView("inventory"); inventoryTab = "raw"; renderInventory(); showInventoryTab(); },
        target: () => document.getElementById("raw-list"),
        text: "Each delivery by lot. Brewing uses them up automatically (an ingredient with the same name and lot), so you know what's on the shelf and which batches used a lot. Low stock is flagged before brew day." },
      { id: "calendar", title: "Plan brew days, tank by tank",
        before: async () => {
          showView("calendar");
          renderCalendar();
          // (a clash in the plan may be next week: go to it)
          for (let i = 0; i < 2 && planHasClash() && !firstVisible("#cal-grid .cal-chip.clash"); i++) {
            document.getElementById("cal-next").click();
            await new Promise((r) => requestAnimationFrame(r));
          }
        },
        target: () => firstVisible("#cal-grid .cal-chip.clash") || firstVisible("#cal-grid .cal-chip.late")
          || firstVisible("#cal-grid .cal-chip.brew") || document.getElementById("cal-range"),
        // (the words say what the spotlight is on)
        text: (target) => target?.classList.contains("clash")
          ? `"${target.textContent.replace(" ⚠", "").trim()}" is marked ⚠: that tank won't be empty in time. The calendar works out each batch's next steps from its beer's schedule, warns before a plan can't happen, and its shopping list says what to order.`
          : target?.classList.contains("late")
            ? `"${target.textContent.split(" · ")[0].trim()}" is late: the calendar works out each batch's next steps from its beer's schedule and flags what's overdue or would clash. Its shopping list says what to order for the brews ahead.`
            : "Planned brew days, tank by tank, and each batch's next steps worked out from its beer's schedule. The calendar warns when a tank won't be empty in time or you'd run short, and its shopping list says what to order." },
      { id: "menu", title: "Your taproom's TV menu", when: () => !!board,
        before: () => showSettings(true, "menu"),
        target: () => document.querySelector(`#board-list [data-board="${board.id}"]`) || document.getElementById("board-list"),
        preview: board,
        text: "Built from the taproom's draft lines and each beer's menu: change a line and the TV updates within seconds. Each board has its own layout, colors, and fonts." },
      { id: "done", title: "That's the tour",
        before: () => showSettings(false),
        text: "It's all yours: tap a batch and log a gravity reading, start a batch in an empty tank, or count the taproom. Take the tour again from the yellow bar any time.",
        finish: true },
    ].filter((s) => !s.when || s.when());
  }
  // (the calendar's words depend on whether there's a clash in the plan; known before the screen opens)
  function planHasClash() {
    return (data.planItems || []).some((p) => { try { return !!planClash(p); } catch { return false; } });
  }

  // ---------- Showing a step ----------
  function ensureLayer() {
    if (layer) return;
    layer = document.createElement("div");
    layer.className = "tour-layer";
    layer.addEventListener("click", (e) => { if (e.target === layer) e.stopPropagation(); }); // (the page under it isn't tapped by accident)
    spot = document.createElement("div");
    spot.className = "tour-spot";
    card = document.createElement("div");
    card.className = "tour-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "tour-title");
    card.tabIndex = -1;
    layer.append(spot, card);
    document.body.append(layer);
    card.addEventListener("click", (e) => {
      const act = e.target.closest("[data-tour]")?.dataset.tour;
      if (act === "next") go(at + 1);
      if (act === "back") go(at - 1);
      if (act === "skip" || act === "explore") end();
      if (act === "own") { end(); document.getElementById("leave-demo").click(); }
    });
    addEventListener("keydown", keys, true);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
  }
  function keys(e) {
    if (!layer || document.querySelector("dialog[open]")) return;
    if (e.key === "Escape") { e.preventDefault(); end(); }
    else if (e.key === "ArrowRight" || (e.key === "Enter" && !e.target.closest?.("button"))) { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(at - 1); }
  }

  async function go(i) {
    if (busyStep || i < 0) return;
    if (i >= steps.length) { end(); return; }
    busyStep = true;
    at = i;
    const step = steps[i];
    try { await step.before?.(); } catch (e) { console.warn("tour step", step.id, e); }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // (let the screen draw)
    const target = step.target?.() || null;
    if (target) target.scrollIntoView({ block: innerWidth <= 600 ? "start" : "center", behavior: "instant" });
    card.innerHTML = `
      <div class="tour-progress" aria-hidden="true">${steps.map((_, n) => `<span class="${n === i ? "on" : n < i ? "done" : ""}"></span>`).join("")}</div>
      <p class="tour-count">${i + 1} of ${steps.length}</p>
      <h2 id="tour-title">${esc(step.title)}</h2>
      <p class="tour-text">${esc(typeof step.text === "function" ? step.text(target) : step.text)}</p>
      ${step.preview ? `<div class="tour-tv" aria-label="The board, as the TV shows it"><div class="tour-tv-screen"></div></div>` : ""}
      <div class="tour-actions">
        ${step.finish
          ? `<button type="button" class="btn" data-tour="own">Start your own brewery</button><span class="spacer"></span>
             <button type="button" class="btn primary" data-tour="explore">Explore the demo</button>`
          : `${i > 0 ? `<button type="button" class="btn" data-tour="back">Back</button>` : `<button type="button" class="btn" data-tour="skip">Skip the tour</button>`}
             <span class="spacer"></span>${i > 0 ? `<button type="button" class="btn link" data-tour="skip">Skip</button>` : ""}
             <button type="button" class="btn primary" data-tour="next">${i === 0 ? "Show me" : "Next"}</button>`}
      </div>`;
    spot.dataset.target = target ? (target.id || target.dataset.tank || "found") : "";
    card.dataset.step = step.id;
    delete card.dataset.scrolled;
    place();
    card.focus({ preventScroll: true });
    if (step.preview) showPreview(step.preview);
    busyStep = false;
  }

  // A small TV preview of the board: drawn at a real TV's size (1280 × 720), the same way the TV draws
  // it, then shrunk to fit (so it looks exactly like the TV, not like a cramped little board)
  async function showPreview(b) {
    const box = card.querySelector(".tour-tv"), screen = box?.querySelector(".tour-tv-screen");
    if (!screen) return;
    try {
      const shrink = () => { screen.style.transform = `scale(${box.clientWidth / 1280})`; };
      shrink();
      await drawBoard(screen, boardToDraw(await boardContent(b.placeId, false), b), "tv");
      screen.className = "tour-tv-screen board-frame-tv";
      BoardView.fit(screen);
      shrink();
      box.dataset.ready = "1";
      place();
    } catch {
      box.remove();
    }
  }

  // Where the spotlight and the words go: the words next to the spotlight on a computer (below it,
  // or above when there's no room), at the bottom on a phone
  function place() {
    if (!layer) return;
    const target = steps[at]?.target?.() || null;
    const r = target?.getBoundingClientRect();
    const phone = innerWidth <= 600;
    if (r && r.width && r.height) {
      const pad = 6;
      const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
      Object.assign(spot.style, { display: "block", top: `${top}px`, left: `${left}px`,
        width: `${Math.min(innerWidth - 8, r.right + pad) - left}px`, height: `${Math.min(innerHeight - 8, r.bottom + pad) - top}px` });
    } else {
      Object.assign(spot.style, { display: "block", top: "50%", left: "50%", width: "0px", height: "0px" });
    }
    card.classList.toggle("tour-sheet", phone);
    card.classList.toggle("tour-center", !phone && !(r && r.width));
    if (phone || !(r && r.width)) { card.style.top = card.style.left = ""; return; }
    const width = Math.min(420, innerWidth - 32);
    const height = card.offsetHeight;
    let below = r.bottom + 14 + height <= innerHeight - 12;
    let above = r.top - 14 - height >= 12;
    // No room either side: bring the target to the top of the screen once, so the words fit under it
    if (!below && !above && !card.dataset.scrolled && r.top > 24) {
      card.dataset.scrolled = "1";
      target.scrollIntoView({ block: "start", behavior: "instant" });
      scrollBy(0, -16);
      return place();
    }
    const top = below ? r.bottom + 14 : above ? r.top - 14 - height : Math.max(12, innerHeight - height - 12);
    const left = Math.min(Math.max(16, r.left), innerWidth - width - 16);
    Object.assign(card.style, { top: `${top}px`, left: `${left}px`, width: `${width}px` });
  }

  function end() {
    if (!layer) return;
    removeEventListener("keydown", keys, true);
    removeEventListener("resize", place);
    removeEventListener("scroll", place, true);
    layer.remove();
    layer = spot = card = null;
    at = -1;
    try { showSettings(false); } catch {}
    document.getElementById("take-tour")?.focus();
  }

  function start() {
    end();
    document.querySelectorAll("#toasts .toast-close").forEach((x) => x.click()); // (messages would sit on top of the tour)
    steps = buildSteps();
    ensureLayer();
    try { localStorage.setItem(`${SEEN_KEY}.${brewery.id}`, "1"); } catch {}
    go(0);
  }
  // The first time a demo opens on this device (never on top of a form someone has open)
  function offer() {
    let seen = false;
    try { seen = !!localStorage.getItem(`${SEEN_KEY}.${brewery.id}`); } catch {}
    if (!seen && !document.querySelector("dialog[open]")) start();
  }

  window.DemoTour = { start, offer, end, steps: () => buildSteps(), get open() { return !!layer; }, get step() { return steps[at]?.id ?? null; } };
})();
