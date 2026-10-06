// Brewery OS — tank dashboard
// Everything the page does lives in this one file.

// ---------- 1. The list of stages ----------
// "empty" is extra: real tanks are sometimes empty between batches.
const STAGES = [
  { id: "fermenting",   label: "Fermenting" },
  { id: "dry-hopping",  label: "Dry hopping" },
  { id: "conditioning", label: "Conditioning" },
  { id: "carbonating",  label: "Carbonating" },
  { id: "ready",        label: "Ready" },
  { id: "empty",        label: "Empty" },
];

// ---------- 2. Sample data ----------
// We store the DATE a stage started, not "days in stage".
// That way the day count goes up on its own every day without anyone touching it.
// daysAgo() turns "4 days ago" into a real date so the samples always look fresh.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateString(d);
}

const SAMPLE_TANKS = [
  { tank: "FV1", type: "fermenter", beer: "Hazy IPA",          stage: "fermenting",   stageStart: daysAgo(4) },
  { tank: "FV2", type: "fermenter", beer: "West Coast IPA",    stage: "dry-hopping",  stageStart: daysAgo(2) },
  { tank: "FV3", type: "fermenter", beer: "Czech Pilsner",     stage: "conditioning", stageStart: daysAgo(18) },
  { tank: "FV4", type: "fermenter", beer: "Oatmeal Stout",     stage: "fermenting",   stageStart: daysAgo(9) },
  { tank: "BT1", type: "brite",     beer: "Kölsch",            stage: "carbonating",  stageStart: daysAgo(1) },
  { tank: "BT2", type: "brite",     beer: "Amber Ale",         stage: "ready",        stageStart: daysAgo(3) },
];

// ---------- 3. Saving and loading ----------
// localStorage is a small storage space the browser gives each website.
// It survives closing the tab, but it lives only in THIS browser on THIS device.
const STORAGE_KEY = "brewery-os.tanks";

function loadTanks() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.warn("Couldn't read saved tanks, using samples instead.", e);
  }
  return SAMPLE_TANKS;
}

function saveTanks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tanks));
  } catch (e) {
    alert("Couldn't save. Changes will be lost when you close this page.");
  }
}

let tanks = loadTanks();

// ---------- 4. Small helpers ----------
function toDateString(d) {
  // "2026-10-05" format, using the local date (not UTC)
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysSince(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - start) / 86400000)); // 86,400,000 ms in a day
}

function stageLabel(id) {
  return (STAGES.find((s) => s.id === id) || {}).label || id;
}

// Escape text before putting it into HTML, so a beer named "<Hop & Glory>" can't break the page
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---------- 5. Drawing the cards ----------
const grid = document.getElementById("tanks");

function render() {
  grid.innerHTML = tanks.map((t, i) => {
    const isEmpty = t.stage === "empty" || !t.beer;
    const days = daysSince(t.stageStart);
    return `
      <button class="card" data-index="${i}" style="--stage-color: var(--${isEmpty ? "empty" : t.stage})">
        <div class="tank-row">
          <span class="tank">${esc(t.tank)}</span>
          <span class="type">${t.type === "brite" ? "Brite tank" : "Fermenter"}</span>
        </div>
        <div class="beer ${isEmpty ? "none" : ""}">${isEmpty ? "Empty" : esc(t.beer)}</div>
        <div class="stage-row">
          <span class="badge">${isEmpty ? "Empty" : stageLabel(t.stage)}</span>
          <span class="days">${days} <small>${days === 1 ? "day" : "days"}</small></span>
        </div>
      </button>`;
  }).join("");
}

// ---------- 6. Editing a tank ----------
const dialog = document.getElementById("editor");
const form = document.getElementById("edit-form");
let editingIndex = null; // which tank is open; null means "adding a new one"

// Fill the Stage dropdown from the STAGES list above
form.stage.innerHTML = STAGES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

function openEditor(index) {
  editingIndex = index;
  const t = index === null
    ? { tank: "", type: "fermenter", beer: "", stage: "empty", stageStart: toDateString(new Date()) }
    : tanks[index];

  document.getElementById("editor-title").textContent = index === null ? "Add tank" : `Edit ${t.tank}`;
  document.getElementById("delete-tank").hidden = index === null;
  form.tank.value = t.tank;
  form.type.value = t.type;
  form.beer.value = t.beer;
  form.stage.value = t.stage;
  form.stageStart.value = t.stageStart;
  dialog.showModal();
}

// When you pick a new stage, assume it started today (you can still change the date)
form.stage.addEventListener("change", () => {
  form.stageStart.value = toDateString(new Date());
});

form.addEventListener("submit", () => {
  const updated = {
    tank: form.tank.value.trim(),
    type: form.type.value,
    beer: form.beer.value.trim(),
    stage: form.beer.value.trim() ? form.stage.value : "empty", // no beer = empty tank
    stageStart: form.stageStart.value,
  };
  if (editingIndex === null) tanks.push(updated);
  else tanks[editingIndex] = updated;
  saveTanks();
  render();
});

document.getElementById("cancel").addEventListener("click", () => dialog.close());

document.getElementById("delete-tank").addEventListener("click", () => {
  if (!confirm(`Delete ${tanks[editingIndex].tank}?`)) return;
  tanks.splice(editingIndex, 1);
  saveTanks();
  render();
  dialog.close();
});

// Tapping any card opens the editor for that tank
grid.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openEditor(Number(card.dataset.index));
});

document.getElementById("add-tank").addEventListener("click", () => openEditor(null));

// ---------- 7. Go ----------
render();
