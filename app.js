// Brewery OS — tank dashboard
// Everything the page does lives in this one file.
//
// Two kinds of things:
//   TANKS   — equipment. They stay put. (FV-1, BT-2...)
//   BATCHES — beer. A batch sits in one tank at a time, moves between tanks,
//             and leaves the tanks for good once it's packaged.

// ---------- 1. The list of stages ----------
// Order matters: this is the order they appear in the Stage dropdown.
const STAGES = [
  { id: "fermenting",   label: "Fermenting" },
  { id: "dry-hopping",  label: "Dry hopping" },
  { id: "conditioning", label: "Conditioning" },
  { id: "carbonating",  label: "Carbonating" },
  { id: "ready",        label: "Ready" },
  { id: "packaged",     label: "Packaged" }, // packaged = out of the tank
];

const TANK_TYPES = [
  { id: "fermenter", label: "Fermenter" },
  { id: "brite",     label: "Brite tank" },
  { id: "serving",   label: "Serving tank" },
  { id: "lagering",  label: "Lagering tank" },
];

// A tank's status. "occupied" is never saved: a tank is occupied whenever
// a batch is in it. The other three are set by a person.
const TANK_STATUSES = [
  { id: "empty",       label: "Empty" },
  { id: "occupied",    label: "Occupied" },
  { id: "cleaning",    label: "Cleaning" },
  { id: "maintenance", label: "Maintenance" },
];

// ---------- 2. Small helpers ----------
function toDateString(d) {
  // "2026-10-05" format, using the local date (not UTC)
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function today() {
  return toDateString(new Date());
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateString(d);
}

function daysSince(dateString) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((now - parseDate(dateString)) / 86400000)); // 86,400,000 ms in a day
}

// "2026-09-29" -> "Sep 29"
function formatDate(dateString) {
  return parseDate(dateString).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Look up the display label for a stage, tank type, or status id
function labelFrom(list, id) {
  return (list.find((item) => item.id === id) || {}).label || id;
}
const stageLabel = (id) => labelFrom(STAGES, id);

// Every tank and batch gets a hidden internal ID that never changes.
// That way you can rename a tank or fix a typo in a batch number
// without breaking the link between a batch and its tank.
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Escape text before putting it into HTML, so a beer named "<Hop & Glory>" can't break the page
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// ---------- 3. Sample data ----------
// Dates are written as "N days ago" so the samples always look fresh.
function sampleData() {
  return {
    tanks: [
      { id: "fv1", name: "FV-1", type: "fermenter", capacityBbl: 15, location: "Downtown", status: "empty" },
      { id: "fv2", name: "FV-2", type: "fermenter", capacityBbl: 15, location: "Downtown", status: "empty" },
      { id: "fv3", name: "FV-3", type: "fermenter", capacityBbl: 15, location: "Downtown", status: "empty" },
      { id: "bt1", name: "BT-1", type: "brite",     capacityBbl: 15, location: "Downtown", status: "empty" },
      { id: "fv4", name: "FV-4", type: "fermenter", capacityBbl: 7,  location: "Riverside",   status: "empty" },
      { id: "bt2", name: "BT-2", type: "brite",     capacityBbl: 7,  location: "Riverside",   status: "empty" },
      { id: "st1", name: "ST-1", type: "serving",   capacityBbl: 7,  location: "Riverside",   status: "cleaning" },
    ],
    batches: [
      { id: "b1042", batchId: "1042", beerName: "House Hazy",           brewDate: daysAgo(4),  sizeBbl: 15, stage: "fermenting",   stageStartDate: daysAgo(4),  tankId: "fv1" },
      { id: "b1041", batchId: "1041", beerName: "West Coast IPA", brewDate: daysAgo(9),  sizeBbl: 15, stage: "dry-hopping",  stageStartDate: daysAgo(2),  tankId: "fv2" },
      { id: "b1038", batchId: "1038", beerName: "Czech Pilsner",  brewDate: daysAgo(32), sizeBbl: 15, stage: "conditioning", stageStartDate: daysAgo(18), tankId: "fv3" },
      { id: "b1040", batchId: "1040", beerName: "Oatmeal Stout",  brewDate: daysAgo(9),  sizeBbl: 7,  stage: "fermenting",   stageStartDate: daysAgo(9),  tankId: "fv4" },
      { id: "b1039", batchId: "1039", beerName: "Kölsch",         brewDate: daysAgo(25), sizeBbl: 15, stage: "carbonating",  stageStartDate: daysAgo(1),  tankId: "bt1" },
      { id: "b1037", batchId: "1037", beerName: "Amber Ale",      brewDate: daysAgo(21), sizeBbl: 7,  stage: "ready",        stageStartDate: daysAgo(3),  tankId: "bt2" },
      { id: "b1036", batchId: "1036", beerName: "Pale Ale",       brewDate: daysAgo(28), sizeBbl: 15, stage: "packaged",     stageStartDate: daysAgo(5),  tankId: "bt1" },
      { id: "b1035", batchId: "1035", beerName: "Robust Porter",  brewDate: daysAgo(35), sizeBbl: 7,  stage: "packaged",     stageStartDate: daysAgo(12), tankId: "bt2" },
    ],
  };
}

// ---------- 4. Saving and loading ----------
// localStorage is a small storage space the browser gives each website.
// It survives closing the tab, but it lives only in THIS browser on THIS device.
const STORAGE_KEY = "brewery-os.data";
const OLD_STORAGE_KEY = "brewery-os.tanks"; // where the first version (no batches) saved things

function loadData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return fillInNewTankFields(JSON.parse(saved));

    // If you entered tanks in the first version, carry them over instead of losing them
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if (old) return convertOldData(JSON.parse(old));
  } catch (e) {
    console.warn("Couldn't read saved data, using samples instead.", e);
  }
  return sampleData();
}

