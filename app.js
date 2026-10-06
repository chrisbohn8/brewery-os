// Brewery OS — tank dashboard
// Everything the page does lives in this one file.
//
// Four kinds of things:
//   LOCATIONS — the brewery's facilities. Tanks point at these.
//   BEERS     — the product. "House Hazy" the recipe: style and target numbers.
//   TANKS     — equipment. They stay put. (FV-1, BT-2...)
//   BATCHES   — one actual brew of a beer. A batch points at its beer and at the
//               tank it's in, moves between tanks, and leaves the tanks for good
//               once it's packaged.

// ---------- 1. Fixed lists ----------
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

// Beers get a readable ID made from the name: "House Hazy" -> "house-hazy", "Kölsch" -> "kolsch".
// It's set once when the beer is created and never changes, even if you rename the beer.
function beerIdFor(name, beers) {
  const base = name.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // ö -> o
    .replace(/[^a-z0-9]+/g, "-")                      // spaces and symbols -> dashes
    .replace(/^-|-$/g, "") || "beer";
  let id = base;
  for (let n = 2; beers.some((b) => b.id === id); n++) id = `${base}-${n}`; // "house-hazy-2" if "house-hazy" is taken
  return id;
}

// Standard homebrew/craft ABV formula: (OG - FG) × 131.25
function abv(og, fg) {
  return og && fg ? (og - fg) * 131.25 : null;
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
    locations: [
      { id: "downtown",  name: "Downtown" },
      { id: "riverside", name: "Riverside" },
    ],
    beers: [
      { id: "house-hazy",     name: "House Hazy",     style: "Hazy IPA",           targetOg: 1.066, targetFg: 1.016 },
      { id: "west-coast-ipa", name: "West Coast IPA", style: "American IPA",       targetOg: 1.062, targetFg: 1.010 },
      { id: "czech-pilsner",  name: "Czech Pilsner",  style: "Czech Pale Lager",   targetOg: 1.048, targetFg: 1.012 },
      { id: "oatmeal-stout",  name: "Oatmeal Stout",  style: "Oatmeal Stout",      targetOg: 1.058, targetFg: 1.016 },
      { id: "kolsch",         name: "Kölsch",         style: "Kölsch",             targetOg: 1.046, targetFg: 1.009 },
      { id: "amber-ale",      name: "Amber Ale",      style: "American Amber Ale", targetOg: 1.054, targetFg: 1.013 },
      { id: "pale-ale",       name: "Pale Ale",       style: "American Pale Ale",  targetOg: 1.050, targetFg: 1.011 },
      { id: "robust-porter",  name: "Robust Porter",  style: "American Porter",    targetOg: 1.060, targetFg: 1.016 },
    ],
    tanks: [
      { id: "fv1", name: "FV-1", type: "fermenter", capacityBbl: 15, locationId: "downtown",  status: "empty" },
      { id: "fv2", name: "FV-2", type: "fermenter", capacityBbl: 15, locationId: "downtown",  status: "empty" },
      { id: "fv3", name: "FV-3", type: "fermenter", capacityBbl: 15, locationId: "downtown",  status: "empty" },
      { id: "bt1", name: "BT-1", type: "brite",     capacityBbl: 15, locationId: "downtown",  status: "empty" },
      { id: "fv4", name: "FV-4", type: "fermenter", capacityBbl: 7,  locationId: "riverside", status: "empty" },
      { id: "bt2", name: "BT-2", type: "brite",     capacityBbl: 7,  locationId: "riverside", status: "empty" },
      { id: "st1", name: "ST-1", type: "serving",   capacityBbl: 7,  locationId: "riverside", status: "cleaning" },
    ],
    batches: [
      { id: "b1042", batchId: "1042", beerId: "house-hazy",     brewDate: daysAgo(4),  sizeBbl: 15, stage: "fermenting",   stageStartDate: daysAgo(4),  tankId: "fv1" },
      { id: "b1041", batchId: "1041", beerId: "west-coast-ipa", brewDate: daysAgo(9),  sizeBbl: 15, stage: "dry-hopping",  stageStartDate: daysAgo(2),  tankId: "fv2" },
      { id: "b1038", batchId: "1038", beerId: "czech-pilsner",  brewDate: daysAgo(32), sizeBbl: 15, stage: "conditioning", stageStartDate: daysAgo(18), tankId: "fv3" },
      { id: "b1040", batchId: "1040", beerId: "oatmeal-stout",  brewDate: daysAgo(9),  sizeBbl: 7,  stage: "fermenting",   stageStartDate: daysAgo(9),  tankId: "fv4" },
      { id: "b1039", batchId: "1039", beerId: "kolsch",         brewDate: daysAgo(25), sizeBbl: 15, stage: "carbonating",  stageStartDate: daysAgo(1),  tankId: "bt1" },
      { id: "b1037", batchId: "1037", beerId: "amber-ale",      brewDate: daysAgo(21), sizeBbl: 7,  stage: "ready",        stageStartDate: daysAgo(3),  tankId: "bt2" },
      { id: "b1036", batchId: "1036", beerId: "pale-ale",       brewDate: daysAgo(28), sizeBbl: 15, stage: "packaged",     stageStartDate: daysAgo(5),  tankId: "bt1" },
      { id: "b1035", batchId: "1035", beerId: "robust-porter",  brewDate: daysAgo(35), sizeBbl: 7,  stage: "packaged",     stageStartDate: daysAgo(12), tankId: "bt2" },
    ],
  };
}

