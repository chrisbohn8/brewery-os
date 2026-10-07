// Brewery OS — tank dashboard
// Everything the page does lives in this one file.
//
// Four kinds of things:
//   LOCATIONS — the brewery's facilities. Tanks point at these.
//   BEERS     — the product. "House Hazy" the recipe: style and target numbers.
//   TANKS     — equipment. They stay put. (FV-1, BT-2...)
//   BATCHES   — one actual brew of a beer. A batch points at its beer, and has a
//               history of EVENTS: "from this date, at this stage, in this tank."
//               Where a batch is now is its newest event.
//   ACID CYCLES — a log of each tank's acid cleanings. Whether a tank is due for one is
//               worked out from that log and the batch history, never stored.
//
// Everything is saved in a shared database (Supabase), so every phone and computer
// sees the same data. Each brewery's data is kept separate by the database itself.

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

// A new, unique ID for a record. The database uses these "UUIDs" for every row.
function newId() {
  return crypto.randomUUID();
}

// Beers also get a readable code made from the name: "House Hazy" -> "house-hazy", "Kölsch" -> "kolsch".
// It's set once when the beer is created and never changes, even if you rename the beer.
function beerCodeFor(name, beers) {
  const base = name.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // ö -> o
    .replace(/[^a-z0-9]+/g, "-")                      // spaces and symbols -> dashes
    .replace(/^-|-$/g, "") || "beer";
  let code = base;
  for (let n = 2; beers.some((b) => b.code === code); n++) code = `${base}-${n}`; // "house-hazy-2" if taken
  return code;
}

// Standard homebrew/craft ABV formula: (OG - FG) × 131.25
function abv(og, fg) {
  return og && fg ? (og - fg) * 131.25 : null;
}

// ----- Units -----
// Every value is STORED in one standard unit: gravity as SG, temperature as °C, volume as
// US barrels. Each brewery picks the units it reads and types in (Brewery settings), and
// these helpers convert at the screen. Changing a preference never changes a record.
const DEFAULT_PREFS = { temperatureUnit: "F", gravityUnit: "plato", volumeUnit: "bbl", timeZone: "America/Chicago" };
const UNIT_INFO = {
  gravity: {
    plato: { label: "°P", decimals: 1, step: 0.1 },
    sg: { label: "SG", decimals: 3, step: 0.001 },
    brix: { label: "°Bx", decimals: 1, step: 0.1 },
  },
  volume: {
    bbl: { label: "bbl", decimals: 1, step: 0.5, perBbl: 1 },
    hl: { label: "hL", decimals: 1, step: 0.5, perBbl: 1.17348 },  // 1 US barrel = 117.348 L
    gal: { label: "gal", decimals: 0, step: 1, perBbl: 31 },        // 1 US beer barrel = 31 gal
  },
  temperature: {
    F: { label: "°F", decimals: 1, step: 0.1 },
    C: { label: "°C", decimals: 1, step: 0.1 },
  },
};

function prefs() {
  return { ...DEFAULT_PREFS, ...(brewery?.prefs || {}) };
}

// Gravity: the standard brewing conversions between specific gravity and degrees Plato.
// Brix is treated like Plato, which holds for unfermented wort. (Refractometer readings
// taken after fermentation starts need an alcohol correction; that comes with the brew log.)
function sgToPlato(sg) {
  return -616.868 + 1111.14 * sg - 630.272 * sg ** 2 + 135.997 * sg ** 3;
}
function platoToSg(p) {
  return 1 + p / (258.6 - (p / 258.2) * 227.1);
}

function round(n, decimals) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Stored value -> the number shown in the brewery's unit (rounded for display)
function toShown(kind, stored) {
  if (stored === null || stored === undefined || stored === "") return null;
  const unit = prefs()[`${kind}Unit`];
  const info = UNIT_INFO[kind][unit];
  let n = Number(stored);
  if (kind === "gravity" && unit !== "sg") n = sgToPlato(n);
  if (kind === "volume") n = n * info.perBbl;
  if (kind === "temperature" && unit === "F") n = n * 9 / 5 + 32;
  return round(n, info.decimals);
}

// A number typed in the brewery's unit -> the stored value
function fromShown(kind, typed) {
  if (typed === null || typed === undefined || typed === "") return null;
  const unit = prefs()[`${kind}Unit`];
  let n = Number(typed);
  if (kind === "gravity" && unit !== "sg") n = platoToSg(n);
  if (kind === "volume") n = n / UNIT_INFO.volume[unit].perBbl;
  if (kind === "temperature" && unit === "F") n = (n - 32) * 5 / 9;
  return round(n, kind === "gravity" ? 5 : 4);
}

// Put a stored value into a number box, remembering exactly what was there...
function fillUnitInput(input, kind, stored) {
  const shown = toShown(kind, stored);
  input.value = shown ?? "";
  input.dataset.shownValue = input.value;
  input.dataset.storedValue = stored ?? "";
}

// ...so reading it back keeps the precise stored value when the person didn't change it.
// (Otherwise 15 bbl shown as "17.6 hL" and saved untouched would become 14.998 bbl.)
function readUnitInput(input, kind) {
  if (input.value === input.dataset.shownValue) {
    return input.dataset.storedValue === "" ? null : Number(input.dataset.storedValue);
  }
  return fromShown(kind, input.value);
}

// "16.1 °P", "15 bbl", "152 °F"
function showUnit(kind, stored) {
  const n = toShown(kind, stored);
  if (n === null) return "";
  const info = UNIT_INFO[kind][prefs()[`${kind}Unit`]];
  return `${n.toFixed(info.decimals)} ${info.label}`.replace(/\.0 (bbl|hL)$/, " $1");
}

// Put the brewery's unit names on labels, and the right step/example on number boxes
function applyUnitLabels() {
  for (const kind of ["gravity", "volume", "temperature"]) {
    const info = UNIT_INFO[kind][prefs()[`${kind}Unit`]];
    document.querySelectorAll(`.${kind}-unit`).forEach((el) => { el.textContent = info.label; });
    document.querySelectorAll(`input[data-unit="${kind}"]`).forEach((input) => {
      // "any": a converted value like 17.6 hL must be accepted even if it isn't a round step
      // (a fixed step would make the browser silently refuse to submit the form)
      input.step = "any";
      input.min = 0;
      if (input.dataset.example) input.placeholder = toShown(kind, input.dataset.example);
    });
  }
}

// Escape text before putting it into HTML, so a beer named "<Hop & Glory>" can't break the page
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// ---------- 3. Sample data ----------
// Same shape as a backup file, so it's loaded the same way a backup is.
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
      { id: "fv1", name: "FV-1", type: "fermenter", capacityBbl: 15, locationId: "downtown",  status: "empty", acidEveryTurns: 4 },
      { id: "fv2", name: "FV-2", type: "fermenter", capacityBbl: 15, locationId: "downtown",  status: "empty", acidEveryTurns: 4 },
      { id: "fv3", name: "FV-3", type: "fermenter", capacityBbl: 15, locationId: "downtown",  status: "empty", acidEveryTurns: 4 },
      { id: "bt1", name: "BT-1", type: "brite",     capacityBbl: 15, locationId: "downtown",  status: "empty" },
      { id: "fv4", name: "FV-4", type: "fermenter", capacityBbl: 7,  locationId: "riverside", status: "empty", acidEveryTurns: 4 },
      { id: "bt2", name: "BT-2", type: "brite",     capacityBbl: 7,  locationId: "riverside", status: "empty" },
      { id: "st1", name: "ST-1", type: "serving",   capacityBbl: 7,  locationId: "riverside", status: "cleaning" },
    ],
    batches: [
      { id: "b1042", batchNumber: "1042", beerId: "house-hazy",     brewDate: daysAgo(4),  sizeBbl: 15, stage: "fermenting",   stageStartDate: daysAgo(4),  tankId: "fv1" },
      { id: "b1041", batchNumber: "1041", beerId: "west-coast-ipa", brewDate: daysAgo(9),  sizeBbl: 15, stage: "dry-hopping",  stageStartDate: daysAgo(2),  tankId: "fv2" },
      { id: "b1038", batchNumber: "1038", beerId: "czech-pilsner",  brewDate: daysAgo(32), sizeBbl: 15, stage: "conditioning", stageStartDate: daysAgo(18), tankId: "fv3" },
      { id: "b1040", batchNumber: "1040", beerId: "oatmeal-stout",  brewDate: daysAgo(9),  sizeBbl: 7,  stage: "fermenting",   stageStartDate: daysAgo(9),  tankId: "fv4" },
      { id: "b1039", batchNumber: "1039", beerId: "kolsch",         brewDate: daysAgo(25), sizeBbl: 15, stage: "carbonating",  stageStartDate: daysAgo(1),  tankId: "bt1" },
      { id: "b1037", batchNumber: "1037", beerId: "amber-ale",      brewDate: daysAgo(21), sizeBbl: 7,  stage: "ready",        stageStartDate: daysAgo(3),  tankId: "bt2" },
      { id: "b1036", batchNumber: "1036", beerId: "pale-ale",       brewDate: daysAgo(28), sizeBbl: 15, stage: "packaged",     stageStartDate: daysAgo(5),  tankId: null },
      { id: "b1035", batchNumber: "1035", beerId: "robust-porter",  brewDate: daysAgo(35), sizeBbl: 7,  stage: "packaged",     stageStartDate: daysAgo(12), tankId: null },
    ],
    cleanings: [
      { tankId: "fv1", cleanedOn: daysAgo(40), note: "" },
      { tankId: "fv2", cleanedOn: daysAgo(30), note: "" },
      { tankId: "st1", cleanedOn: daysAgo(60), note: "Quarterly acid" },
    ],
  };
}