// First version stored the beer right on the tank. Split it into a tank + a batch.
// Old data had no batch number or size, so those start blank for you to fill in.
function convertOldData(oldTanks) {
  const data = { tanks: [], batches: [] };
  for (const t of oldTanks) {
    const tank = { id: newId(), name: t.tank, type: t.type };
    data.tanks.push(tank);
    if (t.beer && t.stage !== "empty") {
      data.batches.push({
        id: newId(), batchId: "", beerName: t.beer, brewDate: t.stageStart, sizeBbl: null,
        stage: t.stage, stageStartDate: t.stageStart, tankId: tank.id,
      });
    }
  }
  return fillInNewTankFields(data);
}

// Tanks saved before capacity/location/status existed get blank values
function fillInNewTankFields(data) {
  for (const tank of data.tanks) {
    tank.capacityBbl ??= null;
    tank.location ??= "";
    tank.status ??= "empty";
  }
  return data;
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    alert("Couldn't save. Changes will be lost when you close this page.");
  }
}

let data = loadData();
saveData(); // lock in sample/converted data so the day counters keep counting from here

// ---------- 5. Looking things up ----------
function isInTank(batch) {
  return batch.stage !== "packaged";
}

// The batch currently in a tank (or undefined if the tank is empty)
function batchInTank(tankId) {
  return data.batches.find((b) => b.tankId === tankId && isInTank(b));
}

function findTank(tankId) {
  return data.tanks.find((t) => t.id === tankId);
}

function tankName(tankId) {
  const tank = findTank(tankId);
  return tank ? tank.name : "?";
}

// "occupied" if a batch is inside; otherwise whatever a person set (empty, cleaning, maintenance)
function tankStatus(tank) {
  return batchInTank(tank.id) ? "occupied" : tank.status;
}

function batchLabel(batch) {
  return batch.batchId ? `#${esc(batch.batchId)}` : "No batch #";
}

