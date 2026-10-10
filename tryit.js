// Brewery OS — "Try it yourself" in the demo (docs/demo-design.md)
//
// Seven real jobs a brewer does every week, each a minute or less, done with the app's real forms.
// A job is ticked off when its record exists, made after the demo was ready (never by clicking
// through), and then the app points at what it worked out from it: the new point on the chart, the
// lot used up, the kegs in storage, the beer on the TV menu.
//
// "Show me" guides without getting in the way: the next button to tap pulses, and a small hint says
// what to do. The visitor does the real thing; the hint moves on as each step happens, and goes back
// a step if they back out. (Forms open as dialogs, which sit above everything, so a spotlight like the
// tour's can't be used; the hint goes inside an open form, the way the app's messages do.)
//
//   TryIt.open()      the list of jobs
//   TryIt.show(id)    guide one job
//   TryIt.doneCount() how many are done (the demo bar says "2 of 7")
(function () {
  let job = null, ticker = null, hint = null, pulsed = null, finishing = false;

  // ---------- When the demo was ready: what's made after this is the visitor's own ----------
  function since() {
    let ready = null;
    try { ready = localStorage.getItem(`brewery-os.demo-ready.${brewery.id}`); } catch {}
    // (another device, or no storage: a couple of minutes after the demo was made is safely after it was filled)
    return ready || new Date(new Date(brewery.createdAt || 0).getTime() + 2 * 60 * 1000).toISOString();
  }
  const after = (t) => !!t && t > since();
  const mine = (list, test) => (list || []).filter((x) => after(x.recordedAt) && test(x)).at(-1) || null;

  // ---------- Picking what each job works on (from the demo's records today) ----------
  const inTank = () => data.batches.filter((b) => isInTank(b));
  const tankOf = (b) => data.tanks.find((t) => t.id === b.tankId);
  const lastGravity = (b) => data.cellar.filter((c) => c.batchId === b.id && c.gravitySg != null).map((c) => c.occurredOn).sort().at(-1) || "";
  const fermenting = () => inTank().filter((b) => ["fermenting", "dry-hopping"].includes(b.stage));
  // (the one that most needs a check: the longest since its last gravity)
  const checkBatch = () => fermenting().sort((x, y) => lastGravity(x).localeCompare(lastGravity(y)))[0] || inTank()[0] || null;
  const hopBatch = () => fermenting().find((b) => /IPA|Hazy/i.test(findBeer(b.beerId)?.style || "")) || fermenting()[0] || null;
  const freeBrite = (b) => data.tanks.filter((t) => t.type === "brite" && t.locationId === tankOf(b)?.locationId && t.status === "empty"
    && !batchInTank(t.id) && (t.capacityBbl ?? 0) >= (tankBalance(b.id, b.tankId) ?? 0)).sort((x, y) => x.capacityBbl - y.capacityBbl)[0] || null;
  const transferBatch = () => inTank().filter((b) => b.stage === "conditioning" && tankOf(b)?.type === "fermenter").find((b) => freeBrite(b)) || null;
  const packageBatch = () => inTank().find((b) => b.stage === "ready" && tankOf(b)?.type === "brite") || null;
  const taproom = () => (data.places || []).find((p) => p.kind === "taproom" && p.active && (data.pars || []).some((x) => x.placeId === p.id))
    || (data.places || []).find((p) => p.kind === "taproom" && p.active) || null;
  const label = (b) => `${beerName(b)} #${b.batchNumber}`;

  // ---------- Where things are on the page ----------
  const open = (id) => !!document.getElementById(id)?.open;
  const onBatch = (b) => currentView === "batch" && viewingBatchId === b?.id && document.getElementById("bv-brewday").hidden;
  const card = (b) => document.querySelector(`#tanks .card[data-tank="${b?.tankId}"]`);
  const toBatch = (b) => ({ hint: `Tap ${label(b)} (in ${tankOf(b)?.name}) on the tank board.`, target: () => card(b), active: () => true,
    help: () => { if (currentView !== "floor") showSettings(false); } });
  const inInventory = () => currentView === "inventory";

  // ---------- The jobs ----------
  const JOBS = [
    { id: "check", title: "Log today's check", who: "Cellar",
      goal: () => { const b = checkBatch(); return b ? `${label(b)} hasn't had a gravity reading lately. Log one (with temperature and pH, if you like).` : "Log a gravity reading on a batch."; },
      possible: () => !!checkBatch(),
      steps: () => { const b = checkBatch(); return [
        toBatch(b),
        { hint: "Tap + Log cellar work.", target: () => document.getElementById("bv-log"), active: () => onBatch(b) },
        { hint: "Type the gravity, and the temperature and pH if you like, then tap Save.", target: () => document.querySelector('#cellar-form [name="gravity"]'), active: () => open("cellar-editor") },
      ]; },
      done: () => mine(data.cellar, (c) => c.gravitySg != null),
      result: (r) => { openBatchView(r.batchId); return { target: "#bv-chart", text: "There's your reading: the newest point on the chart, and its pH on the strip under it. The numbers above (now, ABV, attenuation) moved with it." }; } },

    { id: "dryhop", title: "Dry hop a batch, with its lot", who: "Cellar",
      goal: () => { const b = hopBatch(); return b ? `${label(b)} is due its dry hop. Log the hops with a lot number from the list.` : "Log a dry hop with its lot number."; },
      possible: () => !!hopBatch(),
      steps: () => { const b = hopBatch(); return [
        toBatch(b),
        { hint: "Tap + Addition.", target: () => document.getElementById("bv-add"), active: () => onBatch(b) },
        { hint: "Type a hop (try Citra), how much, and pick a lot number from the list, then tap Save.", target: () => document.querySelector('#addition-form [name="name"]'), active: () => open("addition-editor") },
      ]; },
      done: () => mine(data.additions, (a) => !a.brewDay && (a.lot || "").trim() !== ""),
      result: (r) => {
        showView("inventory"); inventoryTab = "raw"; renderInventory(); showInventoryTab();
        return { target: "#raw-list", text: `${r.name} lot ${r.lot} is lower now: brewing uses raw materials up by name and lot, so the shelf and the batches that used each lot are always known.` };
      } },

    { id: "transfer", title: "Transfer a batch to a brite", who: "Cellar",
      goal: () => { const b = transferBatch(); return b ? `${label(b)} is conditioning in ${tankOf(b)?.name}. Move it to ${freeBrite(b)?.name}.` : "Move a conditioning batch to an empty brite. (No brite is free right now: package a batch first.)"; },
      possible: () => !!transferBatch(),
      steps: () => { const b = transferBatch(), brite = b && freeBrite(b); return [
        toBatch(b),
        { hint: "Tap Stage / transfer….", target: () => document.getElementById("bv-edit"), active: () => onBatch(b) },
        { hint: `Choose ${brite?.name} as the tank and Carbonating as the stage, then tap Save. (Leave the volume empty for all of it.)`,
          target: () => document.querySelector('#batch-form [name="tankId"]'), active: () => open("batch-editor") },
      ]; },
      done: () => mine(data.movements, (m) => m.kind === "transfer"),
      result: (r) => { openBatchView(r.batchId); return { target: "#bv-history", text: "Moved, with the volume, and what was left behind in the fermenter recorded as a loss. The fermenter went to Cleaning." }; } },

    { id: "package", title: "Package a batch", who: "Cellar",
      goal: () => { const b = packageBatch(); return b ? `${label(b)} is ready in ${tankOf(b)?.name}. Package it into kegs (and cans, if you like).` : "Package a batch that's ready."; },
      possible: () => !!packageBatch(),
      steps: () => { const b = packageBatch(); return [
        toBatch(b),
        { hint: "Tap Package….", target: () => document.getElementById("bv-package"), active: () => onBatch(b) },
        { hint: "Type how many of each you filled (it shows what's left as you type), choose \"Yes, it's spent\", then tap Save.",
          target: () => document.getElementById("package-rows"), active: () => open("package-editor") },
      ]; },
      done: () => mine(data.movements, (m) => m.kind === "package"),
      result: (r) => {
        const loc = tankOf({ tankId: r.fromTankId })?.locationId;
        const storage = (data.places || []).find((p) => p.kind === "storage" && p.locationId === loc);
        showView("inventory"); inventoryTab = "finished"; inventoryPlace = storage?.id || "all"; inventoryView = null; renderInventory(); showInventoryTab();
        return { target: "#inv-table", text: "There they are, in storage, from that batch. They'll leave oldest batch first when they're sold or moved." };
      } },

    { id: "bringup", title: "Bring kegs up to the taproom", who: "Taproom",
      goal: () => `${placeName(taproom()?.id)} is under par on a beer or two. Bring kegs up from storage.`,
      possible: () => !!taproom(),
      steps: () => { const t = taproom(); return [
        { hint: "Tap Inventory.", target: () => document.getElementById("open-inventory"), active: () => true, help: () => { if (currentView !== "floor") showSettings(false); } },
        { hint: `Choose ${placeName(t.id)}.`, target: () => document.querySelector(`#inv-places [data-place="${t.id}"]`), active: () => inInventory() },
        { hint: "Under its pars, tap Bring up next to a beer that's under.", target: () => document.querySelector("#inv-pars [data-bring]"), active: () => inInventory() && inventoryPlace === t.id },
        { hint: "It's filled in from the par: check the count, then tap Save.", target: () => document.querySelector('#stock-form button[type="submit"]'), active: () => open("stock-editor") },
      ]; },
      done: () => mine(data.stockMoves, (m) => m.kind === "moved" && (data.places || []).find((p) => p.id === m.toPlaceId)?.kind === "taproom"),
      result: (r) => {
        showView("inventory"); inventoryTab = "finished"; inventoryPlace = r.toPlaceId; inventoryView = null; renderInventory(); showInventoryTab();
        return { target: "#inv-pars", text: "Moved up, oldest batch first, and the par shows it. Storage has that many fewer." };
      } },

    { id: "line", title: "Put a beer on a draft line", who: "Taproom",
      goal: () => `Change what one of ${placeName(taproom()?.id)}'s lines pours, then see the TV menu.`,
      possible: () => !!taproom(),
      steps: () => { const t = taproom(); return [
        { hint: "Tap Inventory.", target: () => document.getElementById("open-inventory"), active: () => true, help: () => { if (currentView !== "floor") showSettings(false); } },
        { hint: `Choose ${placeName(t.id)}.`, target: () => document.querySelector(`#inv-places [data-place="${t.id}"]`), active: () => inInventory() },
        { hint: "Under Draft lines, tap a line.", target: () => document.querySelector("#inv-lines [data-line]"), active: () => inInventory() && inventoryPlace === t.id },
        { hint: "Choose a beer, then tap Save.", target: () => document.querySelector('#line-form [name="beerId"]'), active: () => open("line-editor") },
      ]; },
      done: () => (data.lines || []).filter((l) => after(l.updatedAt)).at(-1) || null,
      result: (r) => {
        const board = (data.boards || []).find((b) => b.placeId === r.placeId && b.showOnTap) || newBoard(r.placeId);
        openBoardPreview(board);
        return { text: "There it is on the TV menu: change a line and the TV updates by itself within seconds." };
      } },

    { id: "plan", title: "Plan next week's brew day", who: "Head brewer",
      goal: () => "Plan a brew day next week, in a tank, for a beer. The calendar says if the tank won't be empty in time.",
      possible: () => true,
      steps: () => [
        { hint: "Tap Calendar.", target: () => document.getElementById("open-calendar"), active: () => true, help: () => { if (currentView !== "floor") showSettings(false); } },
        { hint: "Tap + Plan.", target: () => document.getElementById("cal-add"), active: () => currentView === "calendar" },
        { hint: "Choose Brew day, a beer, a tank, and a day next week, then tap Save.", target: () => document.querySelector('#plan-form [name="kind"]'), active: () => open("plan-editor") },
      ],
      done: () => (data.planItems || []).filter((p) => after(p.createdAt)).at(-1) || null,
      result: (r) => {
        showView("calendar"); renderCalendar();
        return { target: `#cal-grid [data-plan="${r.id}"]`, text: "There's your plan. If it's marked ⚠, the tank won't be empty in time; the shopping list counts what it needs." };
      } },
  ];

  const doneCount = () => JOBS.filter((j) => { try { return !!j.done(); } catch { return false; } }).length;

  // ---------- The list ----------
  function renderPanel() {
    const list = document.getElementById("tryit-list");
    list.innerHTML = JOBS.map((j) => {
      let done = null, possible = true, goal = "";
      try { done = j.done(); possible = j.possible(); goal = j.goal(); } catch {}
      return `<li class="tryit-job${done ? " done" : ""}" data-job="${j.id}">
        <span class="tryit-tick" aria-hidden="true">${done ? "✓" : ""}</span>
        <div><strong>${esc(j.title)}</strong> <span class="tag">${esc(j.who)}</span>
          <div class="muted">${esc(goal)}</div></div>
        ${done ? `<button type="button" class="btn small" data-see="${j.id}">See it</button>`
          : `<button type="button" class="btn small primary" data-show="${j.id}" ${possible ? "" : "disabled"}>Show me</button>`}</li>`;
    }).join("");
    document.getElementById("tryit-count").textContent = `${doneCount()} of ${JOBS.length} done`;
  }
  function openPanel() {
    stop();
    renderPanel();
    document.getElementById("tryit-panel").showModal();
  }

  // ---------- Show me: the hint and the pulsing target ----------
  function ensureHint() {
    if (hint) return;
    hint = document.createElement("div");
    hint.className = "coach-hint";
    hint.setAttribute("popover", "manual");
    hint.setAttribute("role", "status");
    hint.innerHTML = `<p class="coach-text"></p><div class="coach-actions"><button type="button" class="btn small" data-coach="list">The list</button>
      <button type="button" class="btn small" data-coach="stop">Stop</button></div>`;
    hint.addEventListener("click", (e) => {
      const act = e.target.closest("[data-coach]")?.dataset.coach;
      if (act === "stop") stop();
      if (act === "list") openPanel();
      if (act === "ok") stop();
    });
    document.body.append(hint);
  }
  // The hint lives inside an open form when there is one (outside it, a form makes the page untappable)
  function placeHint(target) {
    const forms = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal"));
    const home = forms.at(-1) || document.body;
    try {
      if (hint.parentElement !== home || !hint.matches(":popover-open")) {
        if (hint.matches(":popover-open")) hint.hidePopover();
        home.append(hint);
        hint.showPopover();
      }
    } catch {}
    const r = target?.getBoundingClientRect();
    const phone = innerWidth <= 600;
    hint.classList.toggle("coach-bottom", phone || !r || !r.width);
    if (!phone && r && r.width) {
      const h = hint.offsetHeight, w = Math.min(340, innerWidth - 24);
      const top = r.bottom + 10 + h <= innerHeight - 8 ? r.bottom + 10 : Math.max(8, r.top - 10 - h);
      Object.assign(hint.style, { top: `${top}px`, left: `${Math.min(Math.max(12, r.left), innerWidth - w - 12)}px`, width: `${w}px` });
    } else {
      Object.assign(hint.style, { top: "", left: "", width: "" });
    }
  }
  function pulse(el) {
    if (pulsed === el) return;
    pulsed?.classList.remove("coach-target");
    pulsed = el || null;
    pulsed?.classList.add("coach-target");
  }

  function tick() {
    if (!job || finishing) return;
    let record = null;
    try { record = job.done(); } catch {}
    if (record) { finish(record); return; }
    const steps = job.steps();
    // The step to show: the furthest one whose moment has come (backing out goes back a step)
    let step = steps[0];
    for (const s of steps) if (s.active()) step = s;
    const target = step.target();
    if (target && !target.matches(":disabled")) {
      const r = target.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) target.scrollIntoView({ block: "center", behavior: "instant" });
    }
    pulse(target);
    hint.querySelector(".coach-text").textContent = step.hint;
    hint.querySelector(".coach-actions").innerHTML = `<button type="button" class="btn small" data-coach="list">The list</button>
      <button type="button" class="btn small" data-coach="stop">Stop</button>`;
    placeHint(target);
  }

  function show(id) {
    stop();
    job = JOBS.find((j) => j.id === id);
    if (!job) return;
    document.getElementById("tryit-panel").close();
    ensureHint();
    const first = job.steps()[0];
    try { first.help?.(); } catch {}
    tick();
    ticker = setInterval(tick, 400);
  }

  // Done: say so, and point at what the app worked out from it
  async function finish(record) {
    finishing = true;
    clearInterval(ticker);
    ticker = null;
    pulse(null);
    const j = job;
    job = null;
    let shown = null;
    try { shown = j.result(record); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    const target = shown?.target ? document.querySelector(shown.target) : null;
    if (target) { target.scrollIntoView({ block: "center", behavior: "instant" }); pulse(target); }
    hint.querySelector(".coach-text").innerHTML = `<strong>✓ ${esc(j.title)}: done.</strong> ${esc(shown?.text || "")}`;
    hint.querySelector(".coach-actions").innerHTML = `<button type="button" class="btn small primary" data-coach="list">Next job</button>
      <button type="button" class="btn small" data-coach="ok">OK</button>`;
    placeHint(target);
    renderDemoBarCount();
    finishing = false;
  }

  function stop() {
    clearInterval(ticker);
    ticker = null;
    job = null;
    pulse(null);
    try { hint?.hidePopover(); } catch {}
    if (hint) document.body.append(hint);
  }

  // The demo bar's button: "Try it yourself (2 of 7)"
  function renderDemoBarCount() {
    const b = document.getElementById("try-it");
    if (b && brewery?.isDemo) b.textContent = `Try it yourself (${doneCount()} of ${JOBS.length})`;
  }

  document.getElementById("tryit-list").addEventListener("click", (e) => {
    const showId = e.target.closest("[data-show]")?.dataset.show;
    const seeId = e.target.closest("[data-see]")?.dataset.see;
    if (showId) show(showId);
    if (seeId) {
      const j = JOBS.find((x) => x.id === seeId);
      document.getElementById("tryit-panel").close();
      ensureHint();
      job = j;
      finish(j.done());
    }
  });
  document.getElementById("try-it").addEventListener("click", openPanel);

  window.TryIt = { open: openPanel, show, stop, doneCount, render: renderDemoBarCount, jobs: () => JOBS.map((j) => j.id), get guiding() { return job?.id ?? null; } };
})();