// ---------- 4. Connecting to the database ----------
// The URL and "publishable" key are meant to be public: they let the page talk to the
// database, but the database's row-level security only shows each signed-in person
// their own brewery's data. (The secret keys are never put in this file.)
//
// When the app runs on the developer's own computer (localhost), it uses a private test copy
// of the database running in Docker (`supabase start`), so testing never touches real data.
const ON_THIS_COMPUTER = ["localhost", "127.0.0.1"].includes(location.hostname);
const SUPABASE_URL = ON_THIS_COMPUTER ? "http://127.0.0.1:54321" : "https://itxshxihltidwgwtzdcj.supabase.co";
const SUPABASE_KEY = ON_THIS_COMPUTER
  ? "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" // the standard key every local Supabase copy uses
  : "sb_publishable_hcERCBatEZUWfy9iret5sw_x2cTAXb5";
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  // "implicit" lets an emailed sign-in link work even if it opens in a different browser
  auth: { flowType: "implicit" },
});

let brewery = null; // the brewery you're working in: { id, name, role }
let data = { locations: [], beers: [], tanks: [], batches: [], events: [], cleanings: [], acidAfterStyles: [] };

// Run a database request; if it fails, throw the error so the caller's "catch" handles it
async function must(request) {
  const { data: result, error } = await request;
  if (error) throw error;
  return result;
}

// Did this fail because there's no connection (rather than the database saying no)?
// Browsers word it differently: "Failed to fetch" (Chrome), "Load failed" (Safari), "NetworkError" (Firefox).
function isConnectionProblem(error) {
  return !navigator.onLine || /failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(error?.message || String(error));
}

// Turn a database error into something a person can act on
function explain(error) {
  if (isConnectionProblem(error)) return "Couldn't reach the database. Check your signal and try again.";
  if (error.code === "23505") return "That name or number is already used.";
  if (error.code === "23503") return "That's still linked to other records (for example, batch history), so it can't be deleted.";
  if (error.code === "42501") return "You don't have permission to do that.";
  return error.message || String(error);
}

// Load everything for the current brewery, in the shape the rest of the page uses.
// `serverData` is exactly what the database has; `data` (what the screen shows) is that,
// plus any changes made on this phone that are still waiting to be sent.
let serverData = null;
async function loadAll() {
  const b = brewery.id;
  const [locations, beers, tanks, batches, events, cleanings, settings, members, invites] = await Promise.all([
    must(db.from("locations").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("beers").select("*").eq("brewery_id", b)),
    must(db.from("tanks").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("batch_status").select("*").eq("brewery_id", b)),
    must(db.from("batch_events").select("*").eq("brewery_id", b).order("effective_date").order("recorded_at")),
    must(db.from("tank_cleanings").select("*").eq("brewery_id", b).order("cleaned_on").order("recorded_at")),
    must(db.from("breweries").select("acid_after_styles, temperature_unit, gravity_unit, volume_unit, time_zone").eq("id", b).single()),
    must(db.rpc("brewery_members", { p_brewery_id: b })),
    must(db.from("invites").select("*").eq("brewery_id", b).order("created_at")), // admins only; others get none
  ]);
  serverData = {
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    beers: beers.map((x) => ({
      id: x.id, code: x.code, name: x.name, style: x.style,
      targetOg: x.target_og === null ? null : Number(x.target_og),
      targetFg: x.target_fg === null ? null : Number(x.target_fg),
    })),
    tanks: tanks.map((t) => ({
      id: t.id, name: t.name, type: t.type, status: t.status, locationId: t.location_id,
      capacityBbl: t.capacity_bbl === null ? null : Number(t.capacity_bbl),
      acidEveryTurns: t.acid_every_turns,
    })),
    batches: batches.map((x) => ({
      id: x.id, batchNumber: x.batch_number, beerId: x.beer_id, brewDate: x.brew_date,
      sizeBbl: x.size_bbl === null ? null : Number(x.size_bbl),
      // These three come from the newest event in the batch's history
      stage: x.stage, tankId: x.tank_id, stageStartDate: x.stage_started_on,
    })),
    events: events.map((e) => ({
      id: e.id, batchId: e.batch_id, effectiveDate: e.effective_date, stage: e.stage, tankId: e.tank_id,
    })),
    cleanings: cleanings.map((c) => ({ id: c.id, tankId: c.tank_id, cleanedOn: c.cleaned_on, note: c.note })),
    acidAfterStyles: settings.acid_after_styles,
    prefs: {
      temperatureUnit: settings.temperature_unit, gravityUnit: settings.gravity_unit,
      volumeUnit: settings.volume_unit, timeZone: settings.time_zone,
    },
    members: members.map((m) => ({ userId: m.user_id, email: m.email, role: m.role })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role })),
  };
  data = withWaitingChanges(serverData);
  brewery.prefs = serverData.prefs;
}

// After any change: reload from the database and redraw, so the page always shows what's really saved.
// Each successful load also updates this device's offline copy.
async function refresh() {
  await sendWaitingChanges();
  await loadAll();
  render();
  saveOfflineCopy();
  showOnline();
}

// Run a change, show a friendly message if it fails, and always refresh afterward.
// While it runs, the page ignores extra taps so nothing gets saved twice.
let busy = false;
async function save(work) {
  if (busy) return false;
  if (offline || !navigator.onLine) {
    alert("This change needs signal, so it wasn't saved. (Batch, tank, and acid changes can be made offline; " +
      "adding or deleting beers, locations, and tanks can't.)");
    return false;
  }
  busy = true;
  document.body.classList.add("busy");
  try {
    await work();
    return true;
  } catch (e) {
    if (isConnectionProblem(e)) {
      showOffline();
      alert("Lost the connection while saving. Check the screen once you're back online to see whether it went through.");
    } else {
      alert(`Couldn't save: ${explain(e)}`);
    }
    return false;
  } finally {
    try { await refresh(); } catch (e) { if (isConnectionProblem(e)) showOffline(); else console.warn(e); }
    busy = false;
    document.body.classList.remove("busy");
  }
}

// ----- Offline -----
// Every time data loads, a copy is kept on this device. With no signal, the app shows that
// copy, with a banner saying how old it is. Saving needs a connection for now; queuing
// changes made offline comes next. Signing out deletes the copy (important on shared devices).
const OFFLINE_KEY = "brewery-os.offline-copy";
let offline = false;
let signedInEmail = "";
let lastLoadedAt = null;

function saveOfflineCopy() {
  lastLoadedAt = new Date().toISOString();
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify({ savedAt: lastLoadedAt, email: signedInEmail, brewery, data: serverData }));
  } catch (e) {
    console.warn("Couldn't keep an offline copy on this device.", e);
  }
}

function readOfflineCopy() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_KEY));
  } catch {
    return null;
  }
}

function deleteOfflineCopy() {
  try { localStorage.removeItem(OFFLINE_KEY); } catch {}
}

// "10:42 AM" today, "Oct 5, 10:42 AM" before that
function whenSaved(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return toDateString(d) === today() ? time : `${formatDate(toDateString(d))}, ${time}`;
}