// ---------- 6. Drawing the page ----------
const tanksArea = document.getElementById("tanks");
const packagedSection = document.getElementById("packaged");
const packagedList = document.getElementById("packaged-list");

function allLocations() {
  return [...new Set(data.tanks.map((t) => t.location))];
}

function render() {
  // One group of cards per location. Headings only show if there's more than one location.
  const locations = allLocations();
  tanksArea.innerHTML = locations.map((loc) => `
    <section class="location">
      ${locations.length > 1 ? `<h2>${esc(loc || "No location")}</h2>` : ""}
      <div class="grid">
        ${data.tanks.filter((t) => t.location === loc).map(tankCard).join("")}
      </div>
    </section>`).join("");

  // Packaged batches, newest first
  const packaged = data.batches
    .filter((b) => !isInTank(b))
    .sort((a, b) => b.stageStartDate.localeCompare(a.stageStartDate));
  packagedSection.hidden = packaged.length === 0;
  packagedList.innerHTML = packaged.map((b) => `
    <li>
      <button class="row" data-batch="${b.id}">
        <span><strong>${esc(b.beerName)}</strong> <span class="muted">${batchLabel(b)}</span></span>
        <span class="muted">Packaged ${formatDate(b.stageStartDate)}</span>
      </button>
    </li>`).join("");
}

function tankCard(tank) {
  const batch = batchInTank(tank.id);
  // Capacity only on empty tanks; a full tank shows the batch size instead
  const capacity = tank.capacityBbl && !batch ? ` · ${tank.capacityBbl} bbl` : "";
  const header = `
    <div class="tank-row">
      <span class="tank">${esc(tank.name)}</span>
      <span class="type">${labelFrom(TANK_TYPES, tank.type)}${capacity}</span>
    </div>`;

  if (!batch) {
    const hint = tank.status === "empty" ? "Tap to start a batch" : "Tap to update status";
    return `
      <button class="card" data-tank="${tank.id}" style="--stage-color: var(--${tank.status})">
        ${header}
        <div class="beer none">${labelFrom(TANK_STATUSES, tank.status)}</div>
        <div class="meta">${hint}</div>
      </button>`;
  }

  const days = daysSince(batch.stageStartDate);
  const size = batch.sizeBbl ? ` · ${batch.sizeBbl} bbl` : "";
  return `
    <button class="card" data-tank="${tank.id}" style="--stage-color: var(--${batch.stage})">
      ${header}
      <div class="beer">${esc(batch.beerName)}</div>
      <div class="meta">${batchLabel(batch)}${size} · brewed ${formatDate(batch.brewDate)}</div>
      <div class="stage-row">
        <span class="badge">${stageLabel(batch.stage)}</span>
        <span class="days">${days} <small>${days === 1 ? "day" : "days"}</small></span>
      </div>
    </button>`;
}

// ---------- 7. Editing a batch ----------
const batchDialog = document.getElementById("batch-editor");
const batchForm = document.getElementById("batch-form");
let editingBatch = null;  // the batch open in the form, or null when starting a new one
let editingTankId = null; // the tank card that was tapped (for the "Tank settings" link)

// Fill the Stage dropdown from the STAGES list above
batchForm.stage.innerHTML = STAGES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