// ---------- 4. Saving and loading ----------
// localStorage is a small storage space the browser gives each website.
// It survives closing the tab, but it lives only in THIS browser on THIS device.
const STORAGE_KEY = "brewery-os.data";
const OLD_STORAGE_KEY = "brewery-os.tanks"; // where the first version (no batches) saved things

function loadData() {
  let loaded = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if (saved) loaded = JSON.parse(saved);
    // If you entered tanks in the first version, carry them over instead of losing them
    else if (old) loaded = convertOldData(JSON.parse(old));
  } catch (e) {
    console.warn("Couldn't read saved data, using samples instead.", e);
  }
  return loaded ? upgradeData(loaded) : sampleData();
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
  return data;
}

// Bring data saved by an older version up to date
function upgradeData(data) {
  // Tanks saved before capacity/status existed get blank values
  for (const tank of data.tanks) {
    tank.capacityBbl ??= null;
    tank.status ??= "empty";
  }

  // Tanks saved before locations were their own records had the location name typed in.
  // Make one location per name, and point the tanks at it.
  data.locations ??= [];
  for (const tank of data.tanks) {
    if (tank.locationId !== undefined) continue;
    const name = (tank.location || "").trim();
    let location = data.locations.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (name && !location) {
      location = { id: newId(), name };
      data.locations.push(location);
    }
    tank.locationId = location ? location.id : null;
    delete tank.location;
  }

  // Batches saved before beers existed had the beer name typed in.
  // Make one beer per name, and point the batches at it.
  data.beers ??= [];
  for (const batch of data.batches) {
    if (batch.beerId) continue;
    const name = batch.beerName || "Unnamed beer";
    let beer = data.beers.find((b) => b.name.toLowerCase() === name.toLowerCase());
    if (!beer) {
      beer = { id: beerIdFor(name, data.beers), name, style: "", targetOg: null, targetFg: null };
      data.beers.push(beer);
    }
    batch.beerId = beer.id;
    delete batch.beerName;
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

function findLocation(locationId) {
  return data.locations.find((l) => l.id === locationId);
}

// The location's name, or "" if the tank has none
function locationName(tank) {
  return findLocation(tank.locationId)?.name ?? "";
}

function findBeer(beerId) {
  return data.beers.find((b) => b.id === beerId);
}

// The name of the beer a batch is a brew of
function beerName(batch) {
  const beer = findBeer(batch.beerId);
  return beer ? beer.name : "Unknown beer";
}

function beersByName() {
  return [...data.beers].sort((a, b) => a.name.localeCompare(b.name));
}

function batchLabel(batch) {
  return batch.batchId ? `#${esc(batch.batchId)}` : "No batch #";
}

// "OG 1.066 · FG 1.016 · 6.6%" (skipping any that aren't filled in)
function targetsText(beer) {
  const parts = [];
  if (beer.targetOg) parts.push(`OG ${beer.targetOg.toFixed(3)}`);
  if (beer.targetFg) parts.push(`FG ${beer.targetFg.toFixed(3)}`);
  const a = abv(beer.targetOg, beer.targetFg);
  if (a !== null) parts.push(`${a.toFixed(1)}%`);
  return parts.join(" · ");
}

// ---------- 6. Drawing the page ----------
const tanksArea = document.getElementById("tanks");
const packagedSection = document.getElementById("packaged");
const packagedList = document.getElementById("packaged-list");
const beerList = document.getElementById("beer-list");

const locationList = document.getElementById("location-list");

// Tanks split up by location, in the order the locations were added.
// Tanks with no location (or one that's been deleted) go in a group at the end.
function tankGroups() {
  const groups = data.locations.map((loc) => ({
    name: loc.name,
    tanks: data.tanks.filter((t) => t.locationId === loc.id),
  }));
  const unplaced = data.tanks.filter((t) => !findLocation(t.locationId));
  if (unplaced.length) groups.push({ name: "No location", tanks: unplaced });
  return groups.filter((g) => g.tanks.length);
}

function render() {
  // One group of cards per location. Headings only show if there's more than one group.
  const groups = tankGroups();
  tanksArea.innerHTML = groups.map((g) => `
    <section class="location">
      ${groups.length > 1 ? `<h2>${esc(g.name)}</h2>` : ""}
      <div class="grid">${g.tanks.map(tankCard).join("")}</div>
    </section>`).join("");

  // Packaged batches, newest first
  const packaged = data.batches
    .filter((b) => !isInTank(b))
    .sort((a, b) => b.stageStartDate.localeCompare(a.stageStartDate));
  packagedSection.hidden = packaged.length === 0;
  packagedList.innerHTML = packaged.map((b) => `
    <li>
      <button class="row" data-batch="${b.id}">
        <span><strong>${esc(beerName(b))}</strong> <span class="muted">${batchLabel(b)}</span></span>
        <span class="muted">Packaged ${formatDate(b.stageStartDate)}</span>
      </button>
    </li>`).join("");

  // Beers, A to Z
  beerList.innerHTML = beersByName().map((beer) => `
    <li>
      <button class="row stacked" data-beer="${esc(beer.id)}">
        <span><strong>${esc(beer.name)}</strong> <span class="muted">${esc(beer.style)}</span></span>
        <span class="muted">${targetsText(beer)}</span>
      </button>
    </li>`).join("");

  // Locations, in the order they were added
  locationList.innerHTML = data.locations.map((loc) => {
    const count = data.tanks.filter((t) => t.locationId === loc.id).length;
    return `
    <li>
      <button class="row" data-location="${esc(loc.id)}">
        <strong>${esc(loc.name)}</strong>
        <span class="muted">${count} ${count === 1 ? "tank" : "tanks"}</span>
      </button>
    </li>`;
  }).join("");
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

  const beer = findBeer(batch.beerId);
  const days = daysSince(batch.stageStartDate);
  const size = batch.sizeBbl ? ` · ${batch.sizeBbl} bbl` : "";
  return `
    <button class="card" data-tank="${tank.id}" style="--stage-color: var(--${batch.stage})">
      ${header}
      <div class="beer">${esc(beerName(batch))} <span class="style">${esc(beer?.style)}</span></div>
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

// Special choice at the bottom of the Beer dropdown
const NEW_BEER = "__new";
let beerChoiceBeforeNew = ""; // so we can put the dropdown back if you cancel adding a beer

// Fill the Stage dropdown from the STAGES list above
batchForm.stage.innerHTML = STAGES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

function fillBeerDropdown(selectedId) {
  batchForm.beerId.innerHTML =
    `<option value="">Choose a beer…</option>` +
    beersByName().map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("") +
    `<option value="${NEW_BEER}">+ New beer…</option>`;
  batchForm.beerId.value = selectedId;
  beerChoiceBeforeNew = selectedId;
}

function openBatchEditor(batch, tankId) {
  editingBatch = batch;
  editingTankId = tankId;
  const b = batch || {
    batchId: "", beerId: "", brewDate: today(), sizeBbl: "",
    stage: "fermenting", stageStartDate: today(), tankId,
  };

  // Tank dropdown: show what's in each tank (or that it's being cleaned)
  // so you don't move beer into the wrong one
  const showLocation = data.locations.length > 1;
  batchForm.tankId.innerHTML = data.tanks.map((t) => {
    const occupant = batchInTank(t.id);
    let note = "";
    if (occupant && occupant !== batch) note = ` (has ${esc(beerName(occupant))})`;
    else if (!occupant && t.status !== "empty") note = ` (${labelFrom(TANK_STATUSES, t.status).toLowerCase()})`;
    const where = showLocation && locationName(t) ? ` · ${esc(locationName(t))}` : "";
    return `<option value="${t.id}">${esc(t.name)}${where}${note}</option>`;
  }).join("");

  document.getElementById("batch-title").textContent =
    batch ? `${beerName(batch)} ${batch.batchId ? "#" + batch.batchId : ""}` : `New batch in ${tankName(tankId)}`;
  document.getElementById("delete-batch").hidden = !batch;
  document.getElementById("open-tank-settings").hidden = !tankId;

  batchForm.batchId.value = b.batchId;
  fillBeerDropdown(b.beerId);
  batchForm.brewDate.value = b.brewDate;
  batchForm.sizeBbl.value = b.sizeBbl ?? "";
  batchForm.tankId.value = b.tankId;
  batchForm.stage.value = b.stage;
  batchForm.stageStartDate.value = b.stageStartDate;
  batchDialog.showModal();
}

// Picking "+ New beer…" opens the beer form on top of the batch form
batchForm.beerId.addEventListener("change", () => {
  if (batchForm.beerId.value === NEW_BEER) openBeerEditor(null);
  else beerChoiceBeforeNew = batchForm.beerId.value;
});

// When you pick a new stage, assume it started today (you can still change the date)
batchForm.stage.addEventListener("change", () => {
  batchForm.stageStartDate.value = today();
});

batchForm.addEventListener("submit", (e) => {
  e.preventDefault(); // we'll close the form ourselves, after checking for problems
  const values = {
    batchId: batchForm.batchId.value.trim(),
    beerId: batchForm.beerId.value,
    brewDate: batchForm.brewDate.value,
    sizeBbl: batchForm.sizeBbl.value ? Number(batchForm.sizeBbl.value) : null,
    tankId: batchForm.tankId.value,
    stage: batchForm.stage.value,
    stageStartDate: batchForm.stageStartDate.value,
  };
  const others = data.batches.filter((b) => b !== editingBatch);
  const name = beerName(values);

  // Check 1: a batch has to be a brew of some beer
  if (!findBeer(values.beerId)) {
    alert("Choose which beer this batch is.");
    return;
  }

  // Check 2: batch numbers must be unique
  if (others.some((b) => b.batchId.toLowerCase() === values.batchId.toLowerCase())) {
    alert(`There's already a batch #${values.batchId}.`);
    return;
  }

  const target = findTank(values.tankId);
  const willBeInTank = values.stage !== "packaged";
  const wasInTank = editingBatch && isInTank(editingBatch);
  const movingIn = willBeInTank && !(wasInTank && editingBatch.tankId === values.tankId);

  if (willBeInTank) {
    // Check 3: one batch per tank
    const occupant = others.find((b) => b.tankId === values.tankId && isInTank(b));
    if (occupant) {
      alert(`${target.name} already has ${beerName(occupant)} in it. Move or package that batch first.`);
      return;
    }

    // Check 4: is the tank being cleaned or worked on? (Just a warning — you might have finished)
    if (movingIn && target.status !== "empty") {
      const status = labelFrom(TANK_STATUSES, target.status).toLowerCase();
      if (!confirm(`${target.name} is marked as ${status}. Put ${name} in it anyway?`)) return;
    }

    // Check 5: will the beer fit? (Also just a warning)
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
  if (!confirm(`Delete ${beerName(editingBatch)} ${batchLabel(editingBatch)}? This can't be undone.`)) return;
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

// Special choice at the bottom of the Location dropdown
const NEW_LOCATION = "__new";
let locationChoiceBeforeNew = ""; // so we can put the dropdown back if you cancel adding a location

function fillLocationDropdown(selectedId) {
  tankForm.locationId.innerHTML =
    `<option value="">No location</option>` +
    data.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("") +
    `<option value="${NEW_LOCATION}">+ New location…</option>`;
  tankForm.locationId.value = selectedId ?? "";
  locationChoiceBeforeNew = tankForm.locationId.value;
}

function openTankEditor(tank) {
  editingTank = tank;
  const t = tank || { name: "", type: "fermenter", capacityBbl: null, locationId: null, status: "empty" };
  const batch = tank && batchInTank(tank.id);

  document.getElementById("tank-title").textContent = tank ? `Edit ${tank.name}` : "Add tank";
  document.getElementById("delete-tank").hidden = !tank;

  // Status can only be set by hand when the tank is empty
  document.getElementById("status-field").hidden = !!batch;
  document.getElementById("occupied-note").hidden = !batch;
  if (batch) {
    document.getElementById("occupied-note").textContent =
      `Occupied by ${beerName(batch)}${batch.batchId ? " #" + batch.batchId : ""}.`;
  }

  tankForm.name.value = t.name;
  tankForm.type.value = t.type;
  tankForm.capacityBbl.value = t.capacityBbl ?? "";
  // A new tank goes in the same location as the last tank, as a starting guess
  fillLocationDropdown(tank ? t.locationId : data.tanks.at(-1)?.locationId);
  tankForm.status.value = t.status;
  tankDialog.showModal();
}

// Picking "+ New location…" opens the location form on top of the tank form
tankForm.locationId.addEventListener("change", () => {
  if (tankForm.locationId.value === NEW_LOCATION) openLocationEditor(null);
  else locationChoiceBeforeNew = tankForm.locationId.value;
});

tankForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const values = {
    name: tankForm.name.value.trim(),
    type: tankForm.type.value,
    capacityBbl: tankForm.capacityBbl.value ? Number(tankForm.capacityBbl.value) : null,
    locationId: [ "", NEW_LOCATION ].includes(tankForm.locationId.value) ? null : tankForm.locationId.value,
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
    alert(`${editingTank.name} has ${beerName(batch)} in it. Move or package that batch first.`);
    return;
  }
  if (!confirm(`Delete ${editingTank.name}?`)) return;
  data.tanks = data.tanks.filter((t) => t !== editingTank);
  saveData();
  render();
  tankDialog.close();
});

// ---------- 9. Editing a beer ----------
const beerDialog = document.getElementById("beer-editor");
const beerForm = document.getElementById("beer-form");
let editingBeer = null; // the beer open in the form, or null when adding a new one

function openBeerEditor(beer) {
  editingBeer = beer;
  const b = beer || { name: "", style: "", targetOg: null, targetFg: null };

  document.getElementById("beer-title").textContent = beer ? `Edit ${beer.name}` : "Add beer";
  document.getElementById("delete-beer").hidden = !beer;

  // Suggest styles you've already used
  const styles = [...new Set(data.beers.map((x) => x.style).filter(Boolean))].sort();
  document.getElementById("style-options").innerHTML =
    styles.map((s) => `<option value="${esc(s)}">`).join("");

  beerForm.name.value = b.name;
  beerForm.style.value = b.style;
  beerForm.targetOg.value = b.targetOg ?? "";
  beerForm.targetFg.value = b.targetFg ?? "";
  showTargetAbv();
  beerDialog.showModal();
}

// Update the ABV line as you type the gravities
function showTargetAbv() {
  const a = abv(Number(beerForm.targetOg.value), Number(beerForm.targetFg.value));
  document.getElementById("target-abv").textContent = a !== null ? `${a.toFixed(1)}%` : "—";
}
beerForm.targetOg.addEventListener("input", showTargetAbv);
beerForm.targetFg.addEventListener("input", showTargetAbv);

beerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const values = {
    name: beerForm.name.value.trim(),
    style: beerForm.style.value.trim(),
    targetOg: beerForm.targetOg.value ? Number(beerForm.targetOg.value) : null,
    targetFg: beerForm.targetFg.value ? Number(beerForm.targetFg.value) : null,
  };
  if (data.beers.some((b) => b !== editingBeer && b.name.toLowerCase() === values.name.toLowerCase())) {
    alert(`There's already a beer called ${values.name}.`);
    return;
  }
  if (values.targetOg && values.targetFg && values.targetFg >= values.targetOg) {
    alert("Target FG should be lower than target OG.");
    return;
  }

  let beer = editingBeer;
  if (beer) Object.assign(beer, values);
  else {
    beer = { id: beerIdFor(values.name, data.beers), ...values };
    data.beers.push(beer);
  }
  saveData();
  render();
  // If you added this beer from inside the batch form, select it there
  if (batchDialog.open) fillBeerDropdown(editingBeer ? batchForm.beerId.value : beer.id);
  beerDialog.close();
});