function showOffline() {
  offline = true;
  updateBanner();
}

function showOnline() {
  offline = false;
  updateBanner();
}

// The band under the header: offline, and/or changes waiting to be sent
function updateBanner() {
  const banner = document.getElementById("offline-banner");
  const waiting = outbox.length ? count(outbox.length, "change", "changes") + " waiting to send" : "";
  if (offline) {
    const age = lastLoadedAt ? ` · showing data from ${whenSaved(lastLoadedAt)}` : "";
    banner.textContent = `Offline${age}${waiting ? ` · ${waiting}` : ""}. ` +
      "Batch, tank, and acid changes are kept on this phone and sent when you have signal.";
  } else {
    banner.textContent = waiting ? `Sending: ${waiting}…` : "";
  }
  banner.hidden = !banner.textContent;
}

// No connection: show the copy kept on this device, if there is one
function openOfflineCopy() {
  const copy = readOfflineCopy();
  if (!copy?.brewery) return false;
  brewery = copy.brewery;
  serverData = copy.data;
  data = withWaitingChanges(serverData);
  signedInEmail = copy.email;
  lastLoadedAt = copy.savedAt;
  document.getElementById("signed-in-as").textContent = `Signed in as ${copy.email}`;
  render();
  showOffline();
  showScreen("app-screen");
  return true;
}

// ----- Changes made with no signal ("waiting to send") -----
// Batch saves, tank changes, and acid cycles can be made offline. Each one goes into a list
// kept on this phone (so it survives closing the app), shows on screen right away, and is
// sent, in the order it was made, as soon as there's signal.
//
// The simple rule from the README: changes apply in the order they reach the database. If
// one can't apply (say a coworker filled that tank first), the database refuses it and this
// phone shows exactly which change wasn't saved and why. Nothing is silently dropped.
//
// Every kind of change here is safe to send twice (a retry after a dropped connection
// can't save something twice).
const OUTBOX_KEY = "brewery-os.waiting-changes";
const PROBLEMS_KEY = "brewery-os.unsaved-changes";
let outbox = readList(OUTBOX_KEY);          // [{ id, kind, args, label, madeAt }]
let syncProblems = readList(PROBLEMS_KEY);  // ["House Hazy #1042 into BT-2: BT-2 already has ..."]

function readList(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}
function storeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { console.warn("Couldn't store", key, e); }
}

// How each kind of change is sent to the database
const SEND = {
  saveBatch: (a) => must(db.rpc("save_batch", a)),
  updateTank: (a) => must(db.from("tanks").update({
    name: a.name, type: a.type, capacity_bbl: a.capacityBbl, location_id: a.locationId,
    status: a.status, acid_every_turns: a.acidEveryTurns,
  }).eq("id", a.id)),
  logAcid: async (a) => {
    try {
      await must(db.from("tank_cleanings").insert({
        id: a.id, brewery_id: a.breweryId, tank_id: a.tankId, kind: "acid", cleaned_on: a.cleanedOn, note: a.note,
      }));
    } catch (e) {
      if (e.code !== "23505") throw e; // "already there" = it was sent before the connection dropped
    }
  },
};

// How each kind of change looks on screen before it's sent (mirrors what the database will do)
const SHOW = {
  saveBatch(d, a) {
    let batch = d.batches.find((b) => b.id === a.p_id);
    const before = batch ? { stage: batch.stage, tankId: batch.tankId } : null;
    if (!batch) d.batches.push(batch = { id: a.p_id });
    const inTank = a.p_stage !== "packaged";
    const newTank = inTank ? a.p_tank_id : null;
    const stageChanged = before?.stage !== a.p_stage;
    const tankChanged = inTank && before?.tankId !== newTank;
    Object.assign(batch, {
      batchNumber: a.p_batch_number, beerId: a.p_beer_id, brewDate: a.p_brew_date, sizeBbl: a.p_size_bbl,
      stage: a.p_stage, tankId: newTank, stageStartDate: a.p_stage_started_on,
    });
    if (stageChanged || tankChanged) {
      d.events.push({
        id: `waiting-${a.p_id}-${d.events.length}`, batchId: a.p_id, stage: a.p_stage, tankId: newTank,
        effectiveDate: stageChanged ? a.p_stage_started_on : a.p_action_date,
      });
    }
    const tank = (id) => d.tanks.find((t) => t.id === id);
    if (before?.tankId && before.stage !== "packaged" && (!inTank || before.tankId !== newTank) && tank(before.tankId)) {
      tank(before.tankId).status = "cleaning";
    }
    if ((tankChanged || (inTank && before?.stage === "packaged")) && tank(newTank)) tank(newTank).status = "empty";
  },
  updateTank(d, a) {
    const tank = d.tanks.find((t) => t.id === a.id);
    if (tank) Object.assign(tank, a);
  },
  logAcid(d, a) {
    d.cleanings.push({ id: a.id, tankId: a.tankId, cleanedOn: a.cleanedOn, note: a.note });
  },
};

// What the screen shows: the database's data with the waiting changes on top
function withWaitingChanges(base) {
  const d = structuredClone(base);
  for (const change of outbox) SHOW[change.kind](d, change.args);
  return d;
}

// Save a change now if there's signal; otherwise keep it to send later.
// A connection that drops mid-save also keeps it to send later (it's safe to send twice).
async function saveOrKeep(kind, args, label) {
  const change = { id: newId(), kind, args, label, madeAt: new Date().toISOString() };
  const keep = () => {
    outbox.push(change);
    storeList(OUTBOX_KEY, outbox);
    data = withWaitingChanges(serverData);
    render();
    if (offline || !navigator.onLine) showOffline(); else updateBanner();
  };
  if (offline || !navigator.onLine || outbox.length) {
    // Offline, or older changes still waiting: join the back of the line, so changes always
    // reach the database in the order they were made
    if (busy) return false;
    keep();
    if (!offline && navigator.onLine) refresh().catch((e) => { if (isConnectionProblem(e)) showOffline(); });
    return true;
  }
  return save(async () => {
    try {
      await SEND[kind](args);
    } catch (e) {
      if (!isConnectionProblem(e)) throw e;
      offline = true;
      keep();
    }
  });
}

// Send everything waiting, oldest first. Stops (keeping the rest) if the signal drops again.
let sending = false;
async function sendWaitingChanges() {
  if (sending || !outbox.length) return;
  sending = true;
  updateBanner();
  try {
    while (outbox.length) {
      const change = outbox[0];
      try {
        await SEND[change.kind](change.args);
      } catch (e) {
        if (isConnectionProblem(e)) return; // still no signal: try again later
        syncProblems.push(`${change.label} (${whenSaved(change.madeAt)}): ${explain(e)}`);
        storeList(PROBLEMS_KEY, syncProblems);
      }
      outbox.shift();
      storeList(OUTBOX_KEY, outbox);
    }
  } finally {
    sending = false;
    updateBanner();
    showSyncProblems();
  }
}

// Changes the database refused: listed on the page until you've read them
function showSyncProblems() {
  const box = document.getElementById("sync-problems");
  box.hidden = !syncProblems.length;
  document.getElementById("sync-problem-list").innerHTML = syncProblems.map((p) => `<li>${esc(p)}</li>`).join("");
}
document.getElementById("sync-problems-ok").addEventListener("click", () => {
  syncProblems = [];
  storeList(PROBLEMS_KEY, syncProblems);
  showSyncProblems();
});

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
  return batch.batchNumber ? `#${esc(batch.batchNumber)}` : "No batch #";
}

// "OG 1.066 · FG 1.016 · 6.6%" (skipping any that aren't filled in)
function targetsText(beer) {
  const parts = [];
  if (beer.targetOg) parts.push(`OG ${showUnit("gravity", beer.targetOg)}`);
  if (beer.targetFg) parts.push(`FG ${showUnit("gravity", beer.targetFg)}`);
  const a = abv(beer.targetOg, beer.targetFg);
  if (a !== null) parts.push(`${a.toFixed(1)}%`);
  return parts.join(" · ");
}

// ----- Acid cycles -----
// The tank's acid cycles, oldest first
function acidCycles(tankId) {
  return data.cleanings.filter((c) => c.tankId === tankId);
}