function openBatchEditor(batch, tankId) {
  editingBatch = batch;
  editingTankId = tankId;
  const b = batch || {
    batchId: "", beerName: "", brewDate: today(), sizeBbl: "",
    stage: "fermenting", stageStartDate: today(), tankId,
  };

  // Tank dropdown: show what's in each tank (or that it's being cleaned)
  // so you don't move beer into the wrong one
  const showLocation = allLocations().length > 1;
  batchForm.tankId.innerHTML = data.tanks.map((t) => {
    const occupant = batchInTank(t.id);
    let note = "";
    if (occupant && occupant !== batch) note = ` (has ${esc(occupant.beerName)})`;
    else if (!occupant && t.status !== "empty") note = ` (${labelFrom(TANK_STATUSES, t.status).toLowerCase()})`;
    const where = showLocation && t.location ? ` · ${esc(t.location)}` : "";
    return `<option value="${t.id}">${esc(t.name)}${where}${note}</option>`;
  }).join("");

  document.getElementById("batch-title").textContent =
    batch ? `${batch.beerName} ${batch.batchId ? "#" + batch.batchId : ""}` : `New batch in ${tankName(tankId)}`;
  document.getElementById("delete-batch").hidden = !batch;
  document.getElementById("open-tank-settings").hidden = !tankId;

  batchForm.batchId.value = b.batchId;
  batchForm.beerName.value = b.beerName;
  batchForm.brewDate.value = b.brewDate;
  batchForm.sizeBbl.value = b.sizeBbl ?? "";
  batchForm.tankId.value = b.tankId;
  batchForm.stage.value = b.stage;
  batchForm.stageStartDate.value = b.stageStartDate;
  batchDialog.showModal();
}

// When you pick a new stage, assume it started today (you can still change the date)
batchForm.stage.addEventListener("change", () => {
  batchForm.stageStartDate.value = today();
});

batchForm.addEventListener("submit", (e) => {
  e.preventDefault(); // we'll close the form ourselves, after checking for problems
  const values = {
    batchId: batchForm.batchId.value.trim(),
    beerName: batchForm.beerName.value.trim(),
    brewDate: batchForm.brewDate.value,
    sizeBbl: batchForm.sizeBbl.value ? Number(batchForm.sizeBbl.value) : null,
    tankId: batchForm.tankId.value,
    stage: batchForm.stage.value,
    stageStartDate: batchForm.stageStartDate.value,
  };
  const others = data.batches.filter((b) => b !== editingBatch);

  // Check 1: batch numbers must be unique
  if (others.some((b) => b.batchId.toLowerCase() === values.batchId.toLowerCase())) {
    alert(`There's already a batch #${values.batchId}.`);
    return;
  }

  const target = findTank(values.tankId);
  const willBeInTank = values.stage !== "packaged";
  const wasInTank = editingBatch && isInTank(editingBatch);
  const movingIn = willBeInTank && !(wasInTank && editingBatch.tankId === values.tankId);

  if (willBeInTank) {
    // Check 2: one batch per tank
    const occupant = others.find((b) => b.tankId === values.tankId && isInTank(b));
    if (occupant) {
      alert(`${target.name} already has ${occupant.beerName} in it. Move or package that batch first.`);
      return;
    }

    // Check 3: is the tank being cleaned or worked on? (Just a warning — you might have finished)
    if (movingIn && target.status !== "empty") {
      const status = labelFrom(TANK_STATUSES, target.status).toLowerCase();
      if (!confirm(`${target.name} is marked as ${status}. Put ${values.beerName} in it anyway?`)) return;
    }

    // Check 4: will the beer fit? (Also just a warning)
    if (values.sizeBbl && target.capacityBbl && values.sizeBbl > target.capacityBbl) {
      if (!confirm(`${values.sizeBbl} bbl is more than ${target.name} holds (${target.capacityBbl} bbl). Save anyway?`)) return;
    }
  }

  // If beer is leaving a tank (transferred or packaged), that tank needs cleaning next
  const leavingTankId = wasInTank && (!willBeInTank || editingBatch.tankId !== values.tankId)
    ? editingBatch.tankId
    : null;

  if (editingBatch) Object.assign(editingBatch, values);
  else data.batches.push({ id: newId(), ...values });

  if (leavingTankId && findTank(leavingTankId)) findTank(leavingTankId).status = "cleaning";
  // The tank's saved status only matters once it's empty again, so reset it when beer goes in
  if (movingIn) target.status = "empty";
  saveData();
  render();
  batchDialog.close();
});

document.getElementById("delete-batch").addEventListener("click", () => {
  if (!confirm(`Delete ${editingBatch.beerName}? This can't be undone.`)) return;
  data.batches = data.batches.filter((b) => b !== editingBatch);
  saveData();
  render();
  batchDialog.close();
});