// If you cancel adding a beer from the batch form, put the Beer dropdown back how it was
beerDialog.addEventListener("close", () => {
  if (batchForm.beerId.value === NEW_BEER) batchForm.beerId.value = beerChoiceBeforeNew;
});

document.getElementById("delete-beer").addEventListener("click", () => {
  // Batches point at beers, so a beer that's been brewed can't be deleted
  const used = data.batches.filter((b) => b.beerId === editingBeer.id);
  if (used.length) {
    const list = used.map((b) => (b.batchId ? "#" + b.batchId : "a batch with no number")).join(", ");
    alert(`${editingBeer.name} can't be deleted because batches of it exist (${list}).`);
    return;
  }
  if (!confirm(`Delete ${editingBeer.name}?`)) return;
  data.beers = data.beers.filter((b) => b !== editingBeer);
  saveData();
  render();
  beerDialog.close();
});

// ---------- 10. Editing a location ----------
const locationDialog = document.getElementById("location-editor");
const locationForm = document.getElementById("location-form");
let editingLocation = null; // the location open in the form, or null when adding a new one

function openLocationEditor(location) {
  editingLocation = location;
  document.getElementById("location-title").textContent = location ? `Edit ${location.name}` : "Add location";
  document.getElementById("delete-location").hidden = !location;
  locationForm.name.value = location ? location.name : "";
  locationDialog.showModal();
}

locationForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = locationForm.name.value.trim();
  if (data.locations.some((l) => l !== editingLocation && l.name.toLowerCase() === name.toLowerCase())) {
    alert(`There's already a location called ${name}.`);
    return;
  }
  let location = editingLocation;
  if (location) location.name = name;
  else {
    location = { id: newId(), name };
    data.locations.push(location);
  }
  saveData();
  render();
  // If you added this location from inside the tank form, select it there
  if (tankDialog.open && !editingLocation) fillLocationDropdown(location.id);
  locationDialog.close();
});

// If you cancel adding a location from the tank form, put the Location dropdown back how it was
locationDialog.addEventListener("close", () => {
  if (tankForm.locationId.value === NEW_LOCATION) tankForm.locationId.value = locationChoiceBeforeNew;
});

document.getElementById("delete-location").addEventListener("click", () => {
  // Tanks point at locations, so a location with tanks in it can't be deleted
  const tanks = data.tanks.filter((t) => t.locationId === editingLocation.id);
  if (tanks.length) {
    alert(`${editingLocation.name} still has tanks (${tanks.map((t) => t.name).join(", ")}). Move or delete them first.`);
    return;
  }
  if (!confirm(`Delete ${editingLocation.name}?`)) return;
  data.locations = data.locations.filter((l) => l !== editingLocation);
  saveData();
  render();
  locationDialog.close();
});