// Batches that have left a tank, and the day each one left: [{ batch, leftOn }].
// A batch leaves when its next history event puts it in another tank, or packages it.
// A batch that passed through the same tank twice counts once (its latest departure).
function departuresFrom(tankId) {
  const departures = [];
  for (const batch of data.batches) {
    const history = data.events.filter((e) => e.batchId === batch.id); // oldest first
    let leftOn = null;
    history.forEach((e, i) => {
      const next = history[i + 1];
      if (e.tankId === tankId && next && next.tankId !== tankId) leftOn = next.effectiveDate;
    });
    if (leftOn) departures.push({ batch, leftOn });
  }
  return departures;
}

// Is a tank due for an acid cycle, and why?
// Turns = batches that left the tank AFTER its last acid cycle. (Beer that left on the same day
// as an acid cycle counts as before it: the acid was run once the tank was empty.)
// Due when a batch of one of the brewery's acid-after styles has left, or the tank has reached
// its "acid every X turns" limit.
function acidState(tank) {
  const last = acidCycles(tank.id).at(-1);
  const since = departuresFrom(tank.id).filter((d) => !last || d.leftOn > last.cleanedOn);
  const styles = data.acidAfterStyles.map((s) => s.toLowerCase());
  const styleOf = (batch) => (findBeer(batch.beerId)?.style || "").trim();
  const trigger = since.find((d) => styles.includes(styleOf(d.batch).toLowerCase()));

  let reason = "";
  if (trigger) reason = `after ${styleOf(trigger.batch)}`;
  else if (tank.acidEveryTurns && since.length >= tank.acidEveryTurns) reason = `${since.length} of ${tank.acidEveryTurns} turns`;
  return { last, turns: since.length, due: reason !== "", reason };
}

function isEmptyBrewery() {
  return !data.locations.length && !data.tanks.length && !data.beers.length && !data.batches.length;
}

// ---------- 6. Drawing the page ----------
const tanksArea = document.getElementById("tanks");
const packagedSection = document.getElementById("packaged");
const packagedList = document.getElementById("packaged-list");
const beerList = document.getElementById("beer-list");
const locationList = document.getElementById("location-list");
const acidStyleList = document.getElementById("acid-style-list");
const acidStyleForm = document.getElementById("acid-style-form");

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
  document.getElementById("brewery-name").textContent = brewery.name;
  applyUnitLabels();
  renderSettings();
  renderTeam();

  // A brand-new brewery: show ways to get started
  document.getElementById("empty-state").hidden = !isEmptyBrewery();
  document.getElementById("load-browser-data").hidden = !browserData();

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
      <button class="row stacked" data-beer="${beer.id}">
        <span><strong>${esc(beer.name)}</strong> <span class="muted">${esc(beer.style)}</span></span>
        <span class="muted">${targetsText(beer)}</span>
      </button>
    </li>`).join("");

  // Locations, in the order they were added
  locationList.innerHTML = data.locations.map((loc) => {
    const count = data.tanks.filter((t) => t.locationId === loc.id).length;
    return `
    <li>
      <button class="row" data-location="${loc.id}">
        <strong>${esc(loc.name)}</strong>
        <span class="muted">${count} ${count === 1 ? "tank" : "tanks"}</span>
      </button>
    </li>`;
  }).join("");

  // Styles that always need an acid cycle afterward (one list for the whole brewery).
  // Only admins can change it.
  const isAdmin = brewery.role === "admin";
  acidStyleList.innerHTML = data.acidAfterStyles.length
    ? data.acidAfterStyles.map((style, i) => `
      <li class="item">
        <span>${esc(style)}</span>
        ${isAdmin ? `<button class="btn small" data-remove-style="${i}">Remove</button>` : ""}
      </li>`).join("")
    : `<li class="item muted">No styles yet.</li>`;
  acidStyleForm.hidden = !isAdmin;
  document.getElementById("acid-admin-note").hidden = isAdmin;
  // Suggest the styles of your beers
  const styles = [...new Set(data.beers.map((x) => x.style).filter(Boolean))]
    .filter((s) => !data.acidAfterStyles.some((a) => a.toLowerCase() === s.toLowerCase()))
    .sort();
  document.getElementById("acid-style-options").innerHTML = styles.map((s) => `<option value="${esc(s)}">`).join("");
}

function tankCard(tank) {
  const batch = batchInTank(tank.id);
  // Capacity only on empty tanks; a full tank shows the batch size instead
  const capacity = tank.capacityBbl && !batch ? ` · ${showUnit("volume", tank.capacityBbl)}` : "";
  const header = `
    <div class="tank-row">
      <span class="tank">${esc(tank.name)}</span>
      <span class="type">${labelFrom(TANK_TYPES, tank.type)}${capacity}</span>
    </div>`;

  if (!batch) {
    const hint = tank.status === "empty" ? "Tap to start a batch" : "Tap to update status";
    // An empty tank that needs acid before it's filled again says so, and why
    const acid = acidState(tank);
    const acidDue = acid.due ? `<div class="acid-due">Acid due · ${esc(acid.reason)}</div>` : "";
    return `
      <button class="card" data-tank="${tank.id}" style="--stage-color: var(--${tank.status})">
        ${header}
        <div class="beer none">${labelFrom(TANK_STATUSES, tank.status)}</div>
        ${acidDue}
        <div class="meta">${hint}</div>
      </button>`;
  }

  const beer = findBeer(batch.beerId);
  const days = daysSince(batch.stageStartDate);
  const size = batch.sizeBbl ? ` · ${showUnit("volume", batch.sizeBbl)}` : "";
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
    beersByName().map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("") +
    `<option value="${NEW_BEER}">+ New beer…</option>`;
  batchForm.beerId.value = selectedId;
  beerChoiceBeforeNew = selectedId;
}

function openBatchEditor(batch, tankId) {
  editingBatch = batch;
  editingTankId = tankId;
  const b = batch || {
    batchNumber: "", beerId: "", brewDate: today(), sizeBbl: "",
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
    batch ? `${beerName(batch)} ${batch.batchNumber ? "#" + batch.batchNumber : ""}` : `New batch in ${tankName(tankId)}`;
  document.getElementById("delete-batch").hidden = !batch;
  document.getElementById("open-tank-settings").hidden = !tankId;

  batchForm.batchId.value = b.batchNumber;
  fillBeerDropdown(b.beerId);
  batchForm.brewDate.value = b.brewDate;
  fillUnitInput(batchForm.sizeBbl, "volume", b.sizeBbl);
  if (b.tankId) batchForm.tankId.value = b.tankId;
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

batchForm.addEventListener("submit", async (e) => {
  e.preventDefault(); // we'll close the form ourselves, after checking for problems
  const values = {
    batchNumber: batchForm.batchId.value.trim(),
    beerId: batchForm.beerId.value,
    brewDate: batchForm.brewDate.value,
    sizeBbl: readUnitInput(batchForm.sizeBbl, "volume"), // typed in the brewery's unit, stored in barrels
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
  if (others.some((b) => b.batchNumber.toLowerCase() === values.batchNumber.toLowerCase())) {
    alert(`There's already a batch #${values.batchNumber}.`);
    return;
  }

  const target = findTank(values.tankId);
  const willBeInTank = values.stage !== "packaged";
  const wasInTank = editingBatch && isInTank(editingBatch);
  const movingIn = willBeInTank && !(wasInTank && editingBatch.tankId === values.tankId);

  if (willBeInTank) {
    if (!target) {
      alert("Choose a tank for this batch.");
      return;
    }

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

    // Check 5: is the tank due for an acid cycle? (A warning — it may have been done but not logged yet)
    if (movingIn) {
      const acid = acidState(target);
      if (acid.due && !confirm(`${target.name} is due for an acid cycle (${acid.reason}). Put ${name} in it anyway?`)) return;
    }

    // Check 6: will the beer fit? (Also just a warning)
    if (values.sizeBbl && target.capacityBbl && values.sizeBbl > target.capacityBbl) {
      if (!confirm(`${showUnit("volume", values.sizeBbl)} is more than ${target.name} holds (${showUnit("volume", target.capacityBbl)}). Save anyway?`)) return;
    }
  }

  // One call; the database saves the batch, its history, and both tanks' statuses together,
  // all or nothing (see supabase/migrations/..._save_batch.sql). With no signal, it's kept
  // on this phone and sent later.
  const where = willBeInTank ? `${stageLabel(values.stage).toLowerCase()} in ${target.name}` : "packaged";
  const label = `${name} #${values.batchNumber}: ${where}`;
  const ok = await saveOrKeep("saveBatch", {
    p_id: editingBatch?.id ?? newId(),
    p_brewery_id: brewery.id,
    p_batch_number: values.batchNumber,
    p_beer_id: values.beerId,
    p_brew_date: values.brewDate,
    p_size_bbl: values.sizeBbl,
    p_stage: values.stage,
    p_stage_started_on: values.stageStartDate,
    p_tank_id: willBeInTank ? values.tankId : null,
    p_action_date: today(), // the day you did it, even if it reaches the database later
  }, label);
  if (ok) batchDialog.close();
});

