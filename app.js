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
const DEFAULT_PREFS = {
  temperatureUnit: "F", gravityUnit: "plato", volumeUnit: "bbl", timeZone: "America/Chicago",
  targetLimits: { gravity: 0.004, temperature: 1.6667, ph: 0.15, amount: 0.1 },
};
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
  const [locations, beers, tanks, batches, events, cleanings, settings, members, invites, permissions, memberRows, levels, cellar, additions, readings] = await Promise.all([
    must(db.from("locations").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("beers").select("*").eq("brewery_id", b)),
    must(db.from("tanks").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("batch_status").select("*").eq("brewery_id", b)),
    must(db.from("batch_events").select("*").eq("brewery_id", b).order("effective_date").order("recorded_at")),
    must(db.from("tank_cleanings").select("*").eq("brewery_id", b).order("cleaned_on").order("recorded_at")),
    must(db.from("breweries").select("acid_after_styles, temperature_unit, gravity_unit, volume_unit, time_zone, target_limits, sheet_fields").eq("id", b).single()),
    must(db.rpc("brewery_members", { p_brewery_id: b })),
    must(db.from("invites").select("*").eq("brewery_id", b).order("created_at")), // admins only; others get none
    must(db.rpc("my_permissions", { b })),
    must(db.from("memberships").select("user_id, role, grants, revokes").eq("brewery_id", b)),
    must(db.from("role_levels").select("level, permissions").eq("brewery_id", b)),
    must(db.from("cellar_entries").select("*").eq("brewery_id", b).order("occurred_on").order("recorded_at")),
    must(db.from("batch_additions").select("*").eq("brewery_id", b).order("added_on").order("recorded_at")),
    // (only each field's current value; history stays in the database)
    must(db.from("batch_readings_current").select("id, batch_id, turn, field_key, value, value_text, raw, recorded_at").eq("brewery_id", b)),
  ]);
  // Each member: email and level (from brewery_members) plus their personal adjustments
  const adjustments = Object.fromEntries(memberRows.map((r) => [r.user_id, r]));
  serverData = {
    locations: locations.map((l) => ({
      id: l.id, name: l.name,
      // Brewhouse settings (used by brew-day sheets at this location)
      turnSizeBbl: num(l.turn_size_bbl), usualTurns: l.usual_turns, kettleFullBbl: num(l.kettle_full_bbl),
      flowTarget: l.flow_target, waterGristQtLb: num(l.water_grist_qt_lb), absorptionGalLb: num(l.grain_absorption_gal_lb),
    })),
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
      turns: x.turns || 1,
      // These three come from the newest event in the batch's history
      stage: x.stage, tankId: x.tank_id, stageStartDate: x.stage_started_on,
    })),
    events: events.map((e) => ({
      id: e.id, batchId: e.batch_id, effectiveDate: e.effective_date, stage: e.stage, tankId: e.tank_id,
    })),
    cleanings: cleanings.map((c) => ({ id: c.id, tankId: c.tank_id, cleanedOn: c.cleaned_on, note: c.note })),
    acidAfterStyles: settings.acid_after_styles,
    sheetFields: settings.sheet_fields,
    prefs: {
      temperatureUnit: settings.temperature_unit, gravityUnit: settings.gravity_unit,
      volumeUnit: settings.volume_unit, timeZone: settings.time_zone, targetLimits: settings.target_limits,
    },
    members: members.map((m) => ({
      userId: m.user_id, email: m.email, role: m.role,
      grants: adjustments[m.user_id]?.grants || [], revokes: adjustments[m.user_id]?.revokes || [],
    })),
    levels: Object.fromEntries(levels.map((l) => [l.level, l.permissions])),
    cellar: cellar.map((c) => ({
      id: c.id, batchId: c.batch_id, occurredOn: c.occurred_on, action: c.action,
      gravitySg: num(c.gravity_sg), ph: num(c.ph), tempC: num(c.temp_c),
      cellarChange: c.cellar_change, notes: c.notes, edited: !!c.updated_at, recordedAt: c.recorded_at,
    })),
    readings: readings.map((r) => ({
      id: r.id, batchId: r.batch_id, turn: r.turn, fieldKey: r.field_key, value: num(r.value),
      valueText: r.value_text, raw: r.raw, recordedAt: r.recorded_at,
    })),
    additions: additions.map((a) => ({
      id: a.id, batchId: a.batch_id, addedOn: a.added_on, kind: a.kind, name: a.name,
      amount: num(a.amount), unit: a.unit, timing: a.timing, lot: a.lot, notes: a.notes, recordedAt: a.recorded_at,
    })),
    permissions,
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role })),
  };
  data = withWaitingChanges(serverData);
  brewery.prefs = serverData.prefs;
  brewery.sheetFields = serverData.sheetFields;
  brewery.permissions = serverData.permissions;
  brewery.role = (serverData.members.find((m) => m.email === signedInEmail) || {}).role || brewery.role;
}