document.getElementById("open-tank-settings").addEventListener("click", () => {
  batchDialog.close();
  openTankEditor(findTank(editingTankId));
});

// ---------- 8. Editing a tank ----------
const tankDialog = document.getElementById("tank-editor");
const tankForm = document.getElementById("tank-form");
let editingTank = null; // the tank open in the form, or null when adding a new one

// Fill the Type dropdown from the TANK_TYPES list above
tankForm.type.innerHTML = TANK_TYPES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("");

function openTankEditor(tank) {
  editingTank = tank;
  const t = tank || { name: "", type: "fermenter", capacityBbl: null, location: "", status: "empty" };
  const batch = tank && batchInTank(tank.id);

  document.getElementById("tank-title").textContent = tank ? `Edit ${tank.name}` : "Add tank";
  document.getElementById("delete-tank").hidden = !tank;

  // Suggest locations you've already used, so "Riverside" doesn't also end up as "riverside"
  document.getElementById("location-options").innerHTML =
    allLocations().filter(Boolean).map((loc) => `<option value="${esc(loc)}">`).join("");

  // Status can only be set by hand when the tank is empty
  document.getElementById("status-field").hidden = !!batch;
  document.getElementById("occupied-note").hidden = !batch;
  if (batch) {
    document.getElementById("occupied-note").textContent =
      `Occupied by ${batch.beerName}${batch.batchId ? " #" + batch.batchId : ""}.`;
  }

  tankForm.name.value = t.name;
  tankForm.type.value = t.type;
  tankForm.capacityBbl.value = t.capacityBbl ?? "";
  // A new tank goes in the same location as the last tank, as a starting guess
  tankForm.location.value = tank ? t.location : (data.tanks.at(-1)?.location ?? "");
  tankForm.status.value = t.status;
  tankDialog.showModal();
}

tankForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const values = {
    name: tankForm.name.value.trim(),
    type: tankForm.type.value,
    capacityBbl: tankForm.capacityBbl.value ? Number(tankForm.capacityBbl.value) : null,
    location: tankForm.location.value.trim(),
    status: tankForm.status.value,
  };
  if (data.tanks.some((t) => t !== editingTank && t.name.toLowerCase() === values.name.toLowerCase())) {
    alert(`There's already a tank called ${values.name}.`);
    return;
  }
  if (editingTank) Object.assign(editingTank, values);
  else data.tanks.push({ id: newId(), ...values });
  saveData();
  render();
  tankDialog.close();
});

document.getElementById("delete-tank").addEventListener("click", () => {
  const batch = batchInTank(editingTank.id);
  if (batch) {
    alert(`${editingTank.name} has ${batch.beerName} in it. Move or package that batch first.`);
    return;
  }
  if (!confirm(`Delete ${editingTank.name}?`)) return;
  data.tanks = data.tanks.filter((t) => t !== editingTank);
  saveData();
  render();
  tankDialog.close();
});

// ---------- 9. Wiring up taps and clicks ----------
// Tapping a tank card opens its batch (or a blank "new batch" form if it's empty)
// ...unless it's being cleaned or worked on, then it opens the tank so you can mark it ready
tanksArea.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const tank = findTank(card.dataset.tank);
  const batch = batchInTank(tank.id);
  if (!batch && tank.status !== "empty") openTankEditor(tank);
  else openBatchEditor(batch || null, tank.id);
});

// Tapping a packaged batch opens it (to fix mistakes)
packagedList.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  openBatchEditor(data.batches.find((b) => b.id === row.dataset.batch), null);
});

document.getElementById("add-tank").addEventListener("click", () => openTankEditor(null));

// Every Cancel button closes whichever pop-up it's in
document.querySelectorAll(".cancel").forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog").close())
);

// ---------- 10. Go ----------
render();