document.getElementById("delete-batch").addEventListener("click", async () => {
  if (!confirm(`Delete ${beerName(editingBatch)} ${batchLabel(editingBatch)} and its history? This can't be undone.`)) return;
  const ok = await save(() => must(db.from("batches").delete().eq("id", editingBatch.id)));
  if (ok) batchDialog.close();
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
    data.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("") +
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
      `Occupied by ${beerName(batch)}${batch.batchNumber ? " #" + batch.batchNumber : ""}.`;
  }

  tankForm.name.value = t.name;
  tankForm.type.value = t.type;
  fillUnitInput(tankForm.capacityBbl, "volume", t.capacityBbl);
  // A new tank goes in the same location as the last tank, as a starting guess
  fillLocationDropdown(tank ? t.locationId : data.tanks.at(-1)?.locationId);
  tankForm.status.value = t.status;
  tankForm.acidEveryTurns.value = t.acidEveryTurns ?? "";
  showAcidSection(tank);
  tankDialog.showModal();
}

// The tank form's acid section: last acid cycle, turns since, and the log.
// (A tank that hasn't been saved yet has no log.)
function showAcidSection(tank) {
  document.getElementById("acid-log-area").hidden = !tank;
  if (!tank) return;
  const acid = acidState(tank);
  const turns = tank.acidEveryTurns ? `${acid.turns} of ${tank.acidEveryTurns}` : acid.turns;
  const summary = acid.last
    ? `Last acid ${formatDate(acid.last.cleanedOn)} · ${turns} ${acid.turns === 1 ? "turn" : "turns"} since.`
    : `No acid cycle logged yet · ${turns} ${acid.turns === 1 ? "turn" : "turns"} so far.`;
  document.getElementById("acid-summary").textContent = summary;
  document.getElementById("acid-due-note").hidden = !acid.due;
  document.getElementById("acid-due-note").textContent = `Acid due · ${acid.reason}`;

  // Newest first, last 5
  document.getElementById("acid-history").innerHTML = acidCycles(tank.id).slice(-5).reverse().map((c) => `
    <li class="item">
      <span>${formatDate(c.cleanedOn)}${c.note ? ` <span class="muted">· ${esc(c.note)}</span>` : ""}</span>
      <button type="button" class="btn small" data-remove-acid="${c.id}">Remove</button>
    </li>`).join("");
}

// Log an acid cycle: a small form on top of the tank form
const acidDialog = document.getElementById("acid-editor");
const acidForm = document.getElementById("acid-form");

document.getElementById("log-acid").addEventListener("click", () => {
  document.getElementById("acid-title").textContent = `Acid cycle on ${editingTank.name}`;
  acidForm.cleanedOn.value = today();
  acidForm.note.value = "";
  acidDialog.showModal();
});

acidForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tankId = editingTank.id;
  const ok = await saveOrKeep("logAcid", {
    id: newId(), breweryId: brewery.id, tankId,
    cleanedOn: acidForm.cleanedOn.value, note: acidForm.note.value.trim(),
  }, `Acid cycle on ${editingTank.name}`);
  if (!ok) return;
  acidDialog.close();
  editingTank = findTank(tankId); // the data was reloaded, so pick up the fresh copy
  showAcidSection(editingTank);
});

// Remove an acid cycle logged by mistake
document.getElementById("acid-history").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-remove-acid]");
  if (!button) return;
  const cycle = data.cleanings.find((c) => c.id === button.dataset.removeAcid);
  if (!confirm(`Remove the acid cycle on ${formatDate(cycle.cleanedOn)} from ${editingTank.name}'s log?`)) return;
  const tankId = editingTank.id;
  await save(() => must(db.from("tank_cleanings").delete().eq("id", cycle.id)));
  editingTank = findTank(tankId);
  showAcidSection(editingTank);
});

// Picking "+ New location…" opens the location form on top of the tank form
tankForm.locationId.addEventListener("change", () => {
  if (tankForm.locationId.value === NEW_LOCATION) openLocationEditor(null);
  else locationChoiceBeforeNew = tankForm.locationId.value;
});

tankForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = tankForm.name.value.trim();
  if (data.tanks.some((t) => t !== editingTank && t.name.toLowerCase() === name.toLowerCase())) {
    alert(`There's already a tank called ${name}.`);
    return;
  }
  const fields = {
    name,
    type: tankForm.type.value,
    capacity_bbl: readUnitInput(tankForm.capacityBbl, "volume"), // stored in barrels
    location_id: ["", NEW_LOCATION].includes(tankForm.locationId.value) ? null : tankForm.locationId.value,
    status: tankForm.status.value,
    acid_every_turns: tankForm.acidEveryTurns.value ? Number(tankForm.acidEveryTurns.value) : null,
  };
  // Changing an existing tank works offline; adding a new tank needs signal
  const ok = editingTank
    ? await saveOrKeep("updateTank", {
        id: editingTank.id, name: fields.name, type: fields.type, capacityBbl: fields.capacity_bbl,
        locationId: fields.location_id, status: fields.status, acidEveryTurns: fields.acid_every_turns,
      }, `${editingTank.name} settings`)
    : await save(() => must(db.from("tanks").insert({ brewery_id: brewery.id, ...fields })));
  if (ok) tankDialog.close();
});

document.getElementById("delete-tank").addEventListener("click", async () => {
  const batch = batchInTank(editingTank.id);
  if (batch) {
    alert(`${editingTank.name} has ${beerName(batch)} in it. Move or package that batch first.`);
    return;
  }
  // The database also refuses if any batch has EVER been in this tank (records need that history)
  if (data.events.some((e) => e.tankId === editingTank.id)) {
    alert(`${editingTank.name} has batch history, so it can't be deleted. The records need to know where beer has been.`);
    return;
  }
  if (!confirm(`Delete ${editingTank.name}?`)) return;
  const ok = await save(() => must(db.from("tanks").delete().eq("id", editingTank.id)));
  if (ok) tankDialog.close();
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
  fillUnitInput(beerForm.targetOg, "gravity", b.targetOg);
  fillUnitInput(beerForm.targetFg, "gravity", b.targetFg);
  showTargetAbv();
  beerDialog.showModal();
}

// Update the ABV line as you type the gravities
function showTargetAbv() {
  const a = abv(readUnitInput(beerForm.targetOg, "gravity"), readUnitInput(beerForm.targetFg, "gravity"));
  document.getElementById("target-abv").textContent = a !== null ? `${a.toFixed(1)}%` : "—";
}
beerForm.targetOg.addEventListener("input", showTargetAbv);
beerForm.targetFg.addEventListener("input", showTargetAbv);

beerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = {
    name: beerForm.name.value.trim(),
    style: beerForm.style.value.trim(),
    target_og: readUnitInput(beerForm.targetOg, "gravity"), // typed in the brewery's unit, stored as SG
    target_fg: readUnitInput(beerForm.targetFg, "gravity"),
  };
  if (data.beers.some((b) => b !== editingBeer && b.name.toLowerCase() === values.name.toLowerCase())) {
    alert(`There's already a beer called ${values.name}.`);
    return;
  }
  if (values.target_og && values.target_fg && values.target_fg >= values.target_og) {
    alert("Target FG should be lower than target OG.");
    return;
  }

  const addingFromBatchForm = batchDialog.open && !editingBeer;
  const newBeerId = newId();
  const ok = await save(() => editingBeer
    ? must(db.from("beers").update(values).eq("id", editingBeer.id))
    : must(db.from("beers").insert({
        id: newBeerId, brewery_id: brewery.id, code: beerCodeFor(values.name, data.beers), ...values,
      })));
  if (!ok) return;
  // If you added this beer from inside the batch form, select it there
  if (addingFromBatchForm) fillBeerDropdown(newBeerId);
  beerDialog.close();
});