// A number from the database (which sends some numbers as text), or null
function num(v) {
  return v === null || v === undefined ? null : Number(v);
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

// Cellar entries and additions (new ones, and corrections)
const cellarRow = (a) => ({
  occurred_on: a.occurredOn, action: a.action, gravity_sg: a.gravitySg, ph: a.ph, temp_c: a.tempC,
  cellar_change: a.cellarChange, notes: a.notes,
});
const additionRow = (a) => ({
  added_on: a.addedOn, kind: a.kind, name: a.name, amount: a.amount, unit: a.unit,
  timing: a.timing, lot: a.lot, notes: a.notes,
});
Object.assign(SEND, {
  saveReading: async (a) => {
    try {
      await must(db.from("batch_readings").insert({
        id: a.id, brewery_id: a.breweryId, batch_id: a.batchId, turn: a.turn, field_key: a.fieldKey,
        value: a.value, value_text: a.valueText, raw: a.raw,
      }));
    } catch (e) {
      if (e.code !== "23505") throw e; // already there: it was sent before the connection dropped
    }
  },
  setTurns: (a) => must(db.from("batches").update({ turns: a.turns }).eq("id", a.batchId)),
  logCellar: (a) => must(db.rpc("log_cellar_entry", a)),
  editCellar: (a) => must(db.from("cellar_entries").update(cellarRow(a)).eq("id", a.id)),
  logAddition: async (a) => {
    try {
      await must(db.from("batch_additions").insert({ id: a.id, brewery_id: a.breweryId, batch_id: a.batchId, ...additionRow(a) }));
    } catch (e) {
      if (e.code !== "23505") throw e; // already there: it was sent before the connection dropped
    }
  },
  editAddition: (a) => must(db.from("batch_additions").update(additionRow(a)).eq("id", a.id)),
});

// How each kind of change looks on screen before it's sent (mirrors what the database will do)
const SHOW = {
  saveBatch(d, a) {
    let batch = d.batches.find((b) => b.id === a.p_id);
    const before = batch ? { stage: batch.stage, tankId: batch.tankId } : null;
    if (!batch) {
      // A new batch: the database gives it the brewhouse's usual number of turns
      const usualTurns = d.locations.find((l) => l.id === d.tanks.find((t) => t.id === a.p_tank_id)?.locationId)?.usualTurns;
      d.batches.push(batch = { id: a.p_id, turns: usualTurns || 1 });
    }
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
  logCellar(d, a) {
    d.cellar.push({
      id: a.p_id, batchId: a.p_batch_id, occurredOn: a.p_occurred_on, action: a.p_action, gravitySg: a.p_gravity_sg,
      ph: a.p_ph, tempC: a.p_temp_c, cellarChange: a.p_cellar_change, notes: a.p_notes, edited: false,
      recordedAt: new Date().toISOString(),
    });
    const batch = d.batches.find((b) => b.id === a.p_batch_id);
    if (a.p_new_stage && batch && batch.stage !== a.p_new_stage) {
      batch.stage = a.p_new_stage;
      batch.stageStartDate = a.p_occurred_on;
      d.events.push({ id: `waiting-${a.p_id}`, batchId: batch.id, effectiveDate: a.p_occurred_on, stage: a.p_new_stage, tankId: batch.tankId });
    }
  },
  editCellar(d, a) {
    const entry = d.cellar.find((c) => c.id === a.id);
    if (entry) Object.assign(entry, { ...a, edited: true });
  },
  logAddition(d, a) {
    d.additions.push({ ...a, recordedAt: new Date().toISOString() });
  },
  saveReading(d, a) {
    // The newest reading is the current one: replace this field's value for this batch and turn
    d.readings = d.readings.filter((r) => !(r.batchId === a.batchId && r.fieldKey === a.fieldKey && r.turn === a.turn));
    d.readings.push({ ...a, recordedAt: new Date().toISOString() });
  },
  setTurns(d, a) {
    const batch = d.batches.find((b) => b.id === a.batchId);
    if (batch) batch.turns = a.turns;
  },
  editAddition(d, a) {
    const addition = d.additions.find((x) => x.id === a.id);
    if (addition) Object.assign(addition, a);
  },
};

// What the screen shows: the database's data with the waiting changes on top
function withWaitingChanges(base) {
  const d = structuredClone(base);
  // (an offline copy saved by an older version may not have these yet)
  d.cellar ??= [];
  d.additions ??= [];
  d.readings ??= [];
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

// Keep a change in the waiting list and send it shortly. Used where values are typed quickly one
// after another (the brew-day sheet): each is kept on the phone first, then all are sent in order,
// so none is dropped while an earlier one is still being saved.
let sendSoonTimer = null;
function queueChange(kind, args, label) {
  outbox.push({ id: newId(), kind, args, label, madeAt: new Date().toISOString() });
  storeList(OUTBOX_KEY, outbox);
  data = withWaitingChanges(serverData);
  render();
  if (offline || !navigator.onLine) { showOffline(); return; }
  updateBanner();
  clearTimeout(sendSoonTimer);
  sendSoonTimer = setTimeout(() => refresh().catch((e) => { if (isConnectionProblem(e)) showOffline(); }), 400);
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
  applyPermissions();
  renderSettings();
  renderSheetPicker();
  renderTeam();
  renderTankList();
  if (viewingBatchId) renderBatchView();

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
  const isAdmin = can("manage_cleaning"); // (name kept short: "may change the acid rules")
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
    const hint = tank.status === "empty"
      ? (can("start_batch") ? "Tap to start a batch" : "")
      : (can("tank_status") ? "Tap to update status" : "");
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
    (can("manage_beers") ? `<option value="${NEW_BEER}">+ New beer…</option>` : "");
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
  document.getElementById("delete-batch").hidden = !batch || !can("delete_records");
  document.getElementById("open-tank-settings").hidden = !tankId;
  lockBatchForm(batch);

  batchForm.batchId.value = b.batchNumber;
  fillBeerDropdown(b.beerId);
  batchForm.brewDate.value = b.brewDate;
  fillUnitInput(batchForm.sizeBbl, "volume", b.sizeBbl);
  if (b.tankId) batchForm.tankId.value = b.tankId;
  batchForm.stage.value = b.stage;
  batchForm.stageStartDate.value = b.stageStartDate;
  batchDialog.showModal();
}

// Only the parts of the batch form this person may change are editable:
//   details (number, beer, brew date, size) -> start_batch; stage, tank, date -> move_beer; "Packaged" -> package
function lockBatchForm(batch) {
  const details = !batch || can("start_batch");
  const moves = can("move_beer") || can("package");
  for (const name of ["batchId", "beerId", "brewDate", "sizeBbl"]) batchForm[name].disabled = !details;
  for (const name of ["tankId", "stage", "stageStartDate"]) batchForm[name].disabled = !moves;
  for (const option of batchForm.stage.options) {
    option.disabled = option.value === "packaged" ? !can("package") : (!can("move_beer") && option.value !== batchForm.stage.value);
  }
  batchForm.querySelector("button[type=submit]").hidden = !details && !moves;
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
  document.getElementById("delete-tank").hidden = !tank || !(can("manage_equipment") && can("delete_records"));

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
  lockTankForm();
  tankDialog.showModal();
}

// Only the parts of the tank form this person may change are editable:
//   name, type, capacity, location -> manage_equipment; status -> tank_status; acid rule -> manage_cleaning
function lockTankForm() {
  const equipment = can("manage_equipment");
  for (const name of ["name", "type", "capacityBbl", "locationId"]) tankForm[name].disabled = !equipment;
  tankForm.status.disabled = !can("tank_status");
  tankForm.acidEveryTurns.disabled = !can("manage_cleaning");
  document.getElementById("log-acid").hidden = !can("acid_log");
  tankForm.querySelectorAll("[data-remove-acid]").forEach((b) => { b.hidden = !can("acid_log"); });
  tankForm.querySelector("button[type=submit]").hidden =
    !(equipment || can("tank_status") || can("manage_cleaning"));
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
      <button type="button" class="btn small" data-remove-acid="${c.id}" ${can("acid_log") ? "" : "hidden"}>Remove</button>
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

  document.getElementById("beer-title").textContent = beer ? `${can("manage_beers") ? "Edit " : ""}${beer.name}` : "Add beer";
  document.getElementById("delete-beer").hidden = !beer || !(can("manage_beers") && can("delete_records"));
  for (const el of beerForm.querySelectorAll("input")) el.disabled = !can("manage_beers");
  beerForm.querySelector("button[type=submit]").hidden = !can("manage_beers");

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

function fillBrewhouse(location) {
  const l = location || {};
  fillUnitInput(locationForm.turnSize, "volume", l.turnSizeBbl ?? null);
  locationForm.usualTurns.value = l.usualTurns ?? 1;
  fillUnitInput(locationForm.kettleFull, "volume", l.kettleFullBbl ?? null);
  locationForm.flowTarget.value = l.flowTarget ?? "";
  locationForm.waterGrist.value = l.waterGristQtLb ?? "";
  locationForm.absorption.value = l.absorptionGalLb ?? "";
  for (const el of locationForm.querySelectorAll("fieldset input")) el.disabled = !can("manage_equipment");
}

function openLocationEditor(location) {
  editingLocation = location;
  document.getElementById("location-title").textContent = location ? `Edit ${location.name}` : "Add location";
  document.getElementById("delete-location").hidden = !location || !(can("manage_equipment") && can("delete_records"));
  locationForm.name.disabled = !can("manage_equipment");
  locationForm.querySelector("button[type=submit]").hidden = !can("manage_equipment");
  locationForm.name.value = location ? location.name : "";
  fillBrewhouse(location);
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
  const fields = {
    name,
    turn_size_bbl: readUnitInput(locationForm.turnSize, "volume"),
    usual_turns: Number(locationForm.usualTurns.value) || 1,
    kettle_full_bbl: readUnitInput(locationForm.kettleFull, "volume"),
    flow_target: locationForm.flowTarget.value.trim(),
    water_grist_qt_lb: locationForm.waterGrist.value ? Number(locationForm.waterGrist.value) : null,
    grain_absorption_gal_lb: locationForm.absorption.value ? Number(locationForm.absorption.value) : null,
  };
  const ok = await save(() => editingLocation
    ? must(db.from("locations").update(fields).eq("id", editingLocation.id))
    : must(db.from("locations").insert({ id: newLocationId, brewery_id: brewery.id, ...fields })));
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
      if (d.acidAfterStyles.length && can("manage_cleaning")) {
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
    // Same brewery as before? Keep what we already know (permissions, units) while it reloads,
    // so nothing flickers hidden in between.
    const known = brewery?.id === m.breweries.id ? brewery : {};
    brewery = { ...known, id: m.breweries.id, name: m.breweries.name, role: m.role };
    showBrewerySwitch(memberships);
    await refresh();
    showScreen("app-screen");
    openFromLink(); // opened from a printed sheet's QR code
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

// ----- Permissions -----
// Each person has a LEVEL; each level is a set of permissions the brewery's admins can change,
// and admins can adjust any one person on top of their level. Admins can always do everything.
// The database enforces all of this (supabase/migrations/..._permissions.sql); the app uses the
// same rules only to show and hide buttons. Keep this list in step with permission_list() there.
const PERMISSIONS = [
  { id: "cellar_log",       label: "Log readings and cellar work" },
  { id: "tank_status",      label: "Set a tank's status (cleaning, maintenance)" },
  { id: "acid_log",         label: "Log acid cycles" },
  { id: "move_beer",        label: "Change stages and transfer beer" },
  { id: "package",          label: "Package beer" },
  { id: "start_batch",      label: "Start batches and edit batch details" },
  { id: "manage_beers",     label: "Beers and recipes" },
  { id: "manage_equipment", label: "Tanks and locations" },
  { id: "manage_cleaning",  label: "Acid rules" },
  { id: "manage_settings",  label: "Units, time zone, targets, and brew sheet fields" },
  { id: "rename_brewery",   label: "Rename the brewery" },
  { id: "backups",          label: "Download and load backups" },
  { id: "delete_records",   label: "Delete batches, beers, tanks, and locations" },
];
const ROLES = [
  { id: "viewer",      label: "Viewer",      short: "View" },
  { id: "cellar",      label: "Cellar",      short: "Cellar" },
  { id: "brewer",      label: "Brewer",      short: "Brewer" },
  { id: "head_brewer", label: "Head brewer", short: "Head" },
  { id: "admin",       label: "Admin",       short: "Admin" },
];
// What each level includes until a brewery changes it (same as default_permissions() in the database)
const DEFAULT_LEVELS = {
  viewer: [],
  cellar: ["cellar_log", "tank_status", "acid_log", "move_beer", "package"],
  brewer: ["cellar_log", "tank_status", "acid_log", "move_beer", "package", "start_batch"],
  head_brewer: ["cellar_log", "tank_status", "acid_log", "move_beer", "package", "start_batch",
                "manage_beers", "manage_equipment", "manage_cleaning", "manage_settings"],
};

// Can the signed-in person do this here?
function can(permission) {
  return brewery?.role === "admin" || (brewery?.permissions || []).includes(permission);
}

// What a level includes in this brewery (its own version, or the default)
function levelPermissions(level) {
  if (level === "admin") return PERMISSIONS.map((p) => p.id);
  return (data.levels || {})[level] || DEFAULT_LEVELS[level] || [];
}

// A member's effective permissions: their level, plus what was added for them, minus what was removed
function memberPermissions(member) {
  if (member.role === "admin") return PERMISSIONS.map((p) => p.id);
  const base = new Set(levelPermissions(member.role));
  member.grants.forEach((g) => base.add(g));
  member.revokes.forEach((r) => base.delete(r));
  return [...base];
}

// Buttons marked data-needs="permission" are only shown to people with that permission
function applyPermissions() {
  document.querySelectorAll("[data-needs]").forEach((el) => { el.hidden = !can(el.dataset.needs); });
}

// ----- Settings screen -----
const SETTINGS_PAGES = ["brewery", "equipment", "beers", "cleaning", "team", "backup", "account"];
let settingsPage = "brewery";

// Three views: the tank board ("floor"), one batch's page, and Settings
let currentView = "floor";
function showView(view) {
  currentView = view;
  document.getElementById("floor-view").hidden = view !== "floor";
  document.getElementById("batch-view").hidden = view !== "batch";
  document.getElementById("settings-view").hidden = view !== "settings";
  document.getElementById("open-settings").hidden = view === "settings";
  document.getElementById("close-settings").hidden = view === "floor";
  document.getElementById("view-title").textContent = { settings: "Settings", batch: "Batch" }[view] || "Tanks";
  if (view !== "batch") viewingBatchId = null;
  window.scrollTo(0, 0);
}

function showSettings(open, page = settingsPage) {
  showView(open ? "settings" : "floor");
  if (open) {
    settingsPage = page;
    document.querySelectorAll("#settings-nav button").forEach((b) => {
      b.toggleAttribute("aria-current", b.dataset.page === page);
      if (b.dataset.page === page) b.setAttribute("aria-current", "page");
    });
    document.querySelectorAll(".settings-page").forEach((p) => { p.hidden = p.dataset.page !== page; });
  }
}
document.getElementById("open-settings").addEventListener("click", () => showSettings(true));
document.getElementById("close-settings").addEventListener("click", () => showSettings(false));
document.getElementById("settings-nav").addEventListener("click", (e) => {
  const button = e.target.closest("[data-page]");
  if (button) showSettings(true, button.dataset.page);
});

// ----- Brew sheet: which fields this brewery measures -----
// Ticks are kept here while someone is choosing (so a background refresh doesn't undo them),
// and saved together with "Save".
let pickerChoice = null; // a Set of field keys while choosing; null = show what's saved

function fieldMeta(f) {
  const unit = UNIT_TYPES.includes(f.type) ? UNIT_INFO[f.type][prefs()[`${f.type}Unit`]].label
    : f.type === "meter" ? "meter start and end" : f.type === "ph" ? "pH" : f.unit || f.type;
  return [unit, f.hint].filter(Boolean).join(" · ");
}

function renderSheetPicker() {
  const allowed = can("manage_settings");
  const choice = pickerChoice ?? chosenFields();
  document.getElementById("sheet-field-count").textContent =
    `${CATALOG_FIELDS.filter((f) => choice.has(f.key)).length} of ${CATALOG_FIELDS.length} fields chosen`;
  document.getElementById("sheet-field-picker").innerHTML = SHEET_CATALOG.map((section) => `
    <fieldset class="picker-section">
      <legend>${section.title} <span class="muted">· ${section.perTurn ? "each turn" : "whole batch"}</span></legend>
      ${allowed ? `<div class="picker-all"><button type="button" class="link" data-pick-section="${section.title}" data-pick="all">All</button>
        <button type="button" class="link" data-pick-section="${section.title}" data-pick="none">None</button></div>` : ""}
      ${section.fields.map((f) => `<label class="pick">
        <input type="checkbox" data-pick-field="${f.key}" ${choice.has(f.key) ? "checked" : ""} ${allowed ? "" : "disabled"}>
        <span>${f.label} <span class="muted">${esc(fieldMeta(f))}</span></span></label>`).join("")}
    </fieldset>`).join("");
  document.getElementById("sheet-fields-actions").hidden = !allowed;
  document.getElementById("sheet-fields-note").hidden = allowed;
  document.getElementById("save-sheet-fields").disabled = !pickerChoice;
}

document.getElementById("sheet-field-picker").addEventListener("change", (e) => {
  const box = e.target.closest("[data-pick-field]");
  if (!box) return;
  pickerChoice ??= new Set(chosenFields());
  if (box.checked) pickerChoice.add(box.dataset.pickField); else pickerChoice.delete(box.dataset.pickField);
  renderSheetPicker();
});
document.getElementById("sheet-field-picker").addEventListener("click", (e) => {
  const button = e.target.closest("[data-pick-section]");
  if (!button) return;
  pickerChoice ??= new Set(chosenFields());
  const section = SHEET_CATALOG.find((s) => s.title === button.dataset.pickSection);
  for (const f of section.fields) {
    if (button.dataset.pick === "all") pickerChoice.add(f.key); else pickerChoice.delete(f.key);
  }
  renderSheetPicker();
});
document.getElementById("pick-usual").addEventListener("click", () => { pickerChoice = new Set(USUAL_FIELDS); renderSheetPicker(); });
document.getElementById("pick-everything").addEventListener("click", () => {
  pickerChoice = new Set(CATALOG_FIELDS.map((f) => f.key));
  renderSheetPicker();
});
document.getElementById("save-sheet-fields").addEventListener("click", async () => {
  if (!pickerChoice) return;
  // Saved in catalog (paper) order
  const keys = CATALOG_FIELDS.map((f) => f.key).filter((k) => pickerChoice.has(k));
  const ok = await save(async () => {
    const saved = await must(db.from("breweries").update({ sheet_fields: keys }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("You don't have permission to choose the brew sheet's fields.");
  });
  if (ok) pickerChoice = null;
  renderSheetPicker();
});

// ----- Brewery: name, units, and time zone -----
const settingsForm = document.getElementById("settings-form");
const breweryNameForm = document.getElementById("brewery-name-form");

// Every time zone the browser knows, for the dropdown (filled once)
const TIME_ZONES = (Intl.supportedValuesOf?.("timeZone") || [DEFAULT_PREFS.timeZone]);
settingsForm.timeZone.innerHTML = TIME_ZONES.map((z) => `<option value="${z}">${z.replace(/_/g, " ")}</option>`).join("");

// "Far from target" limits, shown in the brewery's units. Stored in standard units (see
// supabase/migrations/..._target_limits.sql); a blank box means "don't flag that kind of reading".
// Differences convert without the offsets units have: 1 °C apart = 1.8 °F apart, and
// 0.004 SG apart is about 1 °P (or 1 °Bx) apart.
const LIMIT_KINDS = [
  { key: "gravity", unit: () => ({ sg: "SG", plato: "°P", brix: "°Bx" })[prefs().gravityUnit],
    toShown: (v) => (prefs().gravityUnit === "sg" ? v : v * 250), fromShown: (v) => (prefs().gravityUnit === "sg" ? v : v / 250) },
  { key: "temperature", unit: () => `°${prefs().temperatureUnit}`,
    toShown: (v) => (prefs().temperatureUnit === "F" ? v * 1.8 : v), fromShown: (v) => (prefs().temperatureUnit === "F" ? v / 1.8 : v) },
  { key: "ph", unit: () => "pH", toShown: (v) => v, fromShown: (v) => v },
  { key: "amount", unit: () => "%", toShown: (v) => v * 100, fromShown: (v) => v / 100 },
];
function limitShown(kind, stored) {
  return stored == null ? "" : String(+kind.toShown(stored).toFixed(prefs().gravityUnit === "sg" && kind.key === "gravity" ? 4 : 2));
}
function readLimits() {
  const limits = { ...prefs().targetLimits };
  for (const kind of LIMIT_KINDS) {
    const input = settingsForm[`limit_${kind.key}`];
    if (input.value === input.dataset.shown) continue; // unchanged: keep the exact stored value
    limits[kind.key] = input.value === "" ? null : Math.abs(kind.fromShown(Number(input.value)));
  }
  return limits;
}

function renderSettings() {
  const p = prefs();
  const allowed = can("manage_settings");
  settingsForm.temperatureUnit.value = p.temperatureUnit;
  settingsForm.gravityUnit.value = p.gravityUnit;
  settingsForm.volumeUnit.value = p.volumeUnit;
  if (!TIME_ZONES.includes(p.timeZone)) {
    settingsForm.timeZone.insertAdjacentHTML("afterbegin", `<option value="${esc(p.timeZone)}">${esc(p.timeZone)}</option>`);
  }
  settingsForm.timeZone.value = p.timeZone;
  for (const kind of LIMIT_KINDS) {
    const input = settingsForm[`limit_${kind.key}`];
    input.value = limitShown(kind, p.targetLimits[kind.key]);
    input.dataset.shown = input.value; // to tell later whether it was changed
    document.getElementById(`limit-unit-${kind.key}`).textContent = kind.unit();
  }
  for (const el of settingsForm.elements) el.disabled = !allowed;
  document.getElementById("save-settings").hidden = !allowed;
  document.getElementById("settings-admin-note").hidden = allowed;

  if (document.activeElement !== breweryNameForm.name) breweryNameForm.name.value = brewery.name;
  breweryNameForm.name.disabled = !can("rename_brewery");
  document.getElementById("backup-note").hidden = can("backups");
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await save(async () => {
    const saved = await must(db.from("breweries").update({
      temperature_unit: settingsForm.temperatureUnit.value,
      gravity_unit: settingsForm.gravityUnit.value,
      volume_unit: settingsForm.volumeUnit.value,
      time_zone: settingsForm.timeZone.value,
      target_limits: readLimits(),
    }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("You don't have permission to change these settings.");
  });
});

breweryNameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = breweryNameForm.name.value.trim();
  if (!name || name === brewery.name) return;
  const ok = await save(async () => {
    const saved = await must(db.from("breweries").update({ name }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("You don't have permission to rename the brewery.");
  });
  if (ok) await start(); // the name shows in several places; reload them all
});

// ----- Equipment: every tank, for editing -----
function renderTankList() {
  document.getElementById("tank-list").innerHTML = data.tanks.map((t) => {
    const details = [labelFrom(TANK_TYPES, t.type), showUnit("volume", t.capacityBbl), locationName(t)].filter(Boolean).join(" · ");
    return `
    <li>
      <button class="row" data-tank-settings="${t.id}">
        <strong>${esc(t.name)}</strong>
        <span class="muted">${esc(details)}</span>
      </button>
    </li>`;
  }).join("") || `<li class="muted">No tanks yet.</li>`;
}
document.getElementById("tank-list").addEventListener("click", (e) => {
  const row = e.target.closest("[data-tank-settings]");
  if (row) openTankEditor(findTank(row.dataset.tankSettings));
});

// ----- Team: members, levels, and invites -----
function renderTeam() {
  const isAdmin = brewery.role === "admin";
  const members = data.members || [];
  const invites = data.invites || [];
  document.getElementById("member-list").innerHTML = members.map((m) => {
    const me = m.email === signedInEmail ? " (you)" : "";
    const adjusted = m.role !== "admin" && (m.grants.length || m.revokes.length) ? " · adjusted" : "";
    const level = `${labelFrom(ROLES, m.role)}${adjusted}`;
    return isAdmin
      ? `<li class="item"><button class="row" data-member="${m.userId}"><span class="who">${esc(m.email)}${me}</span><span class="muted">${level} ›</span></button></li>`
      : `<li class="item"><span class="who">${esc(m.email)}${me}</span><span class="muted">${level}</span></li>`;
  }).join("");

  document.getElementById("invite-area").hidden = !isAdmin;
  document.getElementById("invite-heading").hidden = !invites.length;
  document.getElementById("invite-list").innerHTML = invites.map((i) => `
    <li class="item">
      <span class="who">${esc(i.email)} <span class="muted">· ${labelFrom(ROLES, i.role)}</span></span>
      <button class="btn small" data-cancel-invite="${i.id}">Cancel</button>
    </li>`).join("");

  // Levels table: a row per permission, a column per level (admin column always all ticked)
  const levelIds = ROLES.map((r) => r.id);
  document.getElementById("levels-table").innerHTML = `
    <thead><tr><th>Permission</th>${ROLES.map((r) => `<th title="${r.label}">${r.short}</th>`).join("")}</tr></thead>
    <tbody>${PERMISSIONS.map((p) => `
      <tr><td>${p.label}</td>${levelIds.map((l) => `
        <td><input type="checkbox" data-level="${l}" data-permission="${p.id}"
             aria-label="${p.label}: ${labelFrom(ROLES, l)}"
             ${levelPermissions(l).includes(p.id) ? "checked" : ""}
             ${!isAdmin || l === "admin" ? "disabled" : ""}></td>`).join("")}</tr>`).join("")}
    </tbody>`;
  document.getElementById("reset-levels").hidden = !isAdmin || !Object.keys(data.levels || {}).length;

  // My own level, on the account page
  const mine = members.find((m) => m.email === signedInEmail);
  document.getElementById("my-level").textContent = mine ? `Your level: ${labelFrom(ROLES, mine.role)}` : "";
}

function inviteMessage(text) {
  const el = document.getElementById("invite-message");
  el.textContent = text || "";
  el.hidden = !text;
}

const inviteForm = document.getElementById("invite-form");
inviteForm.role.innerHTML = ROLES.map((r) => `<option value="${r.id}" ${r.id === "cellar" ? "selected" : ""}>${r.label}</option>`).join("");
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

document.getElementById("team").addEventListener("click", async (e) => {
  const member = e.target.closest("[data-member]");
  const cancel = e.target.closest("[data-cancel-invite]");
  if (member) openMemberEditor(member.dataset.member);
  if (cancel) {
    const ok = await save(() => must(db.from("invites").delete().eq("id", cancel.dataset.cancelInvite)));
    if (ok) inviteMessage("");
  }
});

// Changing what a whole level includes (admins)
async function setLevel(level, permissions) {
  const sorted = PERMISSIONS.map((p) => p.id).filter((p) => permissions.includes(p));
  return save(() => must(db.from("role_levels").upsert({ brewery_id: brewery.id, level, permissions: sorted })));
}
document.getElementById("levels-table").addEventListener("change", async (e) => {
  const box = e.target.closest("[data-level]");
  if (!box) return;
  const { level, permission } = box.dataset;
  const current = levelPermissions(level).filter((p) => p !== permission);
  await setLevel(level, box.checked ? [...current, permission] : current);
});
document.getElementById("reset-levels").addEventListener("click", async () => {
  if (!confirm("Put every level back to what it includes by default? People's individual adjustments stay.")) return;
  await save(() => must(db.from("role_levels").delete().eq("brewery_id", brewery.id)));
});

// ----- One person's level and permissions (admins) -----
const memberDialog = document.getElementById("member-editor");
const memberForm = document.getElementById("member-form");
const scopeDialog = document.getElementById("scope-editor");
let editingMemberId = null;
memberForm.role.innerHTML = ROLES.map((r) => `<option value="${r.id}">${r.label}</option>`).join("");

function editingMember() {
  return data.members.find((m) => m.userId === editingMemberId);
}

function openMemberEditor(userId) {
  editingMemberId = userId;
  fillMemberEditor();
  memberDialog.showModal();
}

function fillMemberEditor() {
  const m = editingMember();
  if (!m) { memberDialog.close(); return; }
  const isMe = m.email === signedInEmail;
  document.getElementById("member-title").textContent = `${m.email}${isMe ? " (you)" : ""}`;
  memberForm.role.value = m.role;
  document.getElementById("member-note").textContent = m.role === "admin"
    ? "Admins can always do everything, including managing the team."
    : "Their permissions (✓ = can do it). Changing one asks whether it's just for this person or for everyone at their level.";
  const effective = memberPermissions(m);
  const fromLevel = levelPermissions(m.role);
  document.getElementById("member-permissions").innerHTML = PERMISSIONS.map((p) => {
    let tag = "";
    if (m.role !== "admin" && m.grants.includes(p.id)) tag = `<span class="tag added">added for them</span>`;
    else if (m.role !== "admin" && m.revokes.includes(p.id)) tag = `<span class="tag removed">removed for them</span>`;
    else if (fromLevel.includes(p.id)) tag = `<span class="tag">from level</span>`;
    return `<li class="item"><label>
      <input type="checkbox" data-member-permission="${p.id}" ${effective.includes(p.id) ? "checked" : ""} ${m.role === "admin" ? "disabled" : ""}>
      <span>${p.label}</span></label>${tag}</li>`;
  }).join("");
  document.getElementById("reset-member").hidden = m.role === "admin" || (!m.grants.length && !m.revokes.length);
  document.getElementById("remove-member").textContent = isMe ? "Leave this brewery" : "Remove from brewery";
}

// Ask: just this person, or everyone at their level? Resolves to "person", "level", or "cancel".
function askScope(member, permission, on) {
  const what = PERMISSIONS.find((p) => p.id === permission).label.toLowerCase();
  const level = labelFrom(ROLES, member.role);
  const name = member.email.split("@")[0];
  document.getElementById("scope-title").textContent = `${on ? "Allow" : "Stop"}: ${what}`;
  document.getElementById("scope-text").textContent =
    `Change this just for ${name}, or for everyone at the ${level} level (now and anyone added later)?`;
  document.getElementById("scope-person").textContent = `Just ${name}`;
  document.getElementById("scope-level").textContent = `Everyone at ${level}`;
  return new Promise((resolve) => {
    scopeDialog.addEventListener("close", () => resolve(scopeDialog.returnValue || "cancel"), { once: true });
    scopeDialog.returnValue = "";
    scopeDialog.showModal();
  });
}

document.getElementById("member-permissions").addEventListener("change", async (e) => {
  const box = e.target.closest("[data-member-permission]");
  if (!box) return;
  const m = editingMember();
  const permission = box.dataset.memberPermission;
  const on = box.checked;
  const scope = await askScope(m, permission, on);
  if (scope === "cancel") { box.checked = !on; return; }

  if (scope === "level") {
    const current = levelPermissions(m.role).filter((p) => p !== permission);
    await setLevel(m.role, on ? [...current, permission] : current);
  } else {
    // Just this person: add or remove an adjustment (dropping one that undid the level)
    const inLevel = levelPermissions(m.role).includes(permission);
    let grants = m.grants.filter((g) => g !== permission);
    let revokes = m.revokes.filter((r) => r !== permission);
    if (on && !inLevel) grants.push(permission);
    if (!on && inLevel) revokes.push(permission);
    await save(() => must(db.from("memberships").update({ grants, revokes })
      .eq("brewery_id", brewery.id).eq("user_id", m.userId)));
  }
  if (m.email === signedInEmail) await start(); // your own permissions changed
  fillMemberEditor();
});

memberForm.role.addEventListener("change", async () => {
  const m = editingMember();
  const role = memberForm.role.value;
  if (m.email === signedInEmail && role !== "admin" &&
      !confirm(`Change your own level to ${labelFrom(ROLES, role)}? You'll no longer be able to manage the team.`)) {
    memberForm.role.value = m.role;
    return;
  }
  const ok = await save(() => must(db.from("memberships").update({ role })
    .eq("brewery_id", brewery.id).eq("user_id", m.userId)));
  if (ok && m.email === signedInEmail) await start(); // your own level changed: reload what you can do
  fillMemberEditor();
});

document.getElementById("reset-member").addEventListener("click", async () => {
  const m = editingMember();
  await save(() => must(db.from("memberships").update({ grants: [], revokes: [] })
    .eq("brewery_id", brewery.id).eq("user_id", m.userId)));
  if (m.email === signedInEmail) await start();
  fillMemberEditor();
});

document.getElementById("remove-member").addEventListener("click", async () => {
  const m = editingMember();
  const yourself = m.email === signedInEmail;
  if (!confirm(yourself ? `Leave ${brewery.name}? You'll lose access to it.` : `Remove ${m.email} from ${brewery.name}?`)) return;
  const ok = await save(() => must(db.from("memberships").delete()
    .eq("brewery_id", brewery.id).eq("user_id", m.userId)));
  if (!ok) return;
  memberDialog.close();
  if (yourself) await start();
});

// ----- The batch page: cellar log, additions, history -----
// Cellar action items. Some also move the batch to a stage (offered as a checkbox when logging).
const CELLAR_ACTIONS = [
  { id: "Check" },
  { id: "Tank sample" },
  { id: "Dry hop", stage: "dry-hopping" },
  { id: "Rouse" },
  { id: "Crash", stage: "conditioning" },
  { id: "Harvest" },
  { id: "Drain" },
  { id: "Spund" },
  { id: "Carbonate", stage: "carbonating" },
  { id: "Ready", stage: "ready" },
  { id: "Other" },
];

let viewingBatchId = null;

function openBatchView(batchId) {
  viewingBatchId = batchId;
  document.getElementById("bv-brewday").hidden = true;
  document.getElementById("bv-main").hidden = false;
  showView("batch");
  viewingBatchId = batchId; // (showView clears it when leaving the page)
  renderBatchView();
}

function viewingBatch() {
  return data.batches.find((b) => b.id === viewingBatchId);
}

// "Oct 5"; readings as "°P 4.2 · pH 4.5 · 64.0 °F"
function readingsText(gravitySg, ph, tempC) {
  return [
    gravitySg != null ? showUnit("gravity", gravitySg) : "",
    ph != null ? `pH ${ph}` : "",
    tempC != null ? showUnit("temperature", tempC) : "",
  ].filter(Boolean).join(" · ");
}

function renderBatchView() {
  const b = viewingBatch();
  if (!b) { showView("floor"); return; }
  const tank = findTank(b.tankId);
  const days = daysSince(b.stageStartDate);

  document.getElementById("bv-title").textContent = `${beerName(b)} ${b.batchNumber ? "#" + b.batchNumber : ""}`;
  const badge = document.getElementById("bv-stage");
  badge.textContent = stageLabel(b.stage);
  badge.style.setProperty("--stage-color", `var(--${b.stage})`);
  document.getElementById("bv-meta").textContent = [
    isInTank(b) && tank ? `${tank.name}${locationName(tank) ? " · " + locationName(tank) : ""}` : "Packaged",
    `${days} ${days === 1 ? "day" : "days"} in ${stageLabel(b.stage).toLowerCase()}`,
    b.sizeBbl ? showUnit("volume", b.sizeBbl) : "",
    `brewed ${formatDate(b.brewDate)}`,
  ].filter(Boolean).join(" · ");
  const inTank = isInTank(b);
  document.getElementById("bv-log").hidden = !can("cellar_log") || !inTank;
  document.getElementById("bv-add").hidden = !can("cellar_log") || !inTank;

  // Cellar log, newest first
  const canLog = can("cellar_log");
  const entries = data.cellar.filter((c) => c.batchId === b.id)
    .sort((x, y) => y.occurredOn.localeCompare(x.occurredOn) || (y.recordedAt || "").localeCompare(x.recordedAt || ""));
  document.getElementById("bv-cellar").innerHTML = entries.map((c) => `
    <li class="item"><button class="entry ${canLog ? "" : "static"}" data-cellar="${c.id}">
      <span class="when">${formatDate(c.occurredOn)}${c.action ? " · " + esc(c.action) : ""}</span>
      ${c.edited ? `<span class="tag">edited</span>` : ""}
      <div class="readings">${esc(readingsText(c.gravitySg, c.ph, c.tempC))}</div>
      ${c.cellarChange ? `<div>${esc(c.cellarChange)}</div>` : ""}
      ${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ""}
    </button></li>`).join("") || `<li class="item muted">Nothing logged yet.</li>`;

  // Additions, newest first
  const adds = data.additions.filter((a) => a.batchId === b.id)
    .sort((x, y) => y.addedOn.localeCompare(x.addedOn) || (y.recordedAt || "").localeCompare(x.recordedAt || ""));
  document.getElementById("bv-additions").innerHTML = adds.map((a) => `
    <li class="item"><button class="entry ${canLog ? "" : "static"}" data-addition="${a.id}">
      <span class="when">${formatDate(a.addedOn)} · ${esc(a.name)}</span>
      <div class="readings">${[a.amount != null ? `${a.amount} ${a.unit}` : "", a.timing, a.lot ? "lot " + a.lot : ""].filter(Boolean).map(esc).join(" · ")}</div>
      ${a.notes ? `<div class="muted">${esc(a.notes)}</div>` : ""}
    </button></li>`).join("") || `<li class="item muted">No additions yet.</li>`;

  renderSheet();

  // History: stage changes and transfers, oldest first
  const history = data.events.filter((e) => e.batchId === b.id);
  document.getElementById("bv-history").innerHTML = history.map((e) => `
    <li class="item"><span class="when">${formatDate(e.effectiveDate)}</span> · ${stageLabel(e.stage)}${e.tankId ? " in " + esc(tankName(e.tankId)) : ""}</li>`).join("");
}

document.getElementById("bv-edit").addEventListener("click", () => {
  const b = viewingBatch();
  if (b) openBatchEditor(b, isInTank(b) ? b.tankId : null);
});

// ----- The brew-day sheet -----
// Every field a brewery might measure on brew day, in paper order (so typing in a filled-in sheet
// goes top to bottom). Each brewery picks the ones it measures (Settings → Brew sheet); fields
// marked `usual` are picked to start with. Readings are stored under each field's key, so keys
// never change once a brewery may have used them. A field this brewery no longer uses still shows
// on any batch that has a value for it: nothing recorded is ever hidden.
//
// Field types decide how a value is typed, stored, and shown:
//   temperature, gravity, volume  -> typed in the brewery's units, stored in standard units
//   ph, number                    -> stored as typed (number fields can name a unit, e.g. "gal/min")
//   meter                         -> a flow meter's start and end readings (gallons); stores the difference
//   time                          -> a time of day ("07:05")
//   text                          -> words (initials, names, notes)
//
// Targets come from the catalog (fixed), the location's brewhouse, the beer, or the water math.
// A target is { min, max } in standard units (one or both), or { text } when it's just a note.
const F_TO_C = (f) => (f - 32) * 5 / 9;
const exactly = (v) => ({ min: v, max: v });
const ogTarget = (c) => (c.beer?.targetOg ? exactly(c.beer.targetOg) : null);
const range = (min, max) => () => ({ min, max });

// field(key, label, type, extras): extras can hold unit, target, usual (picked to start), hint
const field = (key, label, type, extras = {}) => ({ key, label, type, ...extras });
const SHEET_CATALOG = [
  { title: "Brew day", perTurn: false, column: 1, fields: [
    field("brewers", "Brewer(s)", "text", { usual: true }),
    field("assistant_brewers", "Assistant brewer(s)", "text"),
    field("recipe_version", "Recipe version", "text"),
    field("grain_lot", "Malt lot(s)", "text", { hint: "for traceability" }),
    field("water_source", "Water source / filter", "text"),
  ]},
  { title: "Water treatment", perTurn: true, column: 1, fields: [
    field("mash_gypsum", "Gypsum in mash", "number", { unit: "g" }),
    field("mash_calcium_chloride", "Calcium chloride in mash", "number", { unit: "g" }),
    field("mash_epsom", "Epsom salt in mash", "number", { unit: "g" }),
    field("mash_table_salt", "Table salt in mash", "number", { unit: "g" }),
    field("mash_chalk", "Chalk / baking soda in mash", "number", { unit: "g" }),
    field("mash_lactic_acid", "Lactic acid in mash", "number", { unit: "mL" }),
    field("mash_phosphoric_acid", "Phosphoric acid in mash", "number", { unit: "mL" }),
    field("sparge_acid", "Acid in sparge water", "number", { unit: "mL" }),
    field("sparge_water_ph", "Sparge water pH", "ph"),
    field("kettle_salts", "Kettle salts", "text"),
  ]},
  { title: "Mash", perTurn: true, column: 1, fields: [
    field("grist_weight", "Grist weight", "number", { unit: "lb", usual: true }),
    field("rice_hulls", "Rice hulls", "number", { unit: "lb" }),
    field("hlt_temp", "HLT temp", "temperature"),
    field("mash_water_volume", "Mash water", "meter", { usual: true, target: (c) => (c.water ? exactly(c.water.mashGal / 31) : null) }),
    field("mash_strike_temp", "Strike temp", "temperature", { usual: true }),
    field("mash_temp", "Mash temp", "temperature", { usual: true }),
    field("mash_ph", "Mash pH", "ph", { usual: true, target: range(5.2, 5.6) }),
    field("mash_step_2_temp", "Step 2 temp", "temperature"),
    field("mash_step_3_temp", "Step 3 temp", "temperature"),
    field("mash_out_temp", "Mash out temp", "temperature"),
    field("mash_enzymes", "Enzymes / mash additions", "text"),
  ]},
  { title: "Lauter & runoff", perTurn: true, column: 1, fields: [
    field("vorlauf_start_temp", "Vorlauf start temp", "temperature", { usual: true }),
    field("vorlauf_end_temp", "Vorlauf end temp", "temperature", { usual: true }),
    field("flow_rate", "Flow rate", "number", { unit: "gal/min", usual: true,
      target: (c) => (c.location?.flowTarget ? { text: c.location.flowTarget } : null) }),
    field("sparge_temp", "Sparge temp", "temperature", { usual: true, target: () => exactly(F_TO_C(168)) }),
    field("sparge_water_volume", "Sparge water", "meter", { target: (c) => (c.water?.spargeGal ? exactly(c.water.spargeGal / 31) : null) }),
    field("end_sparge_temp", "End of sparge temp", "temperature", { usual: true }),
    field("end_sparge_volume", "End of sparge volume", "meter", { usual: true, target: (c) => (c.water?.totalGal ? exactly(c.water.totalGal / 31) : null) }),
    field("grain_bed_depth", "Grain bed depth", "number", { unit: "in" }),
    field("lauter_pressure", "Lauter differential pressure", "number", { unit: "psi" }),
    field("lauter_rakes", "Rake height / cuts", "text"),
    field("kettle_full_volume", "Kettle full volume", "volume", { usual: true,
      target: (c) => (c.location?.kettleFullBbl ? exactly(c.location.kettleFullBbl) : null) }),
  ]},
  { title: "Boil & whirlpool", perTurn: true, column: 1, fields: [
    field("boil_length", "Boil length", "number", { unit: "min" }),
    field("post_boil_volume", "Post-boil volume", "volume", { usual: true }),
    field("kettle_finings", "Kettle finings / nutrient", "text"),
    field("whirlpool_temp", "Whirlpool / hop stand temp", "temperature"),
    field("whirlpool_rest", "Whirlpool rest", "number", { unit: "min" }),
    field("kettle_loss", "Left in kettle (trub)", "volume"),
  ]},
  { title: "Gravity", perTurn: true, column: 1, fields: [
    field("first_runnings_gravity", "First runnings", "gravity", { usual: true }),
    field("final_runnings_gravity", "Final runnings", "gravity", { usual: true }),
    field("kettle_full_gravity", "Kettle full (pre-boil)", "gravity", { usual: true }),
    field("post_boil_gravity", "Post-boil", "gravity"),
    field("ko_gravity", "Knockout", "gravity", { usual: true, target: ogTarget }),
    field("tank_sample_gravity", "Tank sample", "gravity", { usual: true, target: ogTarget }),
  ]},
  { title: "pH", perTurn: true, column: 1, fields: [
    field("first_runnings_ph", "First runnings", "ph", { usual: true, target: range(5.2, 5.4) }),
    field("final_runnings_ph", "Final runnings", "ph", { usual: true }),
    field("kettle_full_ph", "Kettle full", "ph", { usual: true, target: range(5.2, 5.3) }),
    field("post_boil_ph", "Post-boil", "ph"),
    field("ko_ph", "Knockout", "ph", { usual: true, target: range(4.8, 4.9) }),
    field("tank_sample_ph", "Tank sample", "ph", { usual: true }),
  ]},
  { title: "Knockout", perTurn: true, column: 2, fields: [
    field("ko_temp", "Knockout temp (into tank)", "temperature", { usual: true }),
    field("turn_ko_volume", "Volume this turn", "volume"),
    field("cooling_water_temp", "Cooling water temp", "temperature"),
    field("ko_oxygen_rate", "Oxygen this turn", "number", { unit: "L/min" }),
  ]},
  { title: "Fermenter & yeast", perTurn: false, column: 2, fields: [
    field("ko_volume", "Total knockout volume", "volume", { usual: true }),
    field("oxygen_rate", "Oxygen", "number", { unit: "L/min", usual: true, target: () => exactly(3) }),
    field("dissolved_oxygen", "Dissolved oxygen", "number", { unit: "ppm" }),
    field("ferm_set_temp", "Fermentation set temp", "temperature"),
    field("yeast_strain", "Yeast strain", "text", { usual: true }),
    field("yeast_source", "Yeast source (tank / brink / lot)", "text", { usual: true }),
    field("yeast_generation", "Generation", "text", { usual: true }),
    field("yeast_amount", "Yeast amount", "text", { usual: true }),
    field("yeast_viability", "Viability", "number", { unit: "%" }),
    field("yeast_cell_count", "Cell count", "number", { unit: "million/mL" }),
    field("pitch_rate", "Pitch rate", "number", { unit: "million cells/mL/°P" }),
    field("pitch_temp", "Pitch temp", "temperature"),
    field("yeast_nutrient", "Yeast nutrient", "text"),
    field("fermenter_additions", "Fermenter additions (enzymes, finings)", "text"),
  ]},
  { title: "Time log", perTurn: true, column: 2, fields: [
    ["mash_start", "Mash start", true], ["mash_end", "Mash end", true], ["vorlauf_start", "Vorlauf start", true],
    ["vorlauf_end", "Vorlauf end", true], ["runoff_start", "Runoff start", true], ["first_wort", "First wort", true],
    ["sparge_start", "Sparge start", true], ["sparge_end", "Sparge end", true], ["runoff_end", "Runoff end", true],
    ["boil_start", "Boil start", true], ["boil_end", "Boil end", true], ["whirlpool_start", "Whirlpool start", true],
    ["whirlpool_end", "Whirlpool end", true], ["ko_start", "Knockout start", true], ["ko_end", "Knockout end", true],
    ["mash_in_end", "Mash in end"], ["rest_start", "Rest start"], ["mash_out", "Mash out"],
    ["hop_stand_start", "Hop stand start"], ["hop_stand_end", "Hop stand end"],
  ].map(([key, label, usual]) => field(key, label, "time", { usual: !!usual })) },
  { title: "Cleaning sign-offs", perTurn: false, column: 2, hint: "initials", fields: [
    field("signoff_mash_tun", "Mash tun cleaned", "text"),
    field("signoff_kettle", "Kettle cleaned", "text"),
    field("signoff_heat_exchanger", "Heat exchanger cleaned / sanitized", "text"),
    field("signoff_wort_line", "Wort line sanitized", "text"),
    field("signoff_oxygen_stone", "Oxygen stone sanitized", "text"),
    field("signoff_fermenter", "Fermenter CIP'd / sanitized", "text"),
  ]},
  { title: "Notes", perTurn: false, column: 2, fields: [
    field("brew_notes", "Brew-day notes", "text", { usual: true }),
    field("deviations", "Problems / changes from plan", "text"),
    field("wort_sensory", "Wort taste / smell", "text"),
  ]},
];
const CATALOG_FIELDS = SHEET_CATALOG.flatMap((section) => section.fields);
const USUAL_FIELDS = CATALOG_FIELDS.filter((f) => f.usual).map((f) => f.key);
const UNIT_TYPES = ["temperature", "gravity", "volume"];

// The fields this brewery measures (null = the usual set)
function chosenFields() {
  return new Set(brewery?.sheetFields ?? USUAL_FIELDS);
}

// The sheet for one batch: the brewery's fields, plus any other field this batch has a value for
function sheetFor(batch) {
  const chosen = chosenFields();
  const recorded = new Set(data.readings.filter((r) => r.batchId === batch.id).map((r) => r.fieldKey));
  return SHEET_CATALOG
    .map((section) => ({ ...section, fields: section.fields.filter((f) => chosen.has(f.key) || recorded.has(f.key)) }))
    .filter((section) => section.fields.length);
}

// Which of the brewery's "far from target" limits applies to each kind of field (Settings → Brewery)
const LIMIT_FOR = { gravity: "gravity", temperature: "temperature", ph: "ph", volume: "amount", meter: "amount", number: "amount" };

let sheetTurn = 1;

// The current value of a field for a batch (and turn; null for whole-batch fields)
function reading(batchId, fieldKey, turn) {
  return data.readings.find((r) => r.batchId === batchId && r.fieldKey === fieldKey && (r.turn ?? null) === (turn ?? null));
}

// Where the batch was brewed: the location of the first tank in its history
function brewLocation(batch) {
  const first = data.events
    .filter((e) => e.batchId === batch.id && e.tankId)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
  return findLocation(findTank(first?.tankId ?? batch.tankId)?.locationId);
}

// Water volumes for one turn (gallons), from its grist weight and the location's brewhouse:
//   mash water  = grist (lb) x water-to-grist (qt/lb) / 4
//   total water = kettle full (bbl) x 31 + grist (lb) x grain absorption (gal/lb)
//   sparge      = total - mash
function waterFor(batch, turn) {
  const location = brewLocation(batch);
  const grist = reading(batch.id, "grist_weight", turn)?.value;
  if (!location || !grist || !location.waterGristQtLb) return null;
  const mashGal = grist * location.waterGristQtLb / 4;
  const totalGal = location.kettleFullBbl ? location.kettleFullBbl * 31 + grist * (location.absorptionGalLb || 0) : null;
  return { mashGal, totalGal, spargeGal: totalGal ? totalGal - mashGal : null };
}

function sheetContext(batch, turn) {
  return { batch, beer: findBeer(batch.beerId), location: brewLocation(batch), water: waterFor(batch, turn) };
}

// "target 168.0 °F", "target 5.2–5.4", "target 20-22"
function targetText(field, target) {
  if (!target) return "";
  if (target.text) return `target ${target.text}`;
  const show = (v) => {
    if (field.type === "meter") return `${Math.round(v * 31)} gal`;
    if (UNIT_TYPES.includes(field.type)) return showUnit(field.type, v);
    return `${+v.toFixed(2)}${field.unit ? " " + field.unit : ""}`;
  };
  if (target.min != null && target.max != null) return `target ${target.min === target.max ? show(target.min) : `${show(target.min)}–${show(target.max)}`}`;
  return target.min != null ? `target ${show(target.min)} or more` : `target up to ${show(target.max)}`;
}

function isOffTarget(field, target, value) {
  if (!target || target.text || value == null) return false;
  const limit = prefs().targetLimits?.[LIMIT_FOR[field.type]];
  if (limit == null) return false; // the brewery turned this flag off
  // Amounts (volumes and the like) allow a share of the target; readings a fixed difference
  const slack = (v) => (LIMIT_FOR[field.type] === "amount" ? Math.abs(v) * limit : limit);
  return (target.min != null && value < target.min - slack(target.min)) ||
         (target.max != null && value > target.max + slack(target.max));
}

function renderSheet() {
  const b = viewingBatch();
  const sheet = document.getElementById("sheet");
  if (!b || document.getElementById("bv-brewday").hidden) return;
  // Don't redraw under someone's fingers: while they're typing in the sheet, leave it alone
  // (what they typed is already in the boxes, and is saved when they leave each box)
  if (sheet.contains(document.activeElement)) return;

  const editable = can("start_batch");
  sheetTurn = Math.min(sheetTurn, b.turns);
  const turnCount = document.getElementById("turn-count");
  turnCount.value = String(b.turns);
  turnCount.disabled = !editable;
  const tabs = document.getElementById("turn-tabs");
  tabs.hidden = b.turns < 2;
  tabs.innerHTML = Array.from({ length: b.turns }, (_, i) => i + 1).map((t) =>
    `<button type="button" role="tab" aria-selected="${t === sheetTurn}" data-turn="${t}">Turn ${t}</button>`).join("");
  document.getElementById("sheet-note").textContent = editable
    ? "Each value saves as soon as you leave its box (also with no signal). Values far from their target are highlighted."
    : "Your permission level can see the sheet but not fill it in.";

  sheet.innerHTML = sheetFor(b).map((section) => {
    const turn = section.perTurn ? sheetTurn : null;
    const c = sheetContext(b, turn);
    const per = section.perTurn ? (b.turns > 1 ? `turn ${sheetTurn}` : "") : (b.turns > 1 ? "whole batch" : "");
    const water = section.fields.some((f) => f.key === "mash_water_volume") && c.water
      ? `<p class="muted water">Water for this turn: mash ${Math.round(c.water.mashGal)} gal${c.water.totalGal
          ? ` · sparge ${Math.round(c.water.spargeGal)} gal · total ${Math.round(c.water.totalGal)} gal` : ""} (from the grist weight and the brewhouse settings)</p>`
      : "";
    const notes = [per, section.hint].filter(Boolean).join(" · ");
    return `<div class="sheet-section"><h3>${section.title}${notes ? ` <span class="per">· ${notes}</span>` : ""}</h3>
      ${section.fields.map((f) => fieldHtml(f, b, turn, c, editable)).join("")}${water}</div>`;
  }).join("");
  // Boxes in the brewery's units
  sheet.querySelectorAll("input[data-unit]").forEach((input) => {
    const turn = input.dataset.turn ? Number(input.dataset.turn) : null;
    fillUnitInput(input, input.dataset.unit, reading(b.id, input.dataset.field, turn)?.value ?? null);
  });
  applyUnitLabels();
}

function fieldHtml(f, b, turn, c, editable) {
  const r = reading(b.id, f.key, turn);
  const target = f.target ? f.target(c) : null;
  const off = isOffTarget(f, target, r?.value);
  const attrs = `data-field="${f.key}"${turn ? ` data-turn="${turn}"` : ""}${editable ? "" : " disabled"}`;
  const numberBox = (extra) => `<input type="number" step="any" inputmode="decimal" ${extra} ${attrs}>`;
  let input;
  if (f.type === "meter") {
    input = `<span class="meter">
      ${numberBox(`placeholder="start" aria-label="${f.label}: meter start" data-part="start" value="${r?.raw?.start ?? ""}"`)}
      ${numberBox(`placeholder="end" aria-label="${f.label}: meter end" data-part="end" value="${r?.raw?.end ?? ""}"`)}</span>`;
  } else if (f.type === "time" || f.type === "text") {
    input = `<input type="${f.type}" aria-label="${f.label}" value="${esc(r?.valueText ?? "")}" ${attrs}>`;
  } else if (UNIT_TYPES.includes(f.type)) {
    input = numberBox(`aria-label="${f.label}" data-unit="${f.type}"`);
  } else {
    input = numberBox(`aria-label="${f.label}" value="${r?.value ?? ""}"`);
  }
  const unit = f.unit ? ` (${f.unit})` : UNIT_TYPES.includes(f.type) ? ` (<span class="${f.type}-unit"></span>)` : f.type === "meter" ? " (meter, gal)" : "";
  return `<div class="field${off ? " off-target" : ""}">
    <div><div class="name">${f.label}${unit}</div><div class="target">${targetText(f, target)}</div></div>
    ${input}${f.type === "meter" && r?.value != null ? `<div class="result">= ${Math.round(r.value * 31)} gal</div>` : ""}${off ? `<div class="off">Far from target. Typo?</div>` : ""}
  </div>`;
}

// Save a value as soon as its box is left. It goes into the "waiting to send" list first, so it's
// kept on the phone with no signal, and nothing is lost when several are typed quickly.
document.getElementById("sheet").addEventListener("change", (e) => {
  const input = e.target.closest("[data-field]");
  const b = viewingBatch();
  if (!input || !b || !can("start_batch")) return;
  const key = input.dataset.field;
  const turn = input.dataset.turn ? Number(input.dataset.turn) : null;
  const field = CATALOG_FIELDS.find((f) => f.key === key);
  const row = input.closest(".field");
  const current = reading(b.id, key, turn);
  let value = null, valueText = null, raw = null;

  if (field.type === "meter") {
    const start = row.querySelector('[data-part="start"]').value, end = row.querySelector('[data-part="end"]').value;
    if (start === "" || end === "") return; // wait for both readings
    if (Number(end) < Number(start)) { alert(`${field.label}: the end reading is lower than the start reading.`); return; }
    if (current?.raw?.start === Number(start) && current?.raw?.end === Number(end)) return;
    raw = { start: Number(start), end: Number(end), unit: "gal" };
    value = (raw.end - raw.start) / 31; // gallons -> barrels
    row.querySelector(".result")?.remove();
    row.querySelector(".meter").insertAdjacentHTML("afterend", `<div class="result">= ${Math.round(raw.end - raw.start)} gal</div>`);
  } else if (field.type === "time" || field.type === "text") {
    valueText = input.value.trim();
    if (valueText === (current?.valueText ?? "")) return;
  } else if (input.dataset.unit) {
    value = readUnitInput(input, input.dataset.unit);
    if (value == null || (current && Math.abs(current.value - value) < 1e-9)) return;
  } else {
    if (input.value === "") return;
    value = Number(input.value);
    if (current?.value === value) return;
  }

  // Show "far from target" right away (the sheet isn't redrawn while someone is typing in it)
  const target = field.target ? field.target(sheetContext(b, turn)) : null;
  const off = isOffTarget(field, target, value);
  row.classList.toggle("off-target", off);
  row.querySelector(".off")?.remove();
  if (off) row.insertAdjacentHTML("beforeend", `<div class="off">Far from target. Typo?</div>`);
  row.classList.add("saved");
  setTimeout(() => row.classList.remove("saved"), 1200);

  queueChange("saveReading", { id: newId(), breweryId: brewery.id, batchId: b.id, turn, fieldKey: key, value, valueText, raw },
    `${beerName(b)} ${batchLabel(b)}: ${field.label}${turn && b.turns > 1 ? ` (turn ${turn})` : ""}`);
});

// Leaving the sheet altogether (a tap outside it): redraw, so water targets etc. catch up
document.getElementById("sheet").addEventListener("focusout", () => {
  setTimeout(() => { if (!document.getElementById("sheet").contains(document.activeElement)) renderSheet(); }, 0);
});

document.getElementById("turn-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-turn]");
  if (!tab) return;
  sheetTurn = Number(tab.dataset.turn);
  renderSheet();
});

document.getElementById("turn-count").addEventListener("change", (e) => {
  const b = viewingBatch();
  queueChange("setTurns", { batchId: b.id, turns: Number(e.target.value) }, `${beerName(b)} ${batchLabel(b)}: number of turns`);
});

function showSheet(open) {
  document.getElementById("bv-brewday").hidden = !open;
  document.getElementById("bv-main").hidden = open;
  if (open) { sheetTurn = 1; renderSheet(); }
  window.scrollTo(0, 0);
}
document.getElementById("bv-sheet").addEventListener("click", () => showSheet(true));
document.getElementById("bv-sheet-back").addEventListener("click", () => showSheet(false));

// ----- The printed brew-day sheet -----
// For filling in by hand on the brew deck: the same fields in the same order, a box per turn,
// targets alongside, and a QR code that opens this batch in the app for typing the numbers in later.
// Values already entered are printed in their boxes, so a sheet can be reprinted mid-brew.
function printTarget(field, b) {
  const loc = brewLocation(b);
  if (field.key === "mash_water_volume" && loc?.waterGristQtLb) return `grist × ${loc.waterGristQtLb} ÷ 4 gal`;
  if (field.key === "sparge_water_volume" && loc?.waterGristQtLb && loc.kettleFullBbl) return "total − mash water";
  if (field.key === "end_sparge_volume" && loc?.waterGristQtLb && loc.kettleFullBbl) {
    return `${loc.kettleFullBbl} × 31 + grist × ${loc.absorptionGalLb || 0} gal`;
  }
  const target = field.target ? field.target(sheetContext(b, 1)) : null;
  return targetText(field, target).replace(/^target /, "");
}

// What's already recorded, as it would be written on paper
function printedValue(field, b, turn, part) {
  const r = reading(b.id, field.key, turn);
  if (!r) return "";
  if (field.type === "meter") return String(r.raw?.[part] ?? "");
  if (field.type === "time" || field.type === "text") return esc(r.valueText ?? "");
  if (UNIT_TYPES.includes(field.type)) return showUnit(field.type, r.value).replace(/ \S+$/, ""); // the number only
  return String(r.value);
}

function printUnit(field) {
  if (field.unit) return ` (${field.unit})`;
  if (UNIT_TYPES.includes(field.type)) return ` (${UNIT_INFO[field.type][prefs()[`${field.type}Unit`]].label})`;
  return "";
}

function printSection(section, b) {
  const turns = section.perTurn ? Array.from({ length: b.turns }, (_, i) => i + 1) : [null];
  const hasTargets = section.fields.some((f) => printTarget(f, b));
  const head = `<tr><th>${section.title}</th>${hasTargets ? `<th class="target">Target</th>` : ""}${turns.map((t) =>
    `<th class="box">${t ? (b.turns > 1 ? `Turn ${t}` : "") : ""}</th>`).join("")}</tr>`;
  const rows = section.fields.flatMap((f) => {
    const parts = f.type === "meter" ? [["start", " meter start"], ["end", " meter end"]] : [[null, ""]];
    const size = f.key === "brew_notes" ? "notes" : f.type === "text" ? "tall" : "";
    return parts.map(([part, suffix], i) => `<tr class="${size}">
      <td>${i ? "&nbsp;&nbsp;↳" : f.label}${suffix}${i ? "" : printUnit(f)}${f.type === "meter" && !i ? " (gal)" : ""}</td>
      ${hasTargets ? `<td class="target">${i ? "" : esc(printTarget(f, b))}</td>` : ""}
      ${turns.map((t) => `<td class="box">${printedValue(f, b, t, part)}</td>`).join("")}
    </tr>`);
  });
  return `<table class="print-table${section.perTurn ? "" : " whole-batch"}">${head}${rows.join("")}</table>`;
}

function renderPrintSheet(b) {
  const beer = findBeer(b.beerId);
  const tank = findTank(b.tankId);
  const loc = brewLocation(b);
  const link = `${location.origin}${location.pathname}#batch=${b.id}`;
  const facts = [
    ["Beer", `${esc(beerName(b))}${beer?.style ? ` <span class="muted">(${esc(beer.style)})</span>` : ""}`],
    ["Batch", esc(batchLabel(b))],
    ["Brew date", esc(b.brewDate || "")],
    ["Tank", esc(tank?.name || "")],
    ["Location", esc(loc?.name || "")],
    ["Size", b.sizeBbl ? showUnit("volume", b.sizeBbl) : ""],
    ["Turns", String(b.turns)],
    ["Target OG / FG", beer?.targetOg ? `${showUnit("gravity", beer.targetOg)} / ${beer.targetFg ? showUnit("gravity", beer.targetFg) : "—"}` : ""],
  ];
  const sections = (column) => sheetFor(b).filter((s) => s.column === column).map((s) => printSection(s, b)).join("");
  const sheet = document.getElementById("print-sheet");
  sheet.className = b.turns > 2 ? "one-column" : "";
  sheet.innerHTML = `
    <header class="print-head">
      <div>
        <div class="muted">${esc(brewery.name)} · Brew-day sheet</div>
        <h1>${esc(beerName(b))} ${esc(batchLabel(b))}</h1>
        <dl>${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v || "&nbsp;"}</dd></div>`).join("")}</dl>
      </div>
      <div class="qr"><div id="print-qr"></div><div class="muted">Scan to type in the numbers</div></div>
    </header>
    <footer class="print-foot">${esc(beerName(b))} ${esc(batchLabel(b))} · ${esc(brewery.name)} brew-day sheet</footer>
    <div class="print-columns">
      <div>${sections(1)}</div>
      <div>${sections(2)}</div>
    </div>`;
  // The QR code (if the code library loaded; with no signal the link is printed instead)
  const qr = document.getElementById("print-qr");
  if (window.QRCode) new QRCode(qr, { text: link, width: 110, height: 110, correctLevel: QRCode.CorrectLevel.M });
  else qr.innerHTML = `<div class="link">${esc(link)}</div>`;
}

function printSheet() {
  const b = viewingBatch();
  if (!b) return;
  renderPrintSheet(b);
  // Give the QR code a moment to draw before the print dialog takes a snapshot
  setTimeout(() => window.print(), 150);
}
document.getElementById("bv-print").addEventListener("click", printSheet);
document.getElementById("bv-sheet-print").addEventListener("click", printSheet);

// ----- Opening a batch from a link (what the printed QR code points at) -----
// The link looks like  https://brew.chrisbohn.org/#batch=<id>  (signing in first if needed).
function openFromLink() {
  const id = new URLSearchParams(location.hash.slice(1)).get("batch");
  if (!id || document.getElementById("app-screen").hidden) return;
  history.replaceState(null, "", location.pathname + location.search); // so a reload doesn't reopen it
  if (data.batches.some((b) => b.id === id)) openBatchView(id);
  else alert("That batch isn't in this brewery. (If you're in more than one brewery, switch in Settings → Account.)");
}
window.addEventListener("hashchange", openFromLink);

// ----- Logging cellar work -----
const cellarDialog = document.getElementById("cellar-editor");
const cellarForm = document.getElementById("cellar-form");
let editingCellar = null; // the entry being corrected, or null for a new one
cellarForm.action.innerHTML = CELLAR_ACTIONS.map((a) => `<option value="${a.id}">${a.id}</option>`).join("");

// Offer "also move the batch to <stage>" when the action implies a stage it isn't in yet
function updateStageOffer() {
  const b = viewingBatch();
  const action = CELLAR_ACTIONS.find((a) => a.id === cellarForm.action.value);
  const offer = !editingCellar && b && action?.stage && b.stage !== action.stage && can("move_beer");
  document.getElementById("cellar-stage-field").hidden = !offer;
  if (offer) {
    document.getElementById("cellar-stage-text").textContent = `Also move the batch to ${stageLabel(action.stage)}`;
    cellarForm.changeStage.checked = true;
  }
}
cellarForm.action.addEventListener("change", updateStageOffer);

function openCellarEditor(entry) {
  editingCellar = entry;
  document.getElementById("cellar-title").textContent = entry ? "Cellar log entry" : "Log cellar work";
  cellarForm.occurredOn.value = entry?.occurredOn ?? today();
  cellarForm.action.value = entry?.action || "Check";
  fillUnitInput(cellarForm.gravity, "gravity", entry?.gravitySg ?? null);
  cellarForm.ph.value = entry?.ph ?? "";
  fillUnitInput(cellarForm.temp, "temperature", entry?.tempC ?? null);
  cellarForm.cellarChange.value = entry?.cellarChange ?? "";
  cellarForm.notes.value = entry?.notes ?? "";
  document.getElementById("delete-cellar").hidden = !entry;
  updateStageOffer();
  cellarDialog.showModal();
}
document.getElementById("bv-log").addEventListener("click", () => openCellarEditor(null));
document.getElementById("bv-cellar").addEventListener("click", (e) => {
  const row = e.target.closest("[data-cellar]");
  if (row && can("cellar_log")) openCellarEditor(data.cellar.find((c) => c.id === row.dataset.cellar));
});

cellarForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = viewingBatch();
  const fields = {
    occurredOn: cellarForm.occurredOn.value,
    action: cellarForm.action.value,
    gravitySg: readUnitInput(cellarForm.gravity, "gravity"),
    ph: cellarForm.ph.value === "" ? null : Number(cellarForm.ph.value),
    tempC: readUnitInput(cellarForm.temp, "temperature"),
    cellarChange: cellarForm.cellarChange.value.trim(),
    notes: cellarForm.notes.value.trim(),
  };
  const label = `${beerName(b)} #${b.batchNumber}: ${fields.action} on ${formatDate(fields.occurredOn)}`;
  let ok;
  if (editingCellar) {
    ok = await saveOrKeep("editCellar", { id: editingCellar.id, ...fields }, label);
  } else {
    const action = CELLAR_ACTIONS.find((a) => a.id === fields.action);
    const newStage = !document.getElementById("cellar-stage-field").hidden && cellarForm.changeStage.checked ? action.stage : null;
    ok = await saveOrKeep("logCellar", {
      p_id: newId(), p_brewery_id: brewery.id, p_batch_id: b.id, p_occurred_on: fields.occurredOn,
      p_action: fields.action, p_gravity_sg: fields.gravitySg, p_ph: fields.ph, p_temp_c: fields.tempC,
      p_cellar_change: fields.cellarChange, p_notes: fields.notes, p_new_stage: newStage,
    }, label);
  }
  if (ok) cellarDialog.close();
});

document.getElementById("delete-cellar").addEventListener("click", async () => {
  if (!confirm("Delete this cellar log entry?")) return;
  const ok = await save(() => must(db.from("cellar_entries").delete().eq("id", editingCellar.id)));
  if (ok) cellarDialog.close();
});

// ----- Additions -----
const additionDialog = document.getElementById("addition-editor");
const additionForm = document.getElementById("addition-form");
let editingAddition = null;

function openAdditionEditor(addition) {
  editingAddition = addition;
  document.getElementById("addition-title").textContent = addition ? "Addition" : "New addition";
  // Suggest names used before
  const names = [...new Set(data.additions.map((a) => a.name))].sort();
  document.getElementById("addition-names").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
  additionForm.addedOn.value = addition?.addedOn ?? today();
  additionForm.kind.value = addition?.kind ?? "hop";
  additionForm.name.value = addition?.name ?? "";
  additionForm.amount.value = addition?.amount ?? "";
  additionForm.unit.value = addition?.unit ?? "oz";
  additionForm.timing.value = addition?.timing ?? "";
  additionForm.lot.value = addition?.lot ?? "";
  additionForm.notes.value = addition?.notes ?? "";
  document.getElementById("delete-addition").hidden = !addition;
  additionDialog.showModal();
}
document.getElementById("bv-add").addEventListener("click", () => openAdditionEditor(null));
document.getElementById("bv-additions").addEventListener("click", (e) => {
  const row = e.target.closest("[data-addition]");
  if (row && can("cellar_log")) openAdditionEditor(data.additions.find((a) => a.id === row.dataset.addition));
});

additionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = viewingBatch();
  const fields = {
    addedOn: additionForm.addedOn.value, kind: additionForm.kind.value, name: additionForm.name.value.trim(),
    amount: additionForm.amount.value === "" ? null : Number(additionForm.amount.value), unit: additionForm.unit.value,
    timing: additionForm.timing.value.trim(), lot: additionForm.lot.value.trim(), notes: additionForm.notes.value.trim(),
  };
  const label = `${beerName(b)} #${b.batchNumber}: ${fields.name} on ${formatDate(fields.addedOn)}`;
  const ok = editingAddition
    ? await saveOrKeep("editAddition", { id: editingAddition.id, ...fields }, label)
    : await saveOrKeep("logAddition", { id: newId(), breweryId: brewery.id, batchId: b.id, ...fields }, label);
  if (ok) additionDialog.close();
});

document.getElementById("delete-addition").addEventListener("click", async () => {
  if (!confirm(`Delete this addition (${editingAddition.name})?`)) return;
  const ok = await save(() => must(db.from("batch_additions").delete().eq("id", editingAddition.id)));
  if (ok) additionDialog.close();
});

// ---------- 13. Wiring up taps and clicks ----------
// Tapping a tank card opens its batch (or a blank "new batch" form if it's empty)
// ...unless it's being cleaned or worked on, then it opens the tank so you can mark it ready
tanksArea.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const tank = findTank(card.dataset.tank);
  const batch = batchInTank(tank.id);
  if (batch) openBatchView(batch.id);                                 // the batch's page: cellar log, additions, history
  else if (tank.status === "empty" && can("start_batch")) openBatchEditor(null, tank.id);
  else openTankEditor(tank);                                          // status, acid log, settings (as permitted)
});

// Tapping a packaged batch opens it (to fix mistakes)
packagedList.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  openBatchView(row.dataset.batch);
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
document.getElementById("add-first-tank").addEventListener("click", () => openTankEditor(null));
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