// ---------- 11. Backup (download and restore) ----------
// A backup is one file holding everything: locations, beers, tanks, and batches.
// The "format" number lets future versions of the app recognize and upgrade old backups.
const BACKUP_FORMAT = 1;

function downloadBackup() {
  const backup = { app: "brewery-os", format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), data };
  const file = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `brewery-os-backup-${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function restoreBackup(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    alert("That file isn't a Brewery OS backup (it couldn't be read).");
    return;
  }
  // Check it's really one of our backups before replacing anything
  const d = backup?.data;
  if (backup?.app !== "brewery-os" || !Array.isArray(d?.tanks) || !Array.isArray(d?.batches)) {
    alert("That file isn't a Brewery OS backup.");
    return;
  }
  if (backup.format > BACKUP_FORMAT) {
    alert("That backup was made by a newer version of Brewery OS. Reload the page to get the latest version, then try again.");
    return;
  }
  const when = new Date(backup.exportedAt).toLocaleString();
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`; // "1 tank", "2 tanks"
  const summary = [
    count(d.tanks.length, "tank", "tanks"),
    count(d.batches.length, "batch", "batches"),
    count((d.beers || []).length, "beer", "beers"),
  ].join(", ");
  if (!confirm(`Restore the backup from ${when} (${summary})?\n\nThis REPLACES everything currently on this device.`)) return;

  data = upgradeData(d); // a backup from an older version gets upgraded, just like saved data
  saveData();
  render();
  alert("Backup restored.");
}

// ---------- 12. Wiring up taps and clicks ----------
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

// Tapping a beer opens it
beerList.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  openBeerEditor(findBeer(row.dataset.beer));
});

document.getElementById("add-tank").addEventListener("click", () => openTankEditor(null));
document.getElementById("add-beer").addEventListener("click", () => openBeerEditor(null));
document.getElementById("add-location").addEventListener("click", () => openLocationEditor(null));

// Tapping a location opens it
locationList.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  openLocationEditor(findLocation(row.dataset.location));
});

// Backup buttons. "Restore" opens the hidden file picker; picking a file starts the restore.
const importFile = document.getElementById("import-file");
document.getElementById("export-data").addEventListener("click", downloadBackup);
document.getElementById("import-data").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  if (importFile.files[0]) restoreBackup(importFile.files[0]);
  importFile.value = ""; // so picking the same file again still works
});

// Every Cancel button closes whichever pop-up it's in
document.querySelectorAll(".cancel").forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog").close())
);

// ---------- 13. Go ----------
render();