// If you cancel adding a beer from the batch form, put the Beer dropdown back how it was
beerDialog.addEventListener("close", () => {
  if (batchForm.beerId.value === NEW_BEER) batchForm.beerId.value = beerChoiceBeforeNew;
});

document.getElementById("delete-beer").addEventListener("click", async () => {
  // Batches point at beers, so a beer that's been brewed can't be deleted
  const used = data.batches.filter((b) => b.beerId === editingBeer.id);
  if (used.length) {
    const list = used.map((b) => (b.batchNumber ? "#" + b.batchNumber : "a batch with no number")).join(", ");
    alert(`${editingBeer.name} can't be deleted because batches of it exist (${list}).`);
    return;
  }
  if (!confirm(`Delete ${editingBeer.name}?`)) return;
  const ok = await save(() => must(db.from("beers").delete().eq("id", editingBeer.id)));
  if (ok) beerDialog.close();
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

locationForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = locationForm.name.value.trim();
  if (data.locations.some((l) => l !== editingLocation && l.name.toLowerCase() === name.toLowerCase())) {
    alert(`There's already a location called ${name}.`);
    return;
  }
  const addingFromTankForm = tankDialog.open && !editingLocation;
  const newLocationId = newId();
  const ok = await save(() => editingLocation
    ? must(db.from("locations").update({ name }).eq("id", editingLocation.id))
    : must(db.from("locations").insert({ id: newLocationId, brewery_id: brewery.id, name })));
  if (!ok) return;
  // If you added this location from inside the tank form, select it there
  if (addingFromTankForm) fillLocationDropdown(newLocationId);
  locationDialog.close();
});

// If you cancel adding a location from the tank form, put the Location dropdown back how it was
locationDialog.addEventListener("close", () => {
  if (tankForm.locationId.value === NEW_LOCATION) tankForm.locationId.value = locationChoiceBeforeNew;
});

document.getElementById("delete-location").addEventListener("click", async () => {
  // Tanks point at locations, so a location with tanks in it can't be deleted
  const tanks = data.tanks.filter((t) => t.locationId === editingLocation.id);
  if (tanks.length) {
    alert(`${editingLocation.name} still has tanks (${tanks.map((t) => t.name).join(", ")}). Move or delete them first.`);
    return;
  }
  if (!confirm(`Delete ${editingLocation.name}?`)) return;
  const ok = await save(() => must(db.from("locations").delete().eq("id", editingLocation.id)));
  if (ok) locationDialog.close();
});

// ---------- 11. Backups, sample data, and data from the old version ----------
// A backup is one file holding everything in the brewery: locations, beers, tanks,
// batches, and batch history. The "format" number lets the app recognize older backups.
//   format 1 — made by the browser-only version (no history, just each batch's current stage)
//   format 2 — made by the database version (includes the full history)
const BACKUP_FORMAT = 2;

function downloadBackup() {
  const backup = {
    app: "brewery-os", format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), brewery: brewery.name, data,
  };
  const file = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `brewery-os-backup-${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Data saved by the browser-only version of the app, if this browser has any
const STORAGE_KEY = "brewery-os.data";
const OLD_STORAGE_KEY = "brewery-os.tanks"; // the very first version (no batches)
function browserData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if (saved) return upgradeData(JSON.parse(saved));
    if (old) return upgradeData(convertOldData(JSON.parse(old)));
  } catch (e) {
    console.warn("Couldn't read data saved in this browser.", e);
  }
  return null;
}

// First version stored the beer right on the tank. Split it into a tank + a batch.
function convertOldData(oldTanks) {
  const result = { tanks: [], batches: [] };
  for (const t of oldTanks) {
    const tank = { id: newId(), name: t.tank, type: t.type };
    result.tanks.push(tank);
    if (t.beer && t.stage !== "empty") {
      result.batches.push({
        id: newId(), batchId: "", beerName: t.beer, brewDate: t.stageStart, sizeBbl: null,
        stage: t.stage, stageStartDate: t.stageStart, tankId: tank.id,
      });
    }
  }
  return result;
}

// Bring data from an older version up to the current shape
function upgradeData(d) {
  d.locations ??= [];
  d.beers ??= [];
  d.cleanings ??= [];        // acid log: added in October 2026
  d.acidAfterStyles ??= [];

  for (const tank of d.tanks) {
    tank.capacityBbl ??= null;
    tank.status ??= "empty";
    tank.acidEveryTurns ??= null;
    // Typed location names become location records
    if (tank.locationId === undefined) {
      const name = (tank.location || "").trim();
      let location = d.locations.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (name && !location) {
        location = { id: newId(), name };
        d.locations.push(location);
      }
      tank.locationId = location ? location.id : null;
      delete tank.location;
    }
  }

  for (const batch of d.batches) {
    // Typed beer names become beer records
    if (!batch.beerId) {
      const name = batch.beerName || "Unnamed beer";
      let beer = d.beers.find((b) => b.name.toLowerCase() === name.toLowerCase());
      if (!beer) {
        beer = { id: newId(), name, style: "", targetOg: null, targetFg: null };
        d.beers.push(beer);
      }
      batch.beerId = beer.id;
      delete batch.beerName;
    }
    // Older versions called the batch number "batchId"
    batch.batchNumber ??= batch.batchId ?? "";
    delete batch.batchId;
  }
  return d;
}

// Put a whole set of data (backup, sample, or old browser data) into this brewery.
// Only into an EMPTY brewery, so nothing gets mixed up or duplicated.
async function loadIntoBrewery(source, description) {
  if (!isEmptyBrewery()) {
    alert("Data can only be loaded into an empty brewery, so nothing gets mixed up or duplicated.");
    return;
  }
  const d = upgradeData(structuredClone(source));
  const summary = [
    count(d.tanks.length, "tank", "tanks"),
    count(d.batches.length, "batch", "batches"),
    count(d.beers.length, "beer", "beers"),
  ].join(", ");
  if (!confirm(`Load ${description} (${summary}) into ${brewery.name}?`)) return;

  // Every record gets a fresh database ID. These maps turn old IDs into new ones
  // so links between records (batch → beer, tank → location...) stay connected.
  const ids = new Map();
  const idFor = (oldId) => {
    if (oldId == null) return null;
    if (!ids.has(oldId)) ids.set(oldId, newId());
    return ids.get(oldId);
  };
  const b = brewery.id;
  const codes = [];

  const ok = await save(async () => {
    try {
      if (d.locations.length) {
        await must(db.from("locations").insert(d.locations.map((l) => ({ id: idFor(l.id), brewery_id: b, name: l.name }))));
      }
      if (d.beers.length) {
        await must(db.from("beers").insert(d.beers.map((x) => {
          const code = beerCodeFor(x.name, codes);
          codes.push({ code });
          return {
            id: idFor(x.id), brewery_id: b, code, name: x.name, style: x.style || "",
            target_og: x.targetOg ?? null, target_fg: x.targetFg ?? null,
          };
        })));
      }
      if (d.tanks.length) {
        await must(db.from("tanks").insert(d.tanks.map((t) => ({
          id: idFor(t.id), brewery_id: b, name: t.name, type: t.type, status: t.status,
          capacity_bbl: t.capacityBbl, location_id: idFor(t.locationId), acid_every_turns: t.acidEveryTurns,
        }))));
      }
      if (d.cleanings.length) {
        await must(db.from("tank_cleanings").insert(d.cleanings.map((c) => ({
          brewery_id: b, tank_id: idFor(c.tankId), kind: "acid", cleaned_on: c.cleanedOn, note: c.note || "",
        }))));
      }
      // The brewery-wide style list is an admin setting; skipped quietly for anyone else
      if (d.acidAfterStyles.length && brewery.role === "admin") {
        await must(db.from("breweries").update({ acid_after_styles: d.acidAfterStyles }).eq("id", b));
      }
      if (d.batches.length) {
        await must(db.from("batches").insert(d.batches.map((x) => ({
          id: idFor(x.id), brewery_id: b, batch_number: x.batchNumber || "?", beer_id: idFor(x.beerId),
          brew_date: x.brewDate, size_bbl: x.sizeBbl,
        }))));
        // History: newer backups include it. Older data only knows each batch's current
        // stage, so that becomes the batch's one history event.
        const events = d.events?.length
          ? d.events.map((e) => ({ batch: e.batchId, date: e.effectiveDate, stage: e.stage, tank: e.tankId }))
          : d.batches.map((x) => ({
              batch: x.id, date: x.stageStartDate, stage: x.stage, tank: x.stage === "packaged" ? null : x.tankId,
            }));
        await must(db.from("batch_events").insert(events.map((e) => ({
          brewery_id: b, batch_id: idFor(e.batch), effective_date: e.date, stage: e.stage, tank_id: idFor(e.tank),
        }))));
      }
    } catch (error) {
      // Don't leave half-loaded data behind: empty the brewery again, then report the error
      await clearBrewery();
      throw error;
    }
  });
  if (ok) alert(`Loaded ${summary}.`);
}

// Remove everything in this brewery (used to undo a load that failed partway)
async function clearBrewery() {
  const b = brewery.id;
  await db.from("batches").delete().eq("brewery_id", b); // history goes with its batches
  await db.from("tanks").delete().eq("brewery_id", b);
  await db.from("beers").delete().eq("brewery_id", b);
  await db.from("locations").delete().eq("brewery_id", b);
}

function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`; // "1 tank", "2 tanks"
}

async function loadBackupFile(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    alert("That file isn't a Brewery OS backup (it couldn't be read).");
    return;
  }
  // Check it's really one of our backups before loading anything
  const d = backup?.data;
  if (backup?.app !== "brewery-os" || !Array.isArray(d?.tanks) || !Array.isArray(d?.batches)) {
    alert("That file isn't a Brewery OS backup.");
    return;
  }
  if (backup.format > BACKUP_FORMAT) {
    alert("That backup was made by a newer version of Brewery OS. Reload the page to get the latest version, then try again.");
    return;
  }
  await loadIntoBrewery(d, `the backup from ${new Date(backup.exportedAt).toLocaleString()}`);
}

// ---------- 12. Signing in and choosing a brewery ----------
const screens = ["loading-screen", "signin-screen", "setup-screen", "app-screen"];
function showScreen(id) {
  for (const s of screens) document.getElementById(s).hidden = s !== id;
}

const signinForm = document.getElementById("signin-form");
const codeForm = document.getElementById("code-form");

// The real project's codes are 8 digits; the local test copy's are 6 (supabase/config.toml)
codeForm.code.placeholder = ON_THIS_COMPUTER ? "123456" : "12345678";

// Show a problem on the sign-in screen itself (or clear it with no text)
function signinMessage(text) {
  const el = document.getElementById("signin-message");
  el.textContent = text || "";
  el.hidden = !text;
}

function explainSigninError(error) {
  if (/rate limit/i.test(error.message)) {
    return "Too many sign-in emails were sent recently. Please wait an hour and try again. " +
      "(If you already have a code from an earlier email, it may still work.)";
  }
  if (/expired|invalid/i.test(error.message) && error.code !== "email_address_invalid") {
    return "That code didn't work. It may have expired or already been used. Request a new one.";
  }
  return explain(error);
}

// Step 1: email address -> Supabase emails a code (and a link) to it
signinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = signinForm.email.value.trim();
  const button = signinForm.querySelector("button");
  button.disabled = true;
  signinMessage("");
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  button.disabled = false;
  if (error) {
    signinMessage(`Couldn't send the email. ${explainSigninError(error)}`);
    return;
  }
  document.getElementById("code-sent").textContent =
    `We emailed a sign-in code to ${email}. Type it below, or tap the link in the email.`;
  signinForm.hidden = true;
  codeForm.hidden = false;
  codeForm.code.focus();
});

// Step 2: type the code from the email (works on any device)
codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await db.auth.verifyOtp({
    email: signinForm.email.value.trim(),
    token: codeForm.code.value.replace(/\D/g, ""), // digits only: a pasted "1234 5678" still works
    type: "email",
  });
  if (error) signinMessage(explainSigninError(error));
  // On success, the "signed in" listener below takes over
});

document.getElementById("code-back").addEventListener("click", () => {
  signinMessage("");
  codeForm.hidden = true;
  signinForm.hidden = false;
});

// Signing out deletes this device's offline copy, and works even with no signal
// ("local" = sign out on this device only)
document.querySelectorAll(".sign-out").forEach((btn) =>
  btn.addEventListener("click", async () => {
    if (outbox.length && !confirm(`${count(outbox.length, "change hasn't", "changes haven't")} been sent yet. ` +
      `Signing out now deletes ${outbox.length === 1 ? "it" : "them"}. Sign out anyway?`)) return;
    outbox = [];
    storeList(OUTBOX_KEY, outbox);
    deleteOfflineCopy();
    await db.auth.signOut({ scope: "local" });
    showOnline();
    showScreen("signin-screen");
  })
);

// New user with no brewery yet: create one (they become its admin)
document.getElementById("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { data: newBreweryId, error } = await db.rpc("create_brewery", { brewery_name: e.target.name.value.trim() });
  if (error) {
    alert(`Couldn't create the brewery: ${explain(error)}`);
    return;
  }
  // Start with this device's time zone (the admin can change it in Brewery settings)
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (deviceZone) await db.from("breweries").update({ time_zone: deviceZone }).eq("id", newBreweryId);
  await start();
});

// Work out what to show: sign-in, "create your brewery", or the app
let starting = false;
let startAgain = false; // if something changes while start() is running, run it once more after
async function start() {
  if (starting) {
    startAgain = true;
    return;
  }
  starting = true;
  try {
    const { data: { session }, error } = await db.auth.getSession();
    if (!session) {
      // With no signal, the sign-in can't be checked: show this device's copy if it has one
      if ((!navigator.onLine || (error && isConnectionProblem(error))) && openOfflineCopy()) return;
      showScreen("signin-screen");
      return;
    }
    signedInEmail = session.user.email;
    document.getElementById("signed-in-as").textContent = `Signed in as ${session.user.email}`;

    // Join any brewery that invited this email
    await must(db.rpc("accept_invites"));

    // Which breweries are you in? Use the one you picked last time, or the first.
    const memberships = await must(db.from("memberships").select("role, breweries(id, name)").eq("user_id", session.user.id));
    if (!memberships.length) {
      showScreen("setup-screen");
      return;
    }
    const chosen = readChoice();
    const m = memberships.find((x) => x.breweries.id === chosen) || memberships[0];
    brewery = { id: m.breweries.id, name: m.breweries.name, role: m.role };
    showBrewerySwitch(memberships);
    await refresh();
    showScreen("app-screen");
  } catch (e) {
    if (isConnectionProblem(e) && openOfflineCopy()) return;
    alert(`Something went wrong loading your data: ${explain(e)}`);
  } finally {
    starting = false;
    if (startAgain) {
      startAgain = false;
      start();
    }
  }
}

// ----- More than one brewery -----
const CHOICE_KEY = "brewery-os.current-brewery";
function readChoice() {
  try { return localStorage.getItem(CHOICE_KEY); } catch { return null; }
}

function showBrewerySwitch(memberships) {
  const field = document.getElementById("brewery-switch-field");
  field.hidden = memberships.length < 2;
  document.getElementById("brewery-switch").innerHTML = memberships
    .map((x) => `<option value="${x.breweries.id}" ${x.breweries.id === brewery.id ? "selected" : ""}>${esc(x.breweries.name)}</option>`)
    .join("");
}

document.getElementById("brewery-switch").addEventListener("change", async (e) => {
  if (outbox.length) {
    alert("Some changes haven't been sent yet. Switch breweries once they've gone through.");
    e.target.value = brewery.id;
    return;
  }
  try { localStorage.setItem(CHOICE_KEY, e.target.value); } catch {}
  await start();
});

document.getElementById("check-invites").addEventListener("click", () => start());

// Signing in or out (in this tab, or from the emailed link) re-runs start()
db.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") setTimeout(start, 0);
});

// ----- Brewery settings (units and time zone) -----
const settingsForm = document.getElementById("settings-form");

// Every time zone the browser knows, for the dropdown (filled once)
const TIME_ZONES = (Intl.supportedValuesOf?.("timeZone") || [DEFAULT_PREFS.timeZone]);
settingsForm.timeZone.innerHTML = TIME_ZONES.map((z) => `<option value="${z}">${z.replace(/_/g, " ")}</option>`).join("");

function renderSettings() {
  const p = prefs();
  const isAdmin = brewery.role === "admin";
  settingsForm.temperatureUnit.value = p.temperatureUnit;
  settingsForm.gravityUnit.value = p.gravityUnit;
  settingsForm.volumeUnit.value = p.volumeUnit;
  if (!TIME_ZONES.includes(p.timeZone)) {
    settingsForm.timeZone.insertAdjacentHTML("afterbegin", `<option value="${esc(p.timeZone)}">${esc(p.timeZone)}</option>`);
  }
  settingsForm.timeZone.value = p.timeZone;
  for (const el of settingsForm.elements) el.disabled = !isAdmin;
  document.getElementById("save-settings").hidden = !isAdmin;
  document.getElementById("settings-admin-note").hidden = isAdmin;
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await save(async () => {
    const saved = await must(db.from("breweries").update({
      temperature_unit: settingsForm.temperatureUnit.value,
      gravity_unit: settingsForm.gravityUnit.value,
      volume_unit: settingsForm.volumeUnit.value,
      time_zone: settingsForm.timeZone.value,
    }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("Only an admin can change the brewery settings.");
  });
});

// ----- Team: members, roles, and invites -----
const ROLES = [
  { id: "admin",  label: "Admin" },
  { id: "brewer", label: "Brewer" },
  { id: "viewer", label: "Viewer" },
];

function renderTeam() {
  const isAdmin = brewery.role === "admin";
  const members = data.members || [];
  const invites = data.invites || [];
  document.getElementById("member-list").innerHTML = members.map((m) => {
    const me = m.email === signedInEmail ? " (you)" : "";
    const controls = isAdmin
      ? `<select data-role-for="${m.userId}" aria-label="Role for ${esc(m.email)}">
           ${ROLES.map((r) => `<option value="${r.id}" ${r.id === m.role ? "selected" : ""}>${r.label}</option>`).join("")}
         </select>
         <button class="btn small" data-remove-member="${m.userId}">Remove</button>`
      : `<span class="muted">${labelFrom(ROLES, m.role)}</span>`;
    return `<li class="item"><span class="who">${esc(m.email)}${me}</span><span class="controls">${controls}</span></li>`;
  }).join("");

  document.getElementById("invite-area").hidden = !isAdmin;
  document.getElementById("invite-heading").hidden = !invites.length;
  document.getElementById("invite-list").innerHTML = invites.map((i) => `
    <li class="item">
      <span class="who">${esc(i.email)} <span class="muted">· ${labelFrom(ROLES, i.role)}</span></span>
      <button class="btn small" data-cancel-invite="${i.id}">Cancel</button>
    </li>`).join("");
}

function inviteMessage(text) {
  const el = document.getElementById("invite-message");
  el.textContent = text || "";
  el.hidden = !text;
}

const inviteForm = document.getElementById("invite-form");
inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = inviteForm.email.value.trim().toLowerCase();
  const role = inviteForm.role.value;
  if (data.members.some((m) => m.email.toLowerCase() === email)) {
    inviteMessage(`${email} is already on the team.`);
    return;
  }
  if (data.invites.some((i) => i.email === email)) {
    inviteMessage(`${email} has already been invited.`);
    return;
  }
  const ok = await save(() => must(db.from("invites").insert({ brewery_id: brewery.id, email, role })));
  if (!ok) return;
  inviteForm.reset();
  inviteMessage(`Invited ${email} as ${labelFrom(ROLES, role).toLowerCase()}. ` +
    `Ask them to open ${location.host} and sign in with that email; they'll join ${brewery.name} automatically.`);
});

// Change someone's role, remove someone, or cancel an invite (admins only; the database checks too).
// The database also refuses to remove or demote the last admin.
document.getElementById("team").addEventListener("change", async (e) => {
  const select = e.target.closest("[data-role-for]");
  if (!select) return;
  const userId = select.dataset.roleFor;
  const member = data.members.find((m) => m.userId === userId);
  if (member.email === signedInEmail && select.value !== "admin" &&
      !confirm(`Change your own role to ${labelFrom(ROLES, select.value).toLowerCase()}? You'll no longer be able to manage the team.`)) {
    select.value = member.role;
    return;
  }
  const ok = await save(() => must(db.from("memberships").update({ role: select.value })
    .eq("brewery_id", brewery.id).eq("user_id", userId)));
  if (ok && member.email === signedInEmail) await start(); // your own role changed: reload what you can do
});

document.getElementById("team").addEventListener("click", async (e) => {
  const remove = e.target.closest("[data-remove-member]");
  const cancel = e.target.closest("[data-cancel-invite]");
  if (remove) {
    const member = data.members.find((m) => m.userId === remove.dataset.removeMember);
    const yourself = member.email === signedInEmail;
    const question = yourself
      ? `Leave ${brewery.name}? You'll lose access to it.`
      : `Remove ${member.email} from ${brewery.name}?`;
    if (!confirm(question)) return;
    const ok = await save(() => must(db.from("memberships").delete()
      .eq("brewery_id", brewery.id).eq("user_id", member.userId)));
    if (ok && yourself) await start();
  }
  if (cancel) {
    const ok = await save(() => must(db.from("invites").delete().eq("id", cancel.dataset.cancelInvite)));
    if (ok) inviteMessage("");
  }
});

// ---------- 13. Wiring up taps and clicks ----------
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

// Tapping a location opens it
locationList.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  openLocationEditor(findLocation(row.dataset.location));
});

// The brewery's acid-after styles: add one, or remove one (admins only; the database enforces it too)
async function saveAcidStyles(styles) {
  return save(async () => {
    const saved = await must(db.from("breweries").update({ acid_after_styles: styles }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("Only an admin can change this list.");
  });
}

acidStyleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const style = acidStyleForm.style.value.trim();
  if (!style) return;
  if (data.acidAfterStyles.some((s) => s.toLowerCase() === style.toLowerCase())) {
    alert(`${style} is already on the list.`);
    return;
  }
  if (await saveAcidStyles([...data.acidAfterStyles, style])) acidStyleForm.reset();
});

acidStyleList.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-remove-style]");
  if (!button) return;
  const style = data.acidAfterStyles[Number(button.dataset.removeStyle)]; // its position in the list
  if (!confirm(`Stop flagging tanks for acid after ${style}?`)) return;
  await saveAcidStyles(data.acidAfterStyles.filter((s) => s !== style));
});

document.getElementById("add-tank").addEventListener("click", () => openTankEditor(null));
document.getElementById("add-beer").addEventListener("click", () => openBeerEditor(null));
document.getElementById("add-location").addEventListener("click", () => openLocationEditor(null));

// Getting-started buttons for an empty brewery
document.getElementById("load-sample").addEventListener("click", () => loadIntoBrewery(sampleData(), "the sample data"));
document.getElementById("load-browser-data").addEventListener("click", () => {
  const d = browserData();
  if (d) loadIntoBrewery(d, "the data saved in this browser");
});

// Backup buttons. "Load" opens the hidden file picker; picking a file starts loading it.
const importFile = document.getElementById("import-file");
document.getElementById("export-data").addEventListener("click", downloadBackup);
document.querySelectorAll(".restore-backup").forEach((btn) =>
  btn.addEventListener("click", () => importFile.click())
);
importFile.addEventListener("change", () => {
  if (importFile.files[0]) loadBackupFile(importFile.files[0]);
  importFile.value = ""; // so picking the same file again still works
});

// Every Cancel button closes whichever pop-up it's in
document.querySelectorAll(".cancel").forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog").close())
);

// ---------- 14. Staying up to date, online or off ----------
// Keep a copy of the app itself on this device, so it opens with no signal (see sw.js)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("No offline copy of the app:", e));
}

// Signal back: reload everything (this also hides the offline banner)
window.addEventListener("online", () => start());
// Signal gone: say so right away, before anyone tries to save
window.addEventListener("offline", () => {
  if (!document.getElementById("app-screen").hidden) showOffline();
});
// Coming back to the app (phone unlocked, tab switched back): get the latest
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && brewery && !busy && navigator.onLine) {
    refresh().catch((e) => { if (isConnectionProblem(e)) showOffline(); });
  }
});

// Changes waiting to send: try again every 30 seconds (a phone doesn't always announce that signal is back)
setInterval(() => {
  if (outbox.length && brewery && !busy && !sending && navigator.onLine) {
    refresh().catch((e) => { if (isConnectionProblem(e)) showOffline(); });
  }
}, 30000);

// ---------- 15. Go ----------
showSyncProblems();
start();
