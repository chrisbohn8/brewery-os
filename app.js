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
  { id: "used",         label: "Used in another batch" }, // all of it went into a split or blend (also out of the tank)
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
  // Bring the alerts up to date first, so the list below is current (a gravity just logged clears
  // its alert right away). A failed check never stops the data loading; the server checks too.
  await db.rpc("check_alerts", { p_brewery_id: b }).then(() => {}, () => {});
  const [locations, beers, tanks, batches, events, cleanings, settings, members, invites, permissions, memberRows, levels, cellar, additions, readings, movements, packageTypes, packageCounts, places, stockMoves, pars, rawItems, rawReceipts, rawAdjustments, lines, inventoryViews, recipes, recipeIngredientRows, alertRules, alerts] = await Promise.all([
    must(db.from("locations").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("beers").select("*").eq("brewery_id", b)),
    must(db.from("tanks").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("batch_status").select("*").eq("brewery_id", b)),
    must(db.from("batch_events").select("*").eq("brewery_id", b).order("effective_date").order("recorded_at")),
    must(db.from("tank_cleanings").select("*").eq("brewery_id", b).order("cleaned_on").order("recorded_at")),
    must(db.from("breweries").select("acid_after_styles, temperature_unit, gravity_unit, volume_unit, time_zone, target_limits, sheet_fields, sheet_custom_fields, sheet_field_settings, stock_reasons, require_stock_reason, alert_quiet_start, alert_quiet_end").eq("id", b).single()),
    must(db.rpc("brewery_members", { p_brewery_id: b })),
    must(db.from("invites").select("*").eq("brewery_id", b).order("created_at")), // admins only; others get none
    must(db.rpc("my_permissions", { b })),
    must(db.from("memberships").select("user_id, role, grants, revokes").eq("brewery_id", b)),
    must(db.from("role_levels").select("level, permissions").eq("brewery_id", b)),
    must(db.from("cellar_entries").select("*").eq("brewery_id", b).order("occurred_on").order("recorded_at")),
    must(db.from("batch_additions").select("*").eq("brewery_id", b).order("added_on").order("recorded_at")),
    // (only each field's current value; history stays in the database)
    must(db.from("batch_readings_current").select("id, batch_id, turn, field_key, value, value_text, raw, recorded_at").eq("brewery_id", b)),
    must(db.from("beer_movements").select("*").eq("brewery_id", b).order("occurred_on").order("recorded_at")),
    must(db.from("package_types").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("package_counts").select("*").eq("brewery_id", b)),
    must(db.from("stock_places").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("stock_moves").select("*").eq("brewery_id", b).order("occurred_on").order("recorded_at")),
    must(db.from("stock_pars").select("*").eq("brewery_id", b)),
    must(db.from("raw_items").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("raw_receipts").select("*").eq("brewery_id", b).order("received_on").order("recorded_at")),
    must(db.from("raw_adjustments").select("*").eq("brewery_id", b).order("adjusted_on").order("recorded_at")),
    must(db.from("draft_lines").select("*").eq("brewery_id", b)),
    must(db.from("inventory_views").select("*").eq("brewery_id", b)),
    must(db.from("recipes").select("*").eq("brewery_id", b).order("created_at")),
    must(db.from("recipe_ingredients").select("*").eq("brewery_id", b)),
    must(db.from("alert_rules").select("*").eq("brewery_id", b)),
    must(db.from("alerts").select("*").eq("brewery_id", b).is("resolved_at", null).order("opened_at")),
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
      id: e.id, batchId: e.batch_id, effectiveDate: e.effective_date, stage: e.stage, tankId: e.tank_id, recordedAt: e.recorded_at,
    })),
    cleanings: cleanings.map((c) => ({ id: c.id, tankId: c.tank_id, cleanedOn: c.cleaned_on, note: c.note })),
    acidAfterStyles: settings.acid_after_styles,
    sheetFields: settings.sheet_fields,
    sheetCustomFields: settings.sheet_custom_fields,
    sheetFieldSettings: settings.sheet_field_settings,
    stockReasons: settings.stock_reasons || [], requireStockReason: !!settings.require_stock_reason,
    alertQuietStart: settings.alert_quiet_start, alertQuietEnd: settings.alert_quiet_end,
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
    movements: movements.map((m) => ({
      id: m.id, batchId: m.batch_id, occurredOn: m.occurred_on, kind: m.kind, fromTankId: m.from_tank_id,
      toTankId: m.to_tank_id, volumeBbl: num(m.volume_bbl), notes: m.notes, recordedAt: m.recorded_at,
      sourceBatchId: m.source_batch_id,
    })),
    rawItems: rawItems.map((i) => ({ id: i.id, name: i.name, kind: i.kind, unit: i.unit, packName: i.pack_name,
      packSize: num(i.pack_size), reorderLevel: num(i.reorder_level), active: i.active })),
    rawReceipts: rawReceipts.map((r) => ({ id: r.id, itemId: r.item_id, receivedOn: r.received_on, lot: r.lot, amount: num(r.amount),
      supplier: r.supplier, cost: num(r.cost), notes: r.notes, recordedAt: r.recorded_at })),
    rawAdjustments: rawAdjustments.map((a) => ({ id: a.id, itemId: a.item_id, lot: a.lot, adjustedOn: a.adjusted_on, change: num(a.change),
      reason: a.reason, recordedAt: a.recorded_at })),
    pars: pars.map((p) => ({ id: p.id, placeId: p.place_id, beerId: p.beer_id, parBbl: num(p.par_bbl), parCases: num(p.par_cases) })),
    places: places.map((p) => ({ id: p.id, locationId: p.location_id, name: p.name, kind: p.kind, active: p.active,
      sortMode: p.sort_mode, beerOrder: p.beer_order || [] })),
    alertRules: alertRules.map((r) => ({ kind: r.kind, enabled: r.enabled, params: r.params || {}, recipients: r.recipients || [] })),
    alerts: alerts.map(mapAlert),
    recipes: recipes.map((r) => ({ id: r.id, beerId: r.beer_id, locationId: r.location_id, name: r.name, batchSizeBbl: num(r.batch_size_bbl),
      targetOg: num(r.target_og), targetFg: num(r.target_fg), ibu: num(r.ibu), notes: r.notes, source: r.source })),
    recipeIngredients: recipeIngredientRows.map((i) => ({ id: i.id, recipeId: i.recipe_id, position: i.position, kind: i.kind, name: i.name,
      amount: num(i.amount), unit: i.unit, timing: i.timing })),
    views: inventoryViews.map((v) => ({ id: v.id, name: v.name, placeIds: v.place_ids || [], splitByPlace: v.split_by_place,
      typeIds: v.type_ids || [], show: v.show || [], beers: v.beers, sortMode: v.sort_mode, position: v.position })),
    lines: lines.map((l) => ({ id: l.id, placeId: l.place_id, lineNo: l.line_no, status: l.status, beerId: l.beer_id, label: l.label })),
    stockMoves: stockMoves.map((m) => ({
      id: m.id, groupId: m.group_id, occurredOn: m.occurred_on, kind: m.kind, removalKind: m.removal_kind, beerId: m.beer_id,
      batchId: m.batch_id, packageTypeId: m.package_type_id, count: num(m.count), fromPlaceId: m.from_place_id,
      toPlaceId: m.to_place_id, sourceMovementId: m.source_movement_id, account: m.account, notes: m.notes, recordedAt: m.recorded_at,
    })),
    packageTypes: packageTypes.map((t) => ({
      id: t.id, name: t.name, volumeBbl: num(t.volume_bbl), kind: t.kind, catalogKey: t.catalog_key, active: t.active,
    })),
    packageCounts: packageCounts.map((c) => ({
      id: c.id, movementId: c.movement_id, packageTypeId: c.package_type_id, count: num(c.count), unitVolumeBbl: num(c.unit_volume_bbl),
    })),
    additions: additions.map((a) => ({
      id: a.id, batchId: a.batch_id, addedOn: a.added_on, kind: a.kind, name: a.name,
      amount: num(a.amount), unit: a.unit, timing: a.timing, lot: a.lot, notes: a.notes, recordedAt: a.recorded_at,
      brewDay: a.brew_day, turn: a.turn,
    })),
    permissions,
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, emailedAt: i.emailed_at })),
  };
  data = withWaitingChanges(serverData);
  brewery.prefs = serverData.prefs;
  brewery.sheetFields = serverData.sheetFields;
  brewery.sheetCustomFields = serverData.sheetCustomFields;
  brewery.sheetFieldSettings = serverData.sheetFieldSettings;
  brewery.stockReasons = serverData.stockReasons;
  brewery.requireStockReason = serverData.requireStockReason;
  brewery.alertQuietStart = serverData.alertQuietStart;
  brewery.alertQuietEnd = serverData.alertQuietEnd;
  brewery.permissions = serverData.permissions;
  brewery.role = (serverData.members.find((m) => m.email === signedInEmail) || {}).role || brewery.role;
}

// A number from the database (which sends some numbers as text), or null
function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

// After any change: reload from the database and redraw, so the page always shows what's really saved.
// Each successful load also updates this device's offline copy.
let reloading = 0; // reloads in progress (the tests wait for 0: "everything on screen is current")
async function refresh() {
  reloading++;
  try {
    await sendWaitingChanges();
    await loadAll();
    render();
    saveOfflineCopy();
    showOnline();
  } finally {
    reloading--;
  }
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
  timing: a.timing, lot: a.lot, notes: a.notes, brew_day: !!a.brewDay, turn: a.turn ?? null,
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
  package: (a) => must(db.rpc("record_packaging", a)),
  levelCheck: (a) => must(db.rpc("record_level_check", a)),
  makeBatch: (a) => must(db.rpc("make_batch_from", a)),
  stock: (a) => must(db.rpc("record_stock", a)),
  receiveRaw: async (a) => {
    try {
      await must(db.from("raw_receipts").insert({ id: a.id, brewery_id: a.breweryId, item_id: a.itemId, received_on: a.receivedOn, lot: a.lot,
        amount: a.amount, supplier: a.supplier, cost: a.cost, notes: a.notes }));
    } catch (e) { if (e.code !== "23505") throw e; } // already there: sent before the connection dropped
  },
  adjustRaw: async (a) => {
    try {
      await must(db.from("raw_adjustments").insert({ id: a.id, brewery_id: a.breweryId, item_id: a.itemId, lot: a.lot, adjusted_on: a.adjustedOn,
        change: a.change, reason: a.reason }));
    } catch (e) { if (e.code !== "23505") throw e; }
  },
  count: (a) => must(db.rpc("record_count", a)),
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
    // Volumes, as the database records them (see save_batch in ..._beer_movements.sql)
    const moveDate = stageChanged ? a.p_stage_started_on : a.p_action_date;
    const move = (m) => d.movements.push({ id: `waiting-${a.p_id}-m${d.movements.length}`, batchId: a.p_id,
      occurredOn: moveDate, fromTankId: null, toTankId: null, volumeBbl: null, notes: "", ...m });
    const typed = a.p_volume_bbl ?? null;
    if (!before && inTank) {
      move({ kind: "knockout", toTankId: newTank, volumeBbl: typed, occurredOn: a.p_brew_date || moveDate });
    } else if (before?.tankId && before.stage !== "packaged" && (tankChanged || !inTank)) {
      let balance = tankBalance(a.p_id, before.tankId, d);
      const moved = typed ?? balance;
      if (moved != null && balance != null && moved > balance) {
        move({ kind: "correction", toTankId: before.tankId, volumeBbl: moved - balance, notes: "more moved out than was recorded" });
        balance = moved;
      }
      move({ kind: inTank ? "transfer" : "package", fromTankId: before.tankId, toTankId: newTank, volumeBbl: moved });
      if (balance != null && moved != null && balance > moved) {
        move({ kind: "loss", fromTankId: before.tankId, volumeBbl: balance - moved, notes: "left in the tank" });
      }
    } else if (before?.stage === "packaged" && inTank) {
      move({ kind: "correction", toTankId: newTank, volumeBbl: typed, notes: "back in a tank" });
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
  // A packaging run, as the database records it (see record_packaging in ..._packaging.sql)
  package(d, a) {
    const now = new Date().toISOString();
    const unit = (id) => d.packageTypes.find((t) => t.id === id)?.volumeBbl || 0;
    const total = a.p_counts.reduce((sum, c) => sum + c.count * unit(c.type), 0);
    const move = (m) => d.movements.push({ batchId: a.p_batch_id, occurredOn: a.p_occurred_on, fromTankId: null, toTankId: null,
      notes: "", recordedAt: now, ...m });
    move({ id: a.p_id, kind: "package", fromTankId: a.p_tank_id, volumeBbl: total, notes: a.p_notes || "" });
    a.p_counts.forEach((c, i) => d.packageCounts.push({ id: `${a.p_id}-${i}`, movementId: a.p_id, packageTypeId: c.type,
      count: c.count, unitVolumeBbl: unit(c.type) }));
    // ...and into stock
    const packagedBatch = d.batches.find((b) => b.id === a.p_batch_id);
    const place = a.p_place_id || defaultPlace(d.tanks.find((t) => t.id === a.p_tank_id)?.locationId, d);
    if (place && packagedBatch) a.p_counts.forEach((c, i) => d.stockMoves.push({ id: `${a.p_id}-s${i}`, groupId: null, occurredOn: a.p_occurred_on,
      kind: "packaged", removalKind: null, beerId: packagedBatch.beerId, batchId: a.p_batch_id, packageTypeId: c.type, count: c.count,
      fromPlaceId: null, toPlaceId: place, sourceMovementId: a.p_id, account: "", notes: "", recordedAt: now }));
    if (!a.p_spent) return;
    const left = tankBalance(a.p_batch_id, a.p_tank_id, d);
    if (left > 0) move({ id: `${a.p_id}-loss`, kind: "loss", fromTankId: a.p_tank_id, volumeBbl: left, notes: "tank spent" });
    if (left < 0) move({ id: `${a.p_id}-fix`, kind: "correction", toTankId: a.p_tank_id, volumeBbl: -left, notes: "more packaged than was recorded" });
    const batch = d.batches.find((b) => b.id === a.p_batch_id);
    if (batch) Object.assign(batch, { stage: "packaged", tankId: null, stageStartDate: a.p_occurred_on });
    d.events.push({ id: `waiting-${a.p_id}`, batchId: a.p_batch_id, stage: "packaged", tankId: null, effectiveDate: a.p_occurred_on, recordedAt: now });
    const tank = d.tanks.find((t) => t.id === a.p_tank_id);
    if (tank) tank.status = "cleaning";
  },
  // A level check, as the database records it (see record_level_check in ..._level_checks.sql)
  levelCheck(d, a) {
    const expected = tankBalance(a.p_batch_id, a.p_tank_id, d);
    const at = new Date().toISOString();
    const move = (m) => d.movements.push({ batchId: a.p_batch_id, occurredOn: a.p_occurred_on, fromTankId: null, toTankId: null,
      notes: "", recordedAt: at, ...m });
    if (expected != null && expected > a.p_reading_bbl) {
      move({ id: `${a.p_id}-diff`, kind: a.p_reason, fromTankId: a.p_tank_id, volumeBbl: expected - a.p_reading_bbl, notes: a.p_notes || "" });
    } else if (expected != null && expected < a.p_reading_bbl) {
      move({ id: `${a.p_id}-diff`, kind: "correction", toTankId: a.p_tank_id, volumeBbl: a.p_reading_bbl - expected, notes: "level check" });
    }
    move({ id: a.p_id, kind: "level", toTankId: a.p_tank_id, volumeBbl: a.p_reading_bbl, notes: a.p_notes || "", recordedAt: at + "~" });
  },
  receiveRaw(d, a) { if (!d.rawReceipts.some((r) => r.id === a.id)) d.rawReceipts.push({ ...a, recordedAt: new Date().toISOString() }); },
  adjustRaw(d, a) { if (!d.rawAdjustments.some((r) => r.id === a.id)) d.rawAdjustments.push({ ...a, recordedAt: new Date().toISOString() }); },
  // Moving, removing, or returning stock, as the database records it (record_stock)
  stock(d, a) {
    if (d.stockMoves.some((m) => m.groupId === a.p_id)) return;
    for (const l of a.p_lines) {
      if (!(l.count > 0)) continue;
      if (a.p_from) {
        takeStock(d, { group: a.p_id, date: a.p_date, kind: a.p_to ? "moved" : "removed", removal: a.p_to ? null : a.p_removal,
          beer: l.beer, batch: l.batch, type: l.type, count: l.count, from: a.p_from, to: a.p_to, account: a.p_account });
      } else {
        const newest = d.batches.filter((b) => b.beerId === l.beer).sort((x, y) => (y.brewDate || "").localeCompare(x.brewDate || ""))[0];
        d.stockMoves.push({ id: `${a.p_id}-${d.stockMoves.length}`, groupId: a.p_id, occurredOn: a.p_date, kind: "returned", removalKind: null,
          beerId: l.beer, batchId: l.batch || newest?.id || null, packageTypeId: l.type, count: l.count, fromPlaceId: null, toPlaceId: a.p_to,
          account: a.p_account || "", notes: "", recordedAt: new Date().toISOString() });
      }
    }
  },
  // A count sheet (record_count): less than expected is removed, oldest first; more is added to the newest batch
  count(d, a) {
    if (d.stockMoves.some((m) => m.groupId === a.p_id)) return;
    for (const l of a.p_lines) {
      const expected = sumCount(stockOnHand(d).filter((r) => r.placeId === a.p_place_id && r.beerId === l.beer && r.typeId === l.type));
      if (l.counted < expected) {
        takeStock(d, { group: a.p_id, date: a.p_date, kind: "removed", removal: a.p_drop || "unknown", beer: l.beer, type: l.type,
          count: expected - l.counted, from: a.p_place_id, notes: a.p_notes });
      } else if (l.counted > expected) {
        const newest = d.batches.filter((b) => b.beerId === l.beer).sort((x, y) => (y.brewDate || "").localeCompare(x.brewDate || ""))[0];
        d.stockMoves.push({ id: `${a.p_id}-${d.stockMoves.length}`, groupId: a.p_id, occurredOn: a.p_date, kind: "counted", removalKind: null,
          beerId: l.beer, batchId: newest?.id || null, packageTypeId: l.type, count: l.counted - expected, fromPlaceId: null,
          toPlaceId: a.p_place_id, account: "", notes: a.p_notes || "", recordedAt: new Date().toISOString() });
      }
    }
  },
  // A split or blend, as the database records it (see make_batch_from in ..._batches_from_batches.sql)
  makeBatch(d, a) {
    if (d.batches.some((b) => b.id === a.p_id)) return;
    const at = new Date().toISOString();
    const sources = a.p_sources.map((s) => d.batches.find((b) => b.id === s.batch)).filter(Boolean);
    const firstBrew = sources.map((b) => b.brewDate).filter(Boolean).sort()[0] || a.p_occurred_on;
    d.batches.push({ id: a.p_id, batchNumber: a.p_batch_number, beerId: a.p_beer_id, brewDate: firstBrew, sizeBbl: null, turns: 1,
      stage: a.p_stage, tankId: a.p_tank_id, stageStartDate: a.p_occurred_on });
    const move = (m) => d.movements.push({ id: `waiting-${a.p_id}-m${d.movements.length}`, occurredOn: a.p_occurred_on,
      fromTankId: null, toTankId: null, volumeBbl: null, notes: "", sourceBatchId: null, recordedAt: at + d.movements.length, ...m });
    const tank = (id) => d.tanks.find((t) => t.id === id);
    for (const s of a.p_sources) {
      const src = d.batches.find((b) => b.id === s.batch);
      if (!src) continue;
      const balance = tankBalance(src.id, src.tankId, d);
      const moved = s.volume ?? balance;
      move({ batchId: src.id, kind: "to_batch", fromTankId: src.tankId, volumeBbl: moved, sourceBatchId: a.p_id, notes: `into #${a.p_batch_number}` });
      move({ batchId: a.p_id, kind: "from_batch", toTankId: a.p_tank_id, volumeBbl: moved, sourceBatchId: src.id, notes: `from #${src.batchNumber}` });
      if (!s.used_up) continue;
      if (balance != null && moved != null && balance > moved) move({ batchId: src.id, kind: "loss", fromTankId: src.tankId, volumeBbl: balance - moved, notes: "left in the tank" });
      if (balance != null && moved != null && balance < moved) move({ batchId: src.id, kind: "correction", toTankId: src.tankId, volumeBbl: moved - balance, notes: "more moved out than was recorded" });
      d.events.push({ id: `waiting-${a.p_id}-${src.id}`, batchId: src.id, stage: "used", tankId: null, effectiveDate: a.p_occurred_on, recordedAt: at });
      if (src.tankId !== a.p_tank_id && tank(src.tankId)) tank(src.tankId).status = "cleaning";
      Object.assign(src, { stage: "used", tankId: null, stageStartDate: a.p_occurred_on });
    }
    d.events.push({ id: `waiting-${a.p_id}`, batchId: a.p_id, stage: a.p_stage, tankId: a.p_tank_id, effectiveDate: a.p_occurred_on, recordedAt: at + "~" });
    if (tank(a.p_tank_id)) tank(a.p_tank_id).status = "empty";
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
  d.movements ??= [];
  d.packageTypes ??= [];
  d.packageCounts ??= [];
  d.places ??= [];
  d.stockMoves ??= [];
  d.pars ??= [];
  d.rawItems ??= [];
  d.rawReceipts ??= [];
  d.rawAdjustments ??= [];
  d.lines ??= [];
  d.views ??= [];
  d.recipes ??= [];
  d.alertRules ??= [];
  d.alerts ??= [];
  d.recipeIngredients ??= [];
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
// ----- Volumes: worked out from the movement ledger (docs/moving-beer-design.md) -----
// How much of a batch is in a tank now, in barrels: its movements in the order they happened.
// A level check (the sight glass) resets the count to its reading; anything else adds or takes
// away. Null if a volume along the way wasn't recorded (and no level check came after it). A
// knockout with no volume counts as the brew sheet's knockout volume, or the batch size.
// (Mirrors tank_balance() in the database.)
function tankBalance(batchId, tankId, d = data) {
  const moves = (d.movements || [])
    .filter((m) => m.batchId === batchId && (m.toTankId === tankId || m.fromTankId === tankId))
    .sort((x, y) => x.occurredOn.localeCompare(y.occurredOn) || (x.recordedAt || "~").localeCompare(y.recordedAt || "~"));
  let total = 0;
  for (const m of moves) {
    if (m.kind === "level") { total = m.volumeBbl; continue; }
    if (total == null) continue;
    const v = m.volumeBbl ?? (m.kind === "knockout" ? knockoutVolume(batchId, d) : null);
    total = v == null ? null : total + (m.toTankId === tankId ? v : -v);
  }
  return total;
}
function knockoutVolume(batchId, d = data) {
  const ko = d.readings.find((r) => r.batchId === batchId && r.fieldKey === "ko_volume" && r.turn == null)?.value;
  return ko ?? d.batches.find((b) => b.id === batchId)?.sizeBbl ?? null;
}
// "29.5 bbl", or "volume not recorded"
function volumeText(v) {
  return v == null ? "volume not recorded" : showUnit("volume", v);
}

function isInTank(batch) {
  return batch.stage !== "packaged" && batch.stage !== "used";
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
  renderPackageTypes();
  renderPlaces();
  renderReasons();
  renderRecipes();
  renderAlerts();
  if (currentView === "inventory") renderInventory();
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
        <span class="muted">${stageLabel(b.stage)} ${formatDate(b.stageStartDate)}</span>
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
  const size = ` · ${volumeText(tankBalance(batch.id, tank.id))}`;
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
batchForm.stage.innerHTML = STAGES.filter((s) => s.id !== "used").map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

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
  batchForm.volume.value = "";
  updateVolumeField();
  batchDialog.showModal();
}

// "Volume moved": shown when beer leaves its tank (a transfer, or packaging). Empty = all of it.
// Below it, what that means for the tank it leaves: something left behind is recorded as loss.
function updateVolumeField() {
  const b = editingBatch;
  const leaving = b && isInTank(b) && b.tankId &&
    (batchForm.stage.value === "packaged" || batchForm.tankId.value !== b.tankId);
  document.getElementById("volume-field").hidden = !leaving;
  const note = document.getElementById("volume-note");
  note.hidden = !leaving;
  if (!leaving) return;
  const inTank = tankBalance(b.id, b.tankId);
  batchForm.volume.placeholder = inTank != null ? `all of it (${toShown("volume", inTank)})` : "all of it";
  const typed = batchForm.volume.value === "" ? null : fromShown("volume", batchForm.volume.value);
  const from = tankName(b.tankId);
  if (typed == null) note.textContent = inTank != null ? `Everything in ${from} (${showUnit("volume", inTank)}) moves.` : `Everything in ${from} moves.`;
  else if (inTank == null) note.textContent = `${showUnit("volume", typed)} moves out of ${from}.`;
  else if (typed < inTank) note.textContent = `${showUnit("volume", inTank - typed)} left in ${from} will be recorded as loss (yeast, trub, bottoms).`;
  else if (typed > inTank) note.textContent = `That's ${showUnit("volume", typed - inTank)} more than ${from} had on record; it'll be noted as a correction.`;
  else note.textContent = `Everything in ${from} moves.`;
}
batchForm.tankId.addEventListener("change", updateVolumeField);
batchForm.volume.addEventListener("input", updateVolumeField);

// Only the parts of the batch form this person may change are editable:
//   details (number, beer, brew date, size) -> start_batch; stage, tank, date -> move_beer; "Packaged" -> package
function lockBatchForm(batch) {
  const details = !batch || can("start_batch");
  const moves = can("move_beer") || can("package");
  for (const name of ["batchId", "beerId", "brewDate", "sizeBbl"]) batchForm[name].disabled = !details;
  for (const name of ["tankId", "stage", "stageStartDate", "volume"]) batchForm[name].disabled = !moves;
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
  updateVolumeField();
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
    // How much moved, when beer leaves its tank (empty = all of it)
    p_volume_bbl: !document.getElementById("volume-field").hidden && batchForm.volume.value !== ""
      ? fromShown("volume", batchForm.volume.value) : null,
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
        await must(db.from("locations").insert(d.locations.map((l) => ({
          id: idFor(l.id), brewery_id: b, name: l.name,
          // Brewhouse settings (backups made since they existed)
          turn_size_bbl: l.turnSizeBbl ?? null, usual_turns: l.usualTurns || 1, kettle_full_bbl: l.kettleFullBbl ?? null,
          flow_target: l.flowTarget || "", water_grist_qt_lb: l.waterGristQtLb ?? null, grain_absorption_gal_lb: l.absorptionGalLb ?? null,
        }))));
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
          brew_date: x.brewDate, size_bbl: x.sizeBbl, turns: x.turns || 1,
        }))));
        // History: newer backups include it. Older data only knows each batch's current
        // stage, so that becomes the batch's one history event.
        const events = d.events?.length
          ? d.events.map((e) => ({ batch: e.batchId, date: e.effectiveDate, stage: e.stage, tank: e.tankId, at: e.recordedAt }))
          : d.batches.map((x) => ({
              batch: x.id, date: x.stageStartDate, stage: x.stage, tank: x.stage === "packaged" ? null : x.tankId,
            }));
        await must(db.from("batch_events").insert(events.map((e) => ({
          brewery_id: b, batch_id: idFor(e.batch), effective_date: e.date, stage: e.stage, tank_id: idFor(e.tank),
          // Keep the original order of same-day changes (it decides which tank a batch is in now)
          ...(e.at && { recorded_at: e.at }),
        }))));

        // Volumes. Backups made before volumes existed: each batch in a tank was knocked out into it
        // (its volume then comes from the brew sheet or batch size), as when volumes were added.
        const movements = d.movements?.length
          ? d.movements.map((m) => ({
              id: idFor(m.id), batch_id: idFor(m.batchId), source_batch_id: idFor(m.sourceBatchId), occurred_on: m.occurredOn, kind: m.kind, from_tank_id: idFor(m.fromTankId),
              to_tank_id: idFor(m.toTankId), volume_bbl: m.volumeBbl ?? null, notes: m.notes || "",
              ...(m.recordedAt && { recorded_at: m.recordedAt }),
            }))
          : d.batches.filter((x) => x.stage !== "packaged" && x.tankId).map((x) => ({
              batch_id: idFor(x.id), occurred_on: x.brewDate || x.stageStartDate || today(), kind: "knockout",
              to_tank_id: idFor(x.tankId), notes: "recorded when volumes were added",
            }));
        if (movements.length) await must(db.from("beer_movements").insert(movements.map((m) => ({ brewery_id: b, ...m }))));

        // Stock places match the brewery's own by location and name (new locations already got a
        // storage place), then the stock ledger
        if (d.places?.length || d.stockMoves?.length) {
          const current = await must(db.from("stock_places").select("id, name, location_id").eq("brewery_id", b));
          for (const p of d.places || []) {
            const same = current.find((c) => c.name.toLowerCase() === p.name.toLowerCase() && (c.location_id ?? null) === (idFor(p.locationId) ?? null));
            if (same) ids.set(p.id, same.id);
            else await must(db.from("stock_places").insert({ id: idFor(p.id), brewery_id: b, location_id: idFor(p.locationId), name: p.name, kind: p.kind, active: p.active }));
            await must(db.from("stock_places").update({ sort_mode: p.sortMode || (p.kind === "taproom" ? "lines" : "az"),
              beer_order: (p.beerOrder || []).map(idFor) }).eq("id", idFor(p.id)));
          }
        }

        // Packaging: package types match the brewery's own by name (or are added), then each
        // packaging run's counts, with the volume per package they were packaged with
        if (d.packageCounts?.length || d.stockMoves?.length) {
          const current = await must(db.from("package_types").select("id, name").eq("brewery_id", b));
          for (const t of d.packageTypes || []) {
            const same = current.find((c) => c.name.toLowerCase() === t.name.toLowerCase());
            if (same) ids.set(t.id, same.id);
            else await must(db.from("package_types").insert({ id: idFor(t.id), brewery_id: b, name: t.name,
              volume_bbl: t.volumeBbl, kind: t.kind || "other", catalog_key: t.catalogKey ?? null, active: !!t.active }));
          }
          if (d.packageCounts?.length) await must(db.from("package_counts").insert(d.packageCounts.map((c) => ({
            brewery_id: b, movement_id: idFor(c.movementId), package_type_id: idFor(c.packageTypeId),
            count: c.count, unit_volume_bbl: c.unitVolumeBbl,
          }))));
        }
        // Raw materials: items match the brewery's own by name (or are added), then receipts and counts
        if (d.rawItems?.length) {
          const current = await must(db.from("raw_items").select("id, name").eq("brewery_id", b));
          for (const item of d.rawItems) {
            const same = current.find((c) => sameName(c.name, item.name));
            if (same) ids.set(item.id, same.id);
            else await must(db.from("raw_items").insert({ id: idFor(item.id), brewery_id: b, name: item.name, kind: item.kind, unit: item.unit,
              pack_name: item.packName || "", pack_size: item.packSize ?? null, reorder_level: item.reorderLevel ?? null, active: item.active }));
          }
          if (d.rawReceipts?.length) await must(db.from("raw_receipts").insert(d.rawReceipts.map((r) => ({ brewery_id: b, item_id: idFor(r.itemId),
            received_on: r.receivedOn, lot: r.lot || "", amount: r.amount, supplier: r.supplier || "", cost: r.cost ?? null, notes: r.notes || "",
            ...(r.recordedAt && { recorded_at: r.recordedAt }) }))));
          if (d.rawAdjustments?.length) await must(db.from("raw_adjustments").insert(d.rawAdjustments.map((a) => ({ brewery_id: b, item_id: idFor(a.itemId),
            lot: a.lot || "", adjusted_on: a.adjustedOn, change: a.change, reason: a.reason || "", ...(a.recordedAt && { recorded_at: a.recordedAt }) }))));
        }
        if (d.recipes?.length) {
          await must(db.from("recipes").insert(d.recipes.map((r) => ({ id: idFor(r.id), brewery_id: b, beer_id: idFor(r.beerId), location_id: idFor(r.locationId),
            name: r.name, batch_size_bbl: r.batchSizeBbl, target_og: r.targetOg, target_fg: r.targetFg, ibu: r.ibu, notes: r.notes || "", source: r.source || "" }))));
          if (d.recipeIngredients?.length) await must(db.from("recipe_ingredients").insert(d.recipeIngredients.map((i) => ({ brewery_id: b,
            recipe_id: idFor(i.recipeId), position: i.position, kind: i.kind, name: i.name, amount: i.amount, unit: i.unit, timing: i.timing || "" }))));
        }
        if (d.views?.length) {
          await must(db.from("inventory_views").insert(d.views.map((v) => ({ brewery_id: b, name: v.name, place_ids: v.placeIds.map(idFor),
            split_by_place: v.splitByPlace, type_ids: v.typeIds.map(idFor), show: v.show, beers: v.beers, sort_mode: v.sortMode, position: v.position }))));
        }
        if (d.lines?.length) {
          await must(db.from("draft_lines").insert(d.lines.map((l) => ({ brewery_id: b, place_id: idFor(l.placeId), line_no: l.lineNo,
            status: l.status, beer_id: idFor(l.beerId), label: l.label || "" }))));
        }
        if (d.pars?.length) {
          await must(db.from("stock_pars").insert(d.pars.map((p) => ({
            brewery_id: b, place_id: idFor(p.placeId), beer_id: idFor(p.beerId), par_bbl: p.parBbl ?? null, par_cases: p.parCases ?? null,
          }))));
        }
        if (d.stockMoves?.length) {
          await must(db.from("stock_moves").insert(d.stockMoves.map((m) => ({
            brewery_id: b, group_id: m.groupId ? idFor(m.groupId) : null, occurred_on: m.occurredOn, kind: m.kind, removal_kind: m.removalKind,
            beer_id: idFor(m.beerId), batch_id: idFor(m.batchId), package_type_id: idFor(m.packageTypeId), count: m.count,
            from_place_id: idFor(m.fromPlaceId), to_place_id: idFor(m.toPlaceId), source_movement_id: idFor(m.sourceMovementId),
            account: m.account || "", notes: m.notes || "", ...(m.recordedAt && { recorded_at: m.recordedAt }),
          }))));
        }

        // The brew log (backups made since it existed): cellar log, ingredients and additions,
        // and each brew-day field's current value
        if (d.cellar?.length) {
          await must(db.from("cellar_entries").insert(d.cellar.map((c) => ({
            brewery_id: b, batch_id: idFor(c.batchId), occurred_on: c.occurredOn, action: c.action || "",
            gravity_sg: c.gravitySg ?? null, ph: c.ph ?? null, temp_c: c.tempC ?? null,
            cellar_change: c.cellarChange || "", notes: c.notes || "",
            ...(c.recordedAt && { recorded_at: c.recordedAt }),
          }))));
        }
        if (d.additions?.length) {
          await must(db.from("batch_additions").insert(d.additions.map((a) => ({
            brewery_id: b, batch_id: idFor(a.batchId), added_on: a.addedOn, kind: a.kind, name: a.name,
            amount: a.amount ?? null, unit: a.unit, timing: a.timing || "", lot: a.lot || "", notes: a.notes || "",
            brew_day: !!a.brewDay, turn: a.turn ?? null,
            ...(a.recordedAt && { recorded_at: a.recordedAt }),
          }))));
        }
        if (d.readings?.length) {
          await must(db.from("batch_readings").insert(d.readings.map((r) => ({
            brewery_id: b, batch_id: idFor(r.batchId), turn: r.turn ?? null, field_key: r.fieldKey,
            value: r.value ?? null, value_text: r.valueText ?? null, raw: r.raw ?? null,
          }))));
        }
      }
      // The brew sheet's setup and units (an admin setting; skipped quietly for anyone else)
      if (can("manage_settings") && (d.prefs || d.sheetFields || d.sheetCustomFields?.length)) {
        await must(db.from("breweries").update({
          ...(d.prefs && { temperature_unit: d.prefs.temperatureUnit, gravity_unit: d.prefs.gravityUnit,
            volume_unit: d.prefs.volumeUnit, time_zone: d.prefs.timeZone, target_limits: d.prefs.targetLimits ?? undefined }),
          sheet_fields: d.sheetFields ?? null, sheet_custom_fields: d.sheetCustomFields || [],
          sheet_field_settings: d.sheetFieldSettings || {},
        }).eq("id", b));
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
  await db.from("stock_moves").delete().eq("brewery_id", b);
  await db.from("batches").delete().eq("brewery_id", b); // history goes with its batches
  await db.from("tanks").delete().eq("brewery_id", b);
  await db.from("beers").delete().eq("brewery_id", b);
  await db.from("stock_places").delete().eq("brewery_id", b);
  await db.from("raw_items").delete().eq("brewery_id", b); // their deliveries and counts go with them
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
  { id: "inventory",        label: "Count and move finished goods" },
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
  cellar: ["cellar_log", "tank_status", "acid_log", "move_beer", "package", "inventory"],
  brewer: ["cellar_log", "tank_status", "acid_log", "move_beer", "package", "inventory", "start_batch"],
  head_brewer: ["cellar_log", "tank_status", "acid_log", "move_beer", "package", "inventory", "start_batch",
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
  document.getElementById("inventory-view").hidden = view !== "inventory";
  document.getElementById("open-settings").hidden = view === "settings";
  document.getElementById("open-inventory").hidden = view !== "floor";
  document.getElementById("close-settings").hidden = view === "floor";
  document.getElementById("view-title").textContent = { settings: "Settings", batch: "Batch", inventory: "Inventory" }[view] || "Tanks";
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
    if (page === "backup") renderExports();
    if (page === "import") renderImport();
    if (page === "alerts") { document.getElementById("alerts-saved").textContent = ""; renderAlertSettings(); }
    if (page === "api") { document.getElementById("new-key").hidden = true; renderKeyPermissions(); loadApiKeys(); }
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
    `${catalogFields().filter((f) => choice.has(f.key)).length} of ${catalogFields().length} fields chosen`;
  document.getElementById("sheet-field-picker").innerHTML = sheetCatalog().map((section) => `
    <fieldset class="picker-section">
      <legend>${section.title} <span class="muted">· ${section.perTurn ? "each turn" : "whole batch"}</span></legend>
      ${allowed ? `<div class="picker-all"><button type="button" class="link" data-pick-section="${section.title}" data-pick="all">All</button>
        <button type="button" class="link" data-pick-section="${section.title}" data-pick="none">None</button></div>` : ""}
      ${section.fields.map((f) => `<div class="pick-row"><label class="pick">
        <input type="checkbox" data-pick-field="${f.key}" ${choice.has(f.key) ? "checked" : ""} ${allowed ? "" : "disabled"}>
        <span>${esc(f.label)} <span class="muted">${esc(fieldMeta(f))}${f.own ? " · your own" : ""}${
          f.usualLabel && f.usualLabel !== f.label ? ` · usually "${esc(f.usualLabel)}"` : ""}${
          f.targetSet ? ` · ${esc(f.target ? targetText(f, f.target({})) : "no target")}` : ""}</span></span></label>
        ${allowed ? `<button type="button" class="link" data-edit-field="${f.key}">Edit</button>` : ""}</div>`).join("")}
    </fieldset>`).join("");
  document.getElementById("sheet-fields-actions").hidden = !allowed;
  document.getElementById("custom-field-form").hidden = !allowed;
  if (!customForm.section.options.length) { // filled once
    customForm.section.innerHTML = SHEET_CATALOG.map((s) => `<option>${s.title}</option>`).join("");
    customForm.type.innerHTML = CUSTOM_TYPES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("");
  }
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
  const section = sheetCatalog().find((s) => s.title === button.dataset.pickSection);
  for (const f of section.fields) {
    if (button.dataset.pick === "all") pickerChoice.add(f.key); else pickerChoice.delete(f.key);
  }
  renderSheetPicker();
});
document.getElementById("sheet-field-picker").addEventListener("click", (e) => {
  const button = e.target.closest("[data-edit-field]");
  if (button) openFieldEditor(button.dataset.editField);
});

// ----- Editing one field: its name and target -----
const fieldDialog = document.getElementById("field-editor");
const fieldForm = document.getElementById("field-form");
let editingField = null;

// A target number as shown in the brewery's units (meters in gallons), and back
const targetShown = (f, v) => (v == null ? "" : f.type === "meter" ? +(v * 31).toFixed(1) : UNIT_TYPES.includes(f.type) ? toShown(f.type, v) : v);
const targetStored = (f, text) => (text === "" ? null : f.type === "meter" ? Number(text) / 31 : UNIT_TYPES.includes(f.type) ? fromShown(f.type, text) : Number(text));

function usualTargetText(f) {
  const usual = f.usualTarget ?? (f.targetSet ? undefined : f.target);
  if (!usual) return "no target";
  const fixed = usual({});
  return fixed ? targetText(f, fixed).replace(/^target /, "") : "worked out for each batch (from the beer, the brewhouse, or the water math)";
}

function openFieldEditor(key) {
  const f = catalogFields().find((x) => x.key === key);
  const mine = brewery.sheetFieldSettings?.[key] || {};
  editingField = f;
  document.getElementById("field-title").textContent = f.usualLabel || f.label;
  fieldForm.label.value = mine.label || "";
  fieldForm.label.placeholder = f.usualLabel || f.label;
  const canTarget = TARGET_TYPES.includes(f.type);
  document.getElementById("field-target").hidden = !canTarget;
  if (canTarget) {
    document.getElementById("field-usual-target").textContent = usualTargetText(f);
    const unit = f.type === "meter" ? "gal" : UNIT_TYPES.includes(f.type) ? UNIT_INFO[f.type][prefs()[`${f.type}Unit`]].label : f.type === "ph" ? "pH" : f.unit || "";
    document.querySelectorAll("#field-target .target-unit").forEach((el) => { el.textContent = unit; });
    fieldForm.targetKind.value = mine.target === "none" ? "none" : mine.target ? "own" : "usual";
    fieldForm.targetMin.value = targetShown(f, mine.target?.min);
    fieldForm.targetMax.value = targetShown(f, mine.target?.max);
  }
  fieldDialog.showModal();
}

fieldForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = editingField;
  const mine = {};
  const label = fieldForm.label.value.trim();
  if (label && label !== (f.usualLabel || f.label)) mine.label = label;
  if (TARGET_TYPES.includes(f.type)) {
    const kind = fieldForm.targetKind.value;
    if (kind === "none") mine.target = "none";
    if (kind === "own") {
      const min = targetStored(f, fieldForm.targetMin.value), max = targetStored(f, fieldForm.targetMax.value);
      if (min == null && max == null) { alert("Type a lowest value, a highest value, or both (the same number for an exact target)."); return; }
      if (min != null && max != null && min > max) { alert("The lowest value is higher than the highest."); return; }
      mine.target = { ...(min != null && { min }), ...(max != null && { max }) };
    }
  }
  await saveFieldSettings(f.key, Object.keys(mine).length ? mine : null);
});
// Typing a number means "my own target"
["targetMin", "targetMax"].forEach((name) => fieldForm[name].addEventListener("input", () => { fieldForm.targetKind.value = "own"; }));
document.getElementById("field-back-to-usual").addEventListener("click", () => saveFieldSettings(editingField.key, null));

async function saveFieldSettings(key, mine) {
  const all = { ...(brewery.sheetFieldSettings || {}) };
  if (mine) all[key] = mine; else delete all[key];
  const ok = await save(async () => {
    const saved = await must(db.from("breweries").update({ sheet_field_settings: all }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("You don't have permission to change the brew sheet's fields.");
  });
  if (ok) fieldDialog.close();
}

document.getElementById("pick-usual").addEventListener("click", () => { pickerChoice = new Set(USUAL_FIELDS); renderSheetPicker(); });
document.getElementById("pick-everything").addEventListener("click", () => {
  pickerChoice = new Set(catalogFields().map((f) => f.key));
  renderSheetPicker();
});
document.getElementById("save-sheet-fields").addEventListener("click", async () => {
  if (!pickerChoice) return;
  // Saved in catalog (paper) order
  const keys = catalogFields().map((f) => f.key).filter((k) => pickerChoice.has(k));
  const ok = await save(async () => {
    const saved = await must(db.from("breweries").update({ sheet_fields: keys }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("You don't have permission to choose the brew sheet's fields.");
  });
  if (ok) pickerChoice = null;
  renderSheetPicker();
});

// Adding the brewery's own field: saved right away, and ticked (so it shows on the sheet)
const customForm = document.getElementById("custom-field-form");
customForm.type.addEventListener("change", () => { customForm.querySelector(".unit-field").hidden = customForm.type.value !== "number"; });
customForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = customForm.label.value.trim();
  if (!label) return;
  if (catalogFields().some((f) => f.label.toLowerCase() === label.toLowerCase() && f.own)) {
    alert(`There's already a field called "${label}".`);
    return;
  }
  const own = { key: `custom_${newId().replace(/-/g, "").slice(0, 12)}`, label, section: customForm.section.value,
    type: customForm.type.value, unit: customForm.type.value === "number" ? customForm.unit.value.trim() : "" };
  // Ticked along with whatever is ticked now (including unsaved ticks)
  const choice = new Set(pickerChoice ?? chosenFields());
  choice.add(own.key);
  const keys = [...catalogFields(), field(own.key)].map((f) => f.key).filter((k) => choice.has(k));
  const ok = await save(async () => {
    const saved = await must(db.from("breweries").update({
      sheet_custom_fields: [...(brewery.sheetCustomFields || []), own], sheet_fields: keys,
    }).eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("You don't have permission to change the brew sheet's fields.");
  });
  if (ok) { customForm.reset(); customForm.querySelector(".unit-field").hidden = false; pickerChoice = null; }
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
      <span class="who">${esc(i.email)} <span class="muted">· ${labelFrom(ROLES, i.role)}${i.emailedAt ? ` · emailed ${new Date(i.emailedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : " · not emailed"}</span></span>
      <span class="actions"><button class="btn small" data-email-invite="${i.id}">${i.emailedAt ? "Email again" : "Email"}</button>
      <button class="btn small" data-cancel-invite="${i.id}">Cancel</button></span>
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
  const id = newId();
  const ok = await save(() => must(db.from("invites").insert({ id, brewery_id: brewery.id, email, role })));
  if (!ok) return;
  inviteForm.reset();
  inviteMessage(`Invited ${email} as ${labelFrom(ROLES, role).toLowerCase()}. Sending the email…`);
  await emailInvite(id, email);
});

// Email an invite (see supabase/functions/send-invite). If the email can't go out, the invite still
// stands: the person can open the app and sign in with that address, and the message says so.
async function emailInvite(inviteId, email) {
  const fallback = `Ask them to open ${location.host} and sign in with ${email}; they'll join ${brewery.name} automatically.`;
  let problem = null;
  try {
    const { data: result, error } = await db.functions.invoke("send-invite", { body: { inviteId } });
    if (error) {
      // The function's own explanation, when it gave one
      const body = await error.context?.json?.().catch(() => null);
      problem = body?.error || (isConnectionProblem(error) ? "No signal." : "The email couldn't be sent.");
    } else if (!result?.sent) {
      problem = "The email couldn't be sent.";
    }
  } catch (e) {
    problem = isConnectionProblem(e) ? "No signal." : "The email couldn't be sent.";
  }
  inviteMessage(problem ? `${problem} The invite is saved. ${fallback}` : `Emailed ${email} an invite to join ${brewery.name}.`);
  await refresh().catch(() => {});
}

document.getElementById("team").addEventListener("click", async (e) => {
  const member = e.target.closest("[data-member]");
  const cancel = e.target.closest("[data-cancel-invite]");
  const resend = e.target.closest("[data-email-invite]");
  if (resend) {
    const invite = data.invites.find((i) => i.id === resend.dataset.emailInvite);
    resend.disabled = true;
    inviteMessage(`Sending the email to ${invite.email}…`);
    await emailInvite(invite.id, invite.email);
  }
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

// ----- Packaging: package types, packaging runs, and "this tank is spent" -----
// The catalog of package types a brewery can tick (Settings → Packages). Volumes per package in
// US barrels. A ticked type becomes the brewery's own row (renamable); its catalog key remembers
// where it came from. From research on keg and package sizes (docs/moving-beer-design.md).
const GAL = 1 / 31, LITER = 0.264172 / 31, IMP_GAL = 1.20095 / 31, FL_OZ = 1 / 128 / 31;
const PACKAGE_CATALOG = [
  { group: "US kegs", kind: "keg", items: [
    ["keg_half", "½ bbl keg", 0.5], ["keg_quarter", "¼ bbl keg", 0.25], ["keg_slim_quarter", "Slim ¼ bbl keg", 0.25],
    ["keg_sixth", "⅙ bbl keg", 1 / 6], ["keg_eighth", "⅛ bbl keg", 0.125]] },
  { group: "Metric kegs", kind: "keg", items: [
    ["keg_50l", "50 L keg", 50 * LITER], ["keg_30l", "30 L keg", 30 * LITER], ["keg_25l", "25 L keg", 25 * LITER], ["keg_20l", "20 L keg", 20 * LITER]] },
  { group: "One-way kegs (KeyKeg, PolyKeg, Petainer...)", kind: "keg", items: [
    ["oneway_30l", "30 L one-way keg", 30 * LITER], ["oneway_20l", "20 L one-way keg", 20 * LITER], ["oneway_10l", "10 L one-way keg", 10 * LITER]] },
  { group: "Cornelius kegs", kind: "keg", items: [
    ["corny_5", "5 gal Cornelius keg", 5 * GAL], ["corny_3", "3 gal Cornelius keg", 3 * GAL], ["corny_2_5", "2.5 gal Cornelius keg", 2.5 * GAL]] },
  { group: "Casks", kind: "cask", items: [
    ["cask_pin", "Pin (4.5 imperial gal)", 4.5 * IMP_GAL], ["cask_firkin", "Firkin (9 imperial gal)", 9 * IMP_GAL],
    ["cask_kilderkin", "Kilderkin (18 imperial gal)", 18 * IMP_GAL]] },
  { group: "Cans and bottles, by the case", kind: "case", items: [
    ["case_24x12", "Case, 24 × 12 oz", 24 * 12 * FL_OZ], ["case_24x16", "Case, 24 × 16 oz", 24 * 16 * FL_OZ],
    ["case_24x19_2", "Case, 24 × 19.2 oz", 24 * 19.2 * FL_OZ], ["case_12x22", "Case, 12 × 22 oz", 12 * 22 * FL_OZ],
    ["case_12x750", "Case, 12 × 750 mL", 12 * 0.75 * LITER]] },
  { group: "Single containers", kind: "single", items: [
    ["crowler", "Crowler (32 oz)", 32 * FL_OZ], ["growler", "Growler (64 oz)", 64 * FL_OZ], ["howler", "Howler (32 oz)", 32 * FL_OZ],
    ["minikeg_5l", "5 L mini keg", 5 * LITER]] },
];

// "15.5 gal" or "50 L": a package's size, in the units people say it in
function packageSize(volumeBbl) {
  return prefs().volumeUnit === "hl" ? `${+(volumeBbl / LITER).toFixed(2)} L` : `${+(volumeBbl * 31).toFixed(2)} gal`;
}
// In a sensible order: kegs and casks largest first, then cases, then single containers, then the rest
const PACKAGE_KIND_ORDER = ["keg", "cask", "case", "single", "other"];
const byPackageOrder = (a, b) => PACKAGE_KIND_ORDER.indexOf(a.kind) - PACKAGE_KIND_ORDER.indexOf(b.kind) || b.volumeBbl - a.volumeBbl || a.name.localeCompare(b.name);
const activePackageTypes = () => (data.packageTypes || []).filter((t) => t.active).sort(byPackageOrder);

function renderPackageTypes() {
  const allowed = can("manage_settings");
  const types = data.packageTypes || [];
  const byKey = Object.fromEntries(types.filter((t) => t.catalogKey).map((t) => [t.catalogKey, t]));
  const own = types.filter((t) => !t.catalogKey);
  const box = (t, key, name, volume) => `<div class="pick-row"><label class="pick">
      <input type="checkbox" ${t?.active ? "checked" : ""} ${allowed ? "" : "disabled"} ${key ? `data-package-key="${key}"` : `data-package-id="${t.id}"`}>
      <span>${esc(t?.name ?? name)} <span class="muted">${packageSize(t?.volumeBbl ?? volume)}${t && t.name !== name && key ? ` · usually "${esc(name)}"` : ""}</span></span></label>
      ${allowed && t ? `<button type="button" class="link" data-rename-package="${t.id}">Rename</button>` : ""}</div>`;
  document.getElementById("package-type-picker").innerHTML = PACKAGE_CATALOG.map((g) => `
    <fieldset class="picker-section"><legend>${g.group}</legend>
      ${g.items.map(([key, name, volume]) => box(byKey[key], key, name, volume)).join("")}
    </fieldset>`).join("") + (own.length ? `
    <fieldset class="picker-section"><legend>Your own</legend>${own.map((t) => box(t, null, t.name, t.volumeBbl)).join("")}</fieldset>` : "");
  document.getElementById("package-type-count").textContent = `${activePackageTypes().length} in use`;
  document.getElementById("package-types-note").hidden = allowed;
  document.getElementById("own-package-form").hidden = !allowed;
}

document.getElementById("package-type-picker").addEventListener("change", async (e) => {
  const input = e.target.closest("input[type=checkbox]");
  if (!input) return;
  const key = input.dataset.packageKey;
  const existing = key ? data.packageTypes.find((t) => t.catalogKey === key) : data.packageTypes.find((t) => t.id === input.dataset.packageId);
  await save(async () => {
    if (existing) {
      await must(db.from("package_types").update({ active: input.checked }).eq("id", existing.id).select("id"));
    } else {
      const group = PACKAGE_CATALOG.find((g) => g.items.some(([k]) => k === key));
      const [, name, volume] = group.items.find(([k]) => k === key);
      await must(db.from("package_types").insert({ brewery_id: brewery.id, name, volume_bbl: volume, kind: group.kind, catalog_key: key }));
    }
  });
  await refresh().catch(() => {});
});
document.getElementById("package-type-picker").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-rename-package]");
  if (!button) return;
  const type = data.packageTypes.find((t) => t.id === button.dataset.renamePackage);
  const name = prompt("Name for this package type:", type.name)?.trim();
  if (!name || name === type.name) return;
  await save(() => must(db.from("package_types").update({ name }).eq("id", type.id).select("id")));
});

const ownPackageForm = document.getElementById("own-package-form");
const PER_UNIT = { gal: GAL, l: LITER, oz: FL_OZ, ml: LITER / 1000, impgal: IMP_GAL, bbl: 1 };
ownPackageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = ownPackageForm;
  const volume = Number(f.volume.value) * PER_UNIT[f.unit.value] * Math.max(1, Number(f.per.value) || 1);
  if (!(volume > 0)) return;
  const name = f.name.value.trim();
  if (data.packageTypes.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    alert(`There's already a package type called "${name}".`);
    return;
  }
  const ok = await save(() => must(db.from("package_types").insert({ brewery_id: brewery.id, name, volume_bbl: volume, kind: f.kind.value })));
  if (ok) { f.reset(); f.per.value = 1; }
});

// ----- A packaging run -----
const packageDialog = document.getElementById("package-editor");
const packageForm = document.getElementById("package-form");

function openPackageEditor() {
  const b = viewingBatch();
  document.getElementById("package-title").textContent = `Package ${beerName(b)} ${batchLabel(b)} from ${tankName(b.tankId)}`;
  packageForm.reset();
  packageForm.occurredOn.value = today();
  const types = activePackageTypes();
  document.getElementById("package-rows").innerHTML = types.length
    ? types.map((t) => `<label class="package-row"><span>${esc(t.name)} <span class="muted">${packageSize(t.volumeBbl)}</span></span>
        <input type="number" min="0" step="any" inputmode="decimal" placeholder="0" data-package-type="${t.id}" aria-label="How many ${esc(t.name)}"></label>`).join("")
    : `<p class="muted">No package types are ticked yet (Settings → Packages).</p>`;
  // Into: the tank location's storage place, unless another is chosen
  packageForm.placeId.innerHTML = activePlaces().map((p) => `<option value="${p.id}">${esc(placeName(p.id))}</option>`).join("");
  const into = defaultPlace(findTank(b.tankId)?.locationId);
  if (into) packageForm.placeId.value = into;
  updatePackageSummary();
  packageDialog.showModal();
}
document.getElementById("bv-package").addEventListener("click", openPackageEditor);

// The counts typed so far, and what they add up to
function packageCounts() {
  return [...packageForm.querySelectorAll("[data-package-type]")]
    .map((input) => ({ type: input.dataset.packageType, count: Number(input.value) || 0 }))
    .filter((c) => c.count > 0);
}
const countsVolume = (counts) => counts.reduce((sum, c) => sum + c.count * (data.packageTypes.find((t) => t.id === c.type)?.volumeBbl || 0), 0);

function updatePackageSummary() {
  const b = viewingBatch();
  const inTank = tankBalance(b.id, b.tankId);
  const filled = countsVolume(packageCounts());
  const left = inTank == null ? null : inTank - filled;
  const tank = tankName(b.tankId);
  document.getElementById("package-summary").textContent = filled
    ? `= ${showUnit("volume", filled)}${left != null ? ` · about ${showUnit("volume", Math.max(0, left))} left in ${tank}` : ""}`
    : inTank != null ? `${tank} has about ${showUnit("volume", inTank)}.` : `${tank}: volume not recorded.`;
  // The calculator: what's left fills about this many of each package
  const fits = left > 0 ? activePackageTypes().slice(0, 4).map((t) => `${Math.floor(left / t.volumeBbl)} × ${t.name}`) : [];
  document.getElementById("package-fits").textContent = fits.length ? `What's left fills about: ${fits.join(", ")}.` : "";
  const spent = packageForm.spent.value === "yes";
  document.getElementById("package-spent-note").textContent = !spent ? "The rest stays in the tank for another run."
    : left == null ? "The batch is packaged and the tank goes to cleaning."
    : left > 0.0001 ? `The remaining ${showUnit("volume", left)} is recorded as loss, the batch is packaged, and the tank goes to cleaning.`
    : left < -0.0001 ? `That's ${showUnit("volume", -left)} more than was on record; it's noted as a correction.`
    : "The batch is packaged and the tank goes to cleaning.";
}
packageForm.addEventListener("input", updatePackageSummary);
packageForm.addEventListener("change", updatePackageSummary);

packageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = viewingBatch();
  const counts = packageCounts();
  const spent = packageForm.spent.value === "yes";
  if (!counts.length && !spent) { alert("Enter how many of each package were filled."); return; }
  if (spent) {
    // A big leftover is probably something not entered: ask before recording it as loss
    const inTank = tankBalance(b.id, b.tankId);
    const left = inTank == null ? null : inTank - countsVolume(counts);
    if (left != null && inTank > 0 && left > inTank * 0.1 &&
        !confirm(`${showUnit("volume", left)} is unaccounted for. Record it as loss and close ${tankName(b.tankId)}? (Cancel to go back and check the counts.)`)) return;
  }
  const filled = countsVolume(counts);
  const ok = await saveOrKeep("package", {
    p_id: newId(), p_brewery_id: brewery.id, p_batch_id: b.id, p_tank_id: b.tankId, p_occurred_on: packageForm.occurredOn.value,
    p_counts: counts, p_spent: spent, p_notes: packageForm.notes.value.trim(), p_place_id: packageForm.placeId.value || null,
  }, `${beerName(b)} ${batchLabel(b)}: packaged ${showUnit("volume", filled)}${spent ? ", tank spent" : ""}`);
  if (ok) packageDialog.close();
});

// ----- Splits and blends: a new batch made from part or all of other batches -----
// (docs/moving-beer-design.md, option A: each part is its own batch, so a tank holds one batch.)
// The batches a batch was made from, and the batches made from it, with how much moved
function madeFrom(batchId) {
  return data.movements.filter((m) => m.batchId === batchId && m.kind === "from_batch" && m.sourceBatchId);
}
function wentInto(batchId) {
  return data.movements.filter((m) => m.batchId === batchId && m.kind === "to_batch" && m.sourceBatchId);
}
const batchLink = (id) => {
  const b = data.batches.find((x) => x.id === id);
  return b ? `<button type="button" class="link inline" data-open-batch="${b.id}">${esc(batchLabel(b))}</button>` : "another batch";
};
const amountOf = (m) => (m.volumeBbl != null ? `${showUnit("volume", m.volumeBbl)} of ` : "");

function renderFamily(b) {
  const from = madeFrom(b.id), into = wentInto(b.id);
  // Finished goods from this batch still on hand
  const stock = stockOnHand().filter((r) => r.batchId === b.id && r.count > 0);
  const stockText = [...new Set(stock.map((r) => r.typeId))].map((t) =>
    `${+sumCount(stock.filter((r) => r.typeId === t)).toFixed(2)} × ${esc(typeOf(t)?.name ?? "package")}`).join(", ");
  document.getElementById("bv-family").innerHTML = [
    stockText ? `In stock: ${stockText}` : "",
    from.length ? `Made from ${from.map((m) => `${amountOf(m)}${batchLink(m.sourceBatchId)}`).join(" + ")}` : "",
    into.length ? `${b.stage === "used" ? "All used in" : "Part went into"} ${into.map((m) => `${batchLink(m.sourceBatchId)}${m.volumeBbl != null ? ` (${showUnit("volume", m.volumeBbl)})` : ""}`).join(", ")}` : "",
  ].filter(Boolean).map((t) => `<div>${t}</div>`).join("");
}
document.getElementById("batch-view").addEventListener("click", (e) => {
  const link = e.target.closest("[data-open-batch]");
  if (link) openBatchView(link.dataset.openBatch);
});

const blendDialog = document.getElementById("blend-editor");
const blendForm = document.getElementById("blend-form");

// One source row: which batch, how much ("all of it" when empty), and whether it's all used
function sourceRow(batch, fixed) {
  const inTank = tankBalance(batch.id, batch.tankId);
  return `<div class="source-row" data-source="${batch.id}">
    <div><strong>${esc(beerName(batch))} ${esc(batchLabel(batch))}</strong> <span class="muted">in ${esc(tankName(batch.tankId))} · ${volumeText(inTank)}</span>
      ${fixed ? "" : `<button type="button" class="link inline" data-remove-source>remove</button>`}</div>
    <div class="two-col">
      <label><span>How much (<span class="volume-unit">bbl</span>)</span>
        <input type="number" min="0" step="any" inputmode="decimal" data-unit="volume" data-source-volume
          placeholder="${inTank != null ? `all of it (${toShown("volume", inTank)})` : "all of it"}"></label>
      <label class="choice"><input type="checkbox" data-source-used checked> All used: ${esc(tankName(batch.tankId))} is empty after</label>
    </div>
  </div>`;
}

function openBlendEditor() {
  const b = viewingBatch();
  blendForm.reset();
  document.getElementById("blend-sources").innerHTML = sourceRow(b, true);
  blendForm.occurredOn.value = today();
  fillBeerChoices(blendForm.beerId, b.beerId);
  blendForm.stage.innerHTML = STAGES.filter((s) => !["packaged", "used"].includes(s.id))
    .map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  blendForm.stage.value = b.stage;
  blendForm.batchNumber.value = nextSplitNumber(b);
  updateBlendForm();
  applyUnitLabels();
  blendDialog.showModal();
}
document.getElementById("bv-blend").addEventListener("click", openBlendEditor);

// "#142" -> "142-2" (or -3... if taken); a blend of 142 and 143 -> "142/143"
function nextSplitNumber(b) {
  const taken = new Set(data.batches.map((x) => x.batchNumber.toLowerCase()));
  for (let n = 2; ; n++) if (!taken.has(`${b.batchNumber}-${n}`.toLowerCase())) return `${b.batchNumber}-${n}`;
}
function fillBeerChoices(select, chosen) {
  select.innerHTML = [...data.beers].sort((x, y) => x.name.localeCompare(y.name))
    .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  select.value = chosen;
}

const blendSources = () => [...document.querySelectorAll("#blend-sources [data-source]")].map((row) => ({
  batch: row.dataset.source,
  volume: row.querySelector("[data-source-volume]").value === "" ? null : fromShown("volume", row.querySelector("[data-source-volume]").value),
  used_up: row.querySelector("[data-source-used]").checked,
}));

function updateBlendForm() {
  const sources = blendSources();
  const ids = sources.map((s) => s.batch);
  // More batches that could be blended in: anything else in a tank
  const others = data.batches.filter((x) => isInTank(x) && x.tankId && !ids.includes(x.id));
  document.getElementById("blend-add").innerHTML = `<option value="">+ Blend in another batch…</option>` +
    others.map((x) => `<option value="${x.id}">${esc(beerName(x))} ${esc(batchLabel(x))} (${esc(tankName(x.tankId))})</option>`).join("");
  document.getElementById("blend-add").hidden = !others.length;
  // Tanks: empty ones, plus the tank of any source that's all used here
  const usedTanks = sources.filter((s) => s.used_up).map((s) => findBatchById(s.batch)?.tankId);
  const chosen = blendForm.tankId.value;
  const tanks = data.tanks.filter((t) => (!batchInTank(t.id) && t.status !== "maintenance") || usedTanks.includes(t.id));
  blendForm.tankId.innerHTML = tanks.map((t) => `<option value="${t.id}">${esc(t.name)}${t.status === "cleaning" && !batchInTank(t.id) ? " (cleaning)" : ""}</option>`).join("")
    || `<option value="">No empty tank</option>`;
  if (tanks.some((t) => t.id === chosen)) blendForm.tankId.value = chosen;
  // What it adds up to
  let total = 0, known = true;
  for (const s of sources) {
    const v = s.volume ?? tankBalance(s.batch, findBatchById(s.batch)?.tankId);
    if (v == null) known = false; else total += v;
  }
  document.getElementById("blend-summary").textContent = `New batch: ${known ? showUnit("volume", total) : "volume not recorded"} in ${tankName(blendForm.tankId.value) || "—"}` +
    (sources.length > 1 ? ` (a blend of ${sources.length} batches)` : "") + ".";
  document.getElementById("blend-title").textContent = sources.length > 1 ? "Blend into a new batch" : "Split into a new batch";
}
const findBatchById = (id) => data.batches.find((x) => x.id === id);

blendForm.addEventListener("input", (e) => {
  if (e.target.id === "blend-add") return; // handled on "change" below (redrawing now would lose the choice)
  // "All of it" (no amount typed) usually means the source is all used; a part usually means it isn't.
  // Once someone ticks or unticks it themselves, leave it alone.
  const volume = e.target.closest("[data-source-volume]");
  if (volume) {
    const used = volume.closest("[data-source]").querySelector("[data-source-used]");
    if (!used.dataset.touched) used.checked = volume.value === "";
  }
  if (e.target.closest("[data-source-used]")) e.target.dataset.touched = "yes";
  updateBlendForm();
});
blendForm.addEventListener("change", (e) => {
  if (e.target.id === "blend-add" && e.target.value) {
    const added = findBatchById(e.target.value);
    document.getElementById("blend-sources").insertAdjacentHTML("beforeend", sourceRow(added, false));
    // A blend's usual name: the batch numbers together
    const numbers = blendSources().map((s) => findBatchById(s.batch).batchNumber);
    blendForm.batchNumber.value = numbers.join("/");
    applyUnitLabels();
  }
  updateBlendForm();
});
document.getElementById("blend-sources").addEventListener("click", (e) => {
  if (e.target.closest("[data-remove-source]")) { e.target.closest("[data-source]").remove(); updateBlendForm(); }
});

blendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const number = blendForm.batchNumber.value.trim();
  if (data.batches.some((x) => x.batchNumber.toLowerCase() === number.toLowerCase())) { alert(`There's already a batch #${number}.`); return; }
  if (!blendForm.tankId.value) { alert("Choose a tank for the new batch."); return; }
  const sources = blendSources();
  const ok = await saveOrKeep("makeBatch", {
    p_id: newId(), p_brewery_id: brewery.id, p_batch_number: number, p_beer_id: blendForm.beerId.value, p_tank_id: blendForm.tankId.value,
    p_stage: blendForm.stage.value, p_occurred_on: blendForm.occurredOn.value, p_sources: sources, p_notes: "",
  }, `New batch #${number} in ${tankName(blendForm.tankId.value)}`);
  if (ok) blendDialog.close();
});

// ----- Level checks: what the sight glass shows -----
const levelDialog = document.getElementById("level-editor");
const levelForm = document.getElementById("level-form");

function openLevelEditor() {
  const b = viewingBatch();
  const tank = findTank(b.tankId);
  document.getElementById("level-title").textContent = `Check the level in ${tank.name}`;
  levelForm.reset();
  levelForm.occurredOn.value = today();
  // A serving tank's drop is usually what was poured
  levelForm.reason.value = tank.type === "serving" ? "served" : "loss";
  updateLevelNote();
  levelDialog.showModal();
}
document.getElementById("bv-level").addEventListener("click", openLevelEditor);

function updateLevelNote() {
  const b = viewingBatch();
  const expected = tankBalance(b.id, b.tankId);
  const reading = levelForm.reading.value === "" ? null : fromShown("volume", levelForm.reading.value);
  const drop = expected != null && reading != null && reading < expected - 1e-9;
  document.getElementById("level-reason").hidden = !drop;
  document.getElementById("level-note").textContent =
    expected == null ? "The volume wasn't recorded along the way, so this reading sets it from here on."
    : reading == null ? `On record: ${showUnit("volume", expected)}.`
    : drop ? `On record: ${showUnit("volume", expected)}. The ${showUnit("volume", expected - reading)} difference is recorded as:`
    : reading > expected + 1e-9 ? `On record: ${showUnit("volume", expected)}. The extra ${showUnit("volume", reading - expected)} is noted as a correction.`
    : `On record: ${showUnit("volume", expected)}. That matches.`;
}
levelForm.addEventListener("input", updateLevelNote);

levelForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = viewingBatch();
  const reading = fromShown("volume", levelForm.reading.value);
  const ok = await saveOrKeep("levelCheck", {
    p_id: newId(), p_brewery_id: brewery.id, p_batch_id: b.id, p_tank_id: b.tankId, p_occurred_on: levelForm.occurredOn.value,
    p_reading_bbl: reading, p_reason: levelForm.reason.value, p_notes: levelForm.notes.value.trim(),
  }, `${tankName(b.tankId)}: level check (${showUnit("volume", reading)})`);
  if (ok) levelDialog.close();
});

// ---------- Inventory: finished goods (docs/inventory-design.md) ----------
// Stock sits in places (a location's storage cooler, its taproom...). Like beer in tanks, what's on
// hand is worked out from a ledger of stock moves: packaged in, moved, removed, returned, counted.
const REMOVAL_KINDS = { sold: "Sold", taproom: "Taproom", transferred: "Transferred", donated: "Donated or samples", dumped: "Dumped", unknown: "Not sure" };
const activePlaces = () => (data.places || []).filter((p) => p.active);
function placeName(id, d = data) {
  const p = (d.places || []).find((x) => x.id === id);
  if (!p) return "a place";
  const loc = d.locations.length > 1 ? findLocation(p.locationId)?.name : null;
  return loc ? `${loc} · ${p.name}` : p.name;
}
// Where packages go by default: the location's storage place (mirrors default_stock_place())
function defaultPlace(locationId, d = data) {
  const storage = (d.places || []).filter((p) => p.active && p.kind === "storage");
  return (storage.find((p) => p.locationId === locationId) || storage[0])?.id ?? null;
}

// What's on hand: [{ placeId, beerId, batchId, typeId, count }], counts not zero
function stockOnHand(d = data) {
  const totals = new Map();
  const add = (placeId, m, sign) => {
    const key = `${placeId}|${m.beerId}|${m.batchId || ""}|${m.packageTypeId}`;
    const row = totals.get(key) || { placeId, beerId: m.beerId, batchId: m.batchId || null, typeId: m.packageTypeId, count: 0 };
    row.count += sign * m.count;
    totals.set(key, row);
  };
  for (const m of d.stockMoves || []) {
    if (m.toPlaceId) add(m.toPlaceId, m, 1);
    if (m.fromPlaceId) add(m.fromPlaceId, m, -1);
  }
  return [...totals.values()].filter((r) => Math.abs(r.count) > 1e-9);
}
const sumCount = (rows) => rows.reduce((sum, r) => sum + r.count, 0);
const typeOf = (id, d = data) => (d.packageTypes || []).find((t) => t.id === id);

// Take stock out of a place, oldest batch first (no batch = from before the app = oldest).
// Mirrors take_stock() in the database, for showing changes before they're sent.
function takeStock(d, { group, date, kind, removal, beer, batch, type, count, from, to, account, notes }) {
  const brewed = (id) => d.batches.find((b) => b.id === id)?.brewDate || "";
  const lots = stockOnHand(d).filter((r) => r.placeId === from && r.beerId === beer && r.typeId === type && r.count > 0 && (!batch || r.batchId === batch))
    .sort((x, y) => (x.batchId ? 1 : 0) - (y.batchId ? 1 : 0) || brewed(x.batchId).localeCompare(brewed(y.batchId)));
  let left = count;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.count, left);
    d.stockMoves.push({ id: `${group}-${d.stockMoves.length}`, groupId: group, occurredOn: date, kind, removalKind: removal ?? null, beerId: beer,
      batchId: lot.batchId, packageTypeId: type, count: take, fromPlaceId: from, toPlaceId: to ?? null, account: account || "", notes: notes || "",
      recordedAt: new Date().toISOString() });
    left -= take;
  }
}

// ----- Inventory views: the brewery's own sheets (like a master sheet) -----
// A view adds up chosen places, with columns per size (or per place and size), totals, pars, and
// the pipeline: what's still in tanks for each beer.
let inventoryView = null; // a view's id while one is chosen
const VIEW_COLUMNS = { total_bbl: "Total (barrels)", total_cases: "Total cases", par_bbl: "Par (barrels)", par_cases: "Par (cases)", pipeline: "Pipeline (in tanks)" };
const views = () => [...(data.views || [])].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

// Beer still in tanks: [{ batch, tankId, stage, bbl }] (bbl null when not recorded)
function pipelineFor(beerId) {
  return data.batches.filter((b) => b.beerId === beerId && isInTank(b) && b.tankId)
    .map((b) => ({ batch: b, tankId: b.tankId, stage: b.stage, bbl: tankBalance(b.id, b.tankId) }));
}

function renderViewTable(view) {
  const placeIds = view.placeIds.filter((id) => (data.places || []).some((p) => p.id === id));
  const rows = stockOnHand().filter((r) => placeIds.includes(r.placeId) && r.count > 0);
  const types = (view.typeIds.length ? view.typeIds : [...new Set(rows.map((r) => r.typeId))]).map((id) => typeOf(id)).filter(Boolean);
  const show = new Set(view.show);
  const bbl = (rs) => rs.reduce((sum, r) => sum + r.count * (typeOf(r.typeId)?.volumeBbl || 0), 0);
  const cases = (rs) => sumCount(rs.filter((r) => typeOf(r.typeId)?.kind === "case"));
  const brewerPar = (id) => parFor(null, id);
  // Which beers: with stock, or a par, or everything (and anything coming down the pipeline, when it's shown)
  let ids = new Set(rows.map((r) => r.beerId));
  if (view.beers !== "stock") (data.pars || []).filter((p) => !p.placeId).forEach((p) => ids.add(p.beerId));
  if (view.beers === "all") data.beers.forEach((b) => ids.add(b.id));
  if (show.has("pipeline")) data.batches.filter((b) => isInTank(b) && b.tankId).forEach((b) => ids.add(b.beerId));
  const name = (id) => findBeer(id)?.name || "";
  const oldest = (id) => (rows.filter((r) => r.beerId === id).map((r) => (r.batchId ? findBatchById(r.batchId)?.brewDate || "~" : "")).sort()[0] ?? "~");
  const beers = [...ids].filter(findBeer).sort((a, b) => (view.sortMode === "oldest" ? oldest(a).localeCompare(oldest(b)) : 0) || name(a).localeCompare(name(b)));

  const cols = view.splitByPlace ? placeIds.flatMap((p) => types.map((t) => ({ place: p, type: t }))) : types.map((t) => ({ place: null, type: t }));
  const n = (v, digits = 2) => (v ? +v.toFixed(digits) : "–");
  const cell = (v, extra = "") => `<td class="${v ? "" : "zero"} ${extra}">${n(v)}</td>`;
  const extras = Object.keys(VIEW_COLUMNS).filter((k) => show.has(k));
  const extraHead = { total_bbl: "Total bbl", total_cases: "Cases", par_bbl: "Par bbl", par_cases: "Case par", pipeline: "In tanks" };
  const groupHead = view.splitByPlace ? `<tr><th></th>${placeIds.map((p) => `<th colspan="${types.length}" class="group">${esc(placeName(p))}</th>`).join("")}${extras.map(() => "<th></th>").join("")}</tr>` : "";
  const head = `${groupHead}<tr><th>Beer</th>${cols.map((c) => `<th>${esc(c.type.name)}</th>`).join("")}${extras.map((k) => `<th>${extraHead[k]}</th>`).join("")}</tr>`;
  const body = beers.map((id) => {
    const mine = rows.filter((r) => r.beerId === id);
    const par = brewerPar(id);
    const totalBbl = bbl(mine), totalCases = cases(mine);
    const pipe = pipelineFor(id);
    const pipeBbl = pipe.reduce((sum, p) => sum + (p.bbl || 0), 0);
    const under = (par?.parBbl != null && totalBbl < par.parBbl - 1e-9) || (par?.parCases != null && totalCases < par.parCases - 1e-9);
    const value = {
      total_bbl: `<td><strong>${n(totalBbl)}</strong></td>`, total_cases: cell(totalCases),
      par_bbl: `<td class="${under ? "under" : ""}">${par?.parBbl != null ? n(par.parBbl) : ""}</td>`,
      par_cases: `<td class="${under ? "under" : ""}">${par?.parCases != null ? n(par.parCases) : ""}</td>`,
      pipeline: `<td>${pipe.length ? `${n(pipeBbl)}${pipe.some((p) => p.bbl == null) ? "+" : ""}` : "–"}</td>`,
    };
    let html = `<tr class="beer-row${under ? " under" : ""}" data-inv-beer="${id}"><td><strong>${esc(name(id))}</strong></td>
      ${cols.map((c) => cell(sumCount(mine.filter((r) => r.typeId === c.type.id && (!c.place || r.placeId === c.place))))).join("")}
      ${extras.map((k) => value[k]).join("")}</tr>`;
    if (openBeers.has(id) && pipe.length) {
      html += pipe.map((p) => `<tr class="batches"><td colspan="${1 + cols.length + extras.length}">${esc(batchLabel(p.batch))} in ${esc(tankName(p.tankId))} · ${stageLabel(p.stage)} · ${p.bbl == null ? "volume not recorded" : showUnit("volume", p.bbl)}</td></tr>`).join("");
    }
    return html;
  }).join("");
  const totalRow = `<tr><td><strong>Total</strong></td>${cols.map((c) => cell(sumCount(rows.filter((r) => r.typeId === c.type.id && (!c.place || r.placeId === c.place))))).join("")}
    ${extras.map((k) => ({ total_bbl: `<td><strong>${n(bbl(rows))}</strong></td>`, total_cases: cell(cases(rows)),
      pipeline: `<td>${n(beers.reduce((sum, id) => sum + pipelineFor(id).reduce((s, p) => s + (p.bbl || 0), 0), 0))}</td>` }[k] || "<td></td>")).join("")}</tr>`;
  document.getElementById("inv-table").innerHTML = beers.length
    ? `<table class="inv-table view-table">${head}${body}${totalRow}</table>`
    : `<p class="muted">Nothing to show in this view yet.</p>`;
}

// ----- Making and changing views -----
const viewDialog = document.getElementById("view-editor");
const viewForm = document.getElementById("view-form");
let editingView = null;
function openViewEditor(view) {
  editingView = view;
  viewForm.reset();
  document.getElementById("view-editor-title").textContent = view ? `View: ${view.name}` : "New view";
  document.getElementById("delete-view").hidden = !view;
  document.getElementById("view-places").innerHTML = (data.places || []).filter((p) => p.active || view?.placeIds.includes(p.id)).map((p) => `
    <label class="choice"><input type="checkbox" value="${p.id}" ${view ? (view.placeIds.includes(p.id) ? "checked" : "") : (p.kind === "storage" ? "checked" : "")}> ${esc(placeName(p.id))}</label>`).join("");
  document.getElementById("view-types").innerHTML = (data.packageTypes || []).filter((t) => t.active || view?.typeIds.includes(t.id)).map((t) => `
    <label class="choice"><input type="checkbox" value="${t.id}" ${view?.typeIds.includes(t.id) ? "checked" : ""}> ${esc(t.name)}</label>`).join("");
  document.getElementById("view-show").innerHTML = Object.entries(VIEW_COLUMNS).map(([k, label]) => `
    <label class="choice"><input type="checkbox" value="${k}" ${(view ? view.show : ["total_bbl", "par_bbl", "pipeline"]).includes(k) ? "checked" : ""}> ${label}</label>`).join("");
  viewForm.name.value = view?.name ?? "";
  viewForm.split.checked = view ? view.splitByPlace : true;
  viewForm.beers.value = view?.beers ?? "stock_or_par";
  viewForm.sort.value = view?.sortMode ?? "az";
  viewDialog.showModal();
}
const checked = (box) => [...document.querySelectorAll(`#${box} input:checked`)].map((i) => i.value);
viewForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const row = { name: viewForm.name.value.trim(), place_ids: checked("view-places"), split_by_place: viewForm.split.checked,
    type_ids: checked("view-types"), show: checked("view-show"), beers: viewForm.beers.value, sort_mode: viewForm.sort.value };
  if (!row.place_ids.length) { alert("Choose at least one place for this view."); return; }
  const id = editingView?.id ?? newId();
  const ok = await save(() => editingView
    ? must(db.from("inventory_views").update(row).eq("id", id))
    : must(db.from("inventory_views").insert({ id, brewery_id: brewery.id, position: views().length, ...row })));
  if (ok) { inventoryView = id; viewDialog.close(); renderInventory(); }
});
document.getElementById("delete-view").addEventListener("click", async () => {
  if (!confirm(`Delete the view "${editingView.name}"? (No stock changes; it's only a way of looking.)`)) return;
  const ok = await save(() => must(db.from("inventory_views").delete().eq("id", editingView.id)));
  if (ok) { inventoryView = null; viewDialog.close(); renderInventory(); }
});

// ----- The Inventory screen -----
let inventoryPlace = "all";
const openBeers = new Set(); // beers whose batches are showing

function renderInventory() {
  const places = activePlaces();
  if (inventoryPlace !== "all" && !places.some((p) => p.id === inventoryPlace)) inventoryPlace = "all";
  if (inventoryView && !views().some((v) => v.id === inventoryView)) inventoryView = null;
  document.getElementById("inv-places").innerHTML =
    views().map((v) => `<button type="button" role="tab" class="view-chip" aria-selected="${v.id === inventoryView}" data-view="${v.id}">${esc(v.name)}</button>`).join("") +
    [{ id: "all", label: "All places" }, ...places.map((p) => ({ id: p.id, label: placeName(p.id) }))]
      .map((p) => `<button type="button" role="tab" aria-selected="${!inventoryView && p.id === inventoryPlace}" data-place="${p.id}">${esc(p.label)}</button>`).join("") +
    (can("inventory") ? `<button type="button" class="add-view" data-view-edit="${inventoryView || ""}">${inventoryView ? "Edit view" : "+ View"}</button>` : "");
  // A view: its own sheet, instead of the place sections
  const view = views().find((v) => v.id === inventoryView);
  for (const id of ["inv-lines", "inv-pars", "inv-deck"]) if (view) document.getElementById(id).hidden = true;
  document.querySelector(".sort-bar").hidden = !!view;
  if (view) {
    renderViewTable(view);
    renderRecent();
    if (inventoryTab === "raw") renderRaw();
    return;
  }
  document.getElementById("inv-pars").hidden = false;

  const rows = stockOnHand().filter((r) => inventoryPlace === "all" || r.placeId === inventoryPlace);
  const typeIds = [...new Set(rows.map((r) => r.typeId))];
  const types = (data.packageTypes || []).filter((t) => typeIds.includes(t.id) || (t.active && !rows.length));
  const beers = orderBeers(inventoryPlace === "all" ? null : inventoryPlace, [...new Set(rows.map((r) => r.beerId))]).map(findBeer).filter(Boolean);
  const bbl = (rs) => rs.reduce((sum, r) => sum + r.count * (typeOf(r.typeId)?.volumeBbl || 0), 0);
  const cell = (n) => `<td class="${n ? "" : "zero"}">${n ? +n.toFixed(2) : "–"}</td>`;
  const head = `<tr><th>Beer</th>${types.map((t) => `<th>${esc(t.name)}</th>`).join("")}<th>Total</th></tr>`;
  const body = beers.map((beer) => {
    const mine = rows.filter((r) => r.beerId === beer.id);
    let html = `<tr class="beer-row" data-inv-beer="${beer.id}"><td><strong>${esc(beer.name)}</strong></td>
      ${types.map((t) => cell(sumCount(mine.filter((r) => r.typeId === t.id)))).join("")}<td>${showUnit("volume", bbl(mine))}</td></tr>`;
    if (openBeers.has(beer.id)) {
      // The batches behind it, oldest first (stock from before the app first)
      const batchIds = [...new Set(mine.map((r) => r.batchId))]
        .sort((x, y) => (x ? 1 : 0) - (y ? 1 : 0) || (findBatchById(x)?.brewDate || "").localeCompare(findBatchById(y)?.brewDate || ""));
      html += batchIds.map((id) => {
        const lot = mine.filter((r) => r.batchId === id);
        const b = findBatchById(id);
        const label = b ? `${batchLabel(b)} · brewed ${formatDate(b.brewDate)} (${daysSince(b.brewDate)} days)` : "From before the app";
        return `<tr class="batches"><td>${esc(label)}</td>${types.map((t) => cell(sumCount(lot.filter((r) => r.typeId === t.id)))).join("")}<td>${showUnit("volume", bbl(lot))}</td></tr>`;
      }).join("");
    }
    return html;
  }).join("");
  const foot = beers.length ? `<tr><td><strong>Total</strong></td>${types.map((t) => cell(sumCount(rows.filter((r) => r.typeId === t.id)))).join("")}<td><strong>${showUnit("volume", bbl(rows))}</strong></td></tr>` : "";
  document.getElementById("inv-table").innerHTML = beers.length
    ? `<table class="inv-table">${head}${body}${foot}</table>`
    : `<p class="muted">Nothing on hand${inventoryPlace === "all" ? "" : " here"}. Packaging puts kegs and cases into stock; a count adds what's already on the shelf.</p>`;

  renderSortChoice();
  renderLines();
  renderPars();
  if (inventoryTab === "raw") renderRaw();
  renderRecent();
}

// Recent: one line per action (a count sheet or a move is one action)
function renderRecent() {
  const groups = new Map();
  for (const m of [...(data.stockMoves || [])].reverse()) {
    const key = m.groupId || m.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
    if (groups.size > 15) { groups.delete(key); break; }
  }
  document.getElementById("inv-recent").innerHTML = [...groups.values()].map((ms) => {
    const m = ms[0];
    const what = summarizeStock(ms);
    const verb = { packaged: `Packaged into ${placeName(m.toPlaceId)}`, moved: `Moved ${placeName(m.fromPlaceId)} → ${placeName(m.toPlaceId)}`,
      removed: `${REMOVAL_KINDS[m.removalKind] || "Removed"} from ${placeName(m.fromPlaceId)}`, returned: `Returned to ${placeName(m.toPlaceId)}`,
      counted: `Count found more in ${placeName(m.toPlaceId)}` }[m.kind];
    const why = [m.notes && m.notes !== "count" ? m.notes : "", m.account].filter(Boolean).join(" · ");
    return `<li class="item"><span class="when">${formatDate(m.occurredOn)}</span> · ${esc(verb)}: ${what}${why ? ` <span class="muted">(${esc(why)})</span>` : ""}</li>`;
  }).join("") || `<li class="item muted">Nothing yet.</li>`;
}
// "12 × ½ bbl keg Lager, 3 × ⅙ bbl keg Lager"
function summarizeStock(moves) {
  const totals = new Map();
  for (const m of moves) {
    const key = `${m.beerId}|${m.packageTypeId}`;
    totals.set(key, (totals.get(key) || 0) + m.count);
  }
  return [...totals].map(([key, n]) => {
    const [beer, type] = key.split("|");
    return `${+n.toFixed(2)} × ${esc(typeOf(type)?.name ?? "package")} ${esc(findBeer(beer)?.name ?? "")}`;
  }).join(", ");
}

document.getElementById("inv-places").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-place]");
  if (chip) { inventoryPlace = chip.dataset.place; inventoryView = null; renderInventory(); }
  const viewChip = e.target.closest("[data-view]");
  if (viewChip) { inventoryView = viewChip.dataset.view; inventoryPlace = "all"; renderInventory(); }
  const edit = e.target.closest("[data-view-edit]");
  if (edit) openViewEditor(views().find((v) => v.id === edit.dataset.viewEdit) || null);
});
document.getElementById("inv-table").addEventListener("click", (e) => {
  const row = e.target.closest("[data-inv-beer]");
  if (!row) return;
  const id = row.dataset.invBeer;
  if (openBeers.has(id)) openBeers.delete(id); else openBeers.add(id);
  renderInventory();
});
document.getElementById("open-inventory").addEventListener("click", () => { showView("inventory"); renderInventory(); showInventoryTab(); });

// ----- A count sheet for one place -----
const countDialog = document.getElementById("count-editor");
const countForm = document.getElementById("count-form");
let countBeers = []; // beers on the sheet (those with stock there, plus any added)

// The brewery's reasons for stock changes, offered in Count / Move / Remove (and required if it says so)
function prepareReason(input) {
  document.getElementById("stock-reason-list").innerHTML = (brewery.stockReasons || []).map((r) => `<option value="${esc(r)}">`).join("");
  input.required = !!brewery.requireStockReason;
  input.closest("label").firstChild.textContent = brewery.requireStockReason ? "Reason (required) " : "Reason ";
}
const reasonsForm = document.getElementById("reasons-form");
function renderReasons() {
  const allowed = can("manage_settings");
  if (document.activeElement !== reasonsForm.reasons) reasonsForm.reasons.value = (brewery.stockReasons || []).join("\n");
  reasonsForm.required.checked = !!brewery.requireStockReason;
  for (const el of reasonsForm.elements) el.disabled = !allowed;
  document.getElementById("reasons-note").hidden = allowed;
}
reasonsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const reasons = [...new Set(reasonsForm.reasons.value.split("\n").map((r) => r.trim()).filter(Boolean))];
  await save(async () => {
    const saved = await must(db.from("breweries").update({ stock_reasons: reasons, require_stock_reason: reasonsForm.required.checked })
      .eq("id", brewery.id).select("id"));
    if (!saved.length) throw new Error("You don't have permission to change these.");
  });
});

function openCountSheet() {
  const places = activePlaces();
  if (!places.length) { alert("Add a stock place first (Settings → Equipment)."); return; }
  countForm.reset();
  countForm.placeId.innerHTML = places.map((p) => `<option value="${p.id}">${esc(placeName(p.id))}</option>`).join("");
  countForm.placeId.value = inventoryPlace !== "all" ? inventoryPlace : places[0].id;
  countForm.occurredOn.value = today();
  prepareReason(countForm.reason);
  startCountSheet();
  countDialog.showModal();
}
function startCountSheet() {
  const place = (data.places || []).find((p) => p.id === countForm.placeId.value);
  countForm.drop.value = place?.kind === "taproom" ? "taproom" : "unknown";
  // Beers with stock here, plus (a taproom) every beer on a line, so the sheet walks the bar
  countBeers = [...new Set([...stockOnHand().filter((r) => r.placeId === place.id && r.count > 0).map((r) => r.beerId),
    ...placeLines(place.id).filter((l) => l.beerId).map((l) => l.beerId)])];
  renderCountSheet();
}
const expectedAt = (placeId, beerId, typeId) =>
  sumCount(stockOnHand().filter((r) => r.placeId === placeId && r.beerId === beerId && r.typeId === typeId));

function renderCountSheet() {
  const placeId = countForm.placeId.value;
  const types = (data.packageTypes || []).filter((t) => t.active || countBeers.some((b) => expectedAt(placeId, b, t.id)));
  const beers = orderBeers(placeId, countBeers).map(findBeer).filter(Boolean);
  const lineNos = (id) => placeLines(placeId).filter((l) => l.beerId === id).map((l) => l.lineNo).join(", ");
  document.getElementById("count-sheet").innerHTML = beers.length ? `<table class="inv-table">
    <tr><th>Beer</th>${types.map((t) => `<th>${esc(t.name)}</th>`).join("")}</tr>
    ${beers.map((beer) => `<tr><td>${lineNos(beer.id) ? `<span class="line-no">${lineNos(beer.id)}</span> ` : ""}${esc(beer.name)}</td>${types.map((t) => {
      const n = +expectedAt(placeId, beer.id, t.id).toFixed(2);
      return `<td><input type="number" min="0" step="any" inputmode="decimal" value="${n}" data-expected="${n}" data-beer="${beer.id}" data-type="${t.id}" aria-label="${esc(beer.name)}, ${esc(t.name)}"></td>`;
    }).join("")}</tr>`).join("")}
  </table>` : `<p class="muted">Nothing expected here. Add the beers you find below.</p>`;
  const others = data.beers.filter((b) => !countBeers.includes(b.id)).sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById("count-add").innerHTML = `<option value="">Choose a beer…</option>` + others.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  updateCountSummary();
}
function countChanges() {
  return [...document.querySelectorAll("#count-sheet input")]
    .filter((i) => i.value !== "" && Math.abs(Number(i.value) - Number(i.dataset.expected)) > 1e-9)
    .map((i) => ({ beer: i.dataset.beer, type: i.dataset.type, counted: Number(i.value), expected: Number(i.dataset.expected) }));
}
function updateCountSummary() {
  document.querySelectorAll("#count-sheet input").forEach((i) => i.classList.toggle("changed", i.value !== "" && Number(i.value) !== Number(i.dataset.expected)));
  const changes = countChanges();
  document.getElementById("count-summary").textContent = changes.length
    ? `${changes.length} ${changes.length === 1 ? "difference" : "differences"}: ` + changes.map((c) =>
        `${c.counted > c.expected ? "+" : "−"}${+Math.abs(c.counted - c.expected).toFixed(2)} ${typeOf(c.type)?.name} ${findBeer(c.beer)?.name}`).join(", ")
    : "Everything matches so far.";
}
countForm.addEventListener("input", updateCountSummary);
countForm.placeId.addEventListener("change", startCountSheet);
document.getElementById("count-add").addEventListener("change", (e) => {
  if (!e.target.value) return;
  countBeers.push(e.target.value);
  renderCountSheet();
});
document.getElementById("inv-count").addEventListener("click", openCountSheet);

countForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const changes = countChanges();
  if (!changes.length) { countDialog.close(); return; }
  const placeId = countForm.placeId.value;
  const ok = await saveOrKeep("count", {
    p_id: newId(), p_brewery_id: brewery.id, p_place_id: placeId, p_date: countForm.occurredOn.value,
    p_lines: changes.map(({ beer, type, counted }) => ({ beer, type, counted })), p_drop: countForm.drop.value,
    p_notes: countForm.reason.value.trim() || "count",
  }, `Count of ${placeName(placeId)} (${changes.length} ${changes.length === 1 ? "difference" : "differences"})`);
  if (ok) countDialog.close();
});

// ----- Moving and removing stock -----
const stockDialog = document.getElementById("stock-editor");
const stockForm = document.getElementById("stock-form");
let stockMode = "move";

function openStockEditor(mode) {
  const places = activePlaces();
  if (!places.length) { alert("Add a stock place first (Settings → Equipment)."); return; }
  stockMode = mode;
  stockForm.reset();
  document.getElementById("stock-title").textContent = mode === "move" ? "Move stock" : "Remove stock";
  document.getElementById("stock-to-field").hidden = mode !== "move";
  document.getElementById("stock-kind-field").hidden = mode !== "remove";
  const options = places.map((p) => `<option value="${p.id}">${esc(placeName(p.id))}</option>`).join("");
  stockForm.fromPlaceId.innerHTML = options;
  stockForm.toPlaceId.innerHTML = options;
  // From: the place being looked at, or the first storage place; to: a taproom if there is one
  stockForm.fromPlaceId.value = inventoryPlace !== "all" ? inventoryPlace : (places.find((p) => p.kind === "storage") || places[0]).id;
  const to = places.find((p) => p.id !== stockForm.fromPlaceId.value && p.kind === "taproom") || places.find((p) => p.id !== stockForm.fromPlaceId.value);
  if (to) stockForm.toPlaceId.value = to.id;
  stockForm.occurredOn.value = today();
  prepareReason(stockForm.reason);
  fillStockBeers();
  stockDialog.showModal();
}
function fillStockBeers() {
  const from = stockForm.fromPlaceId.value;
  const ids = [...new Set(stockOnHand().filter((r) => r.placeId === from && r.count > 0).map((r) => r.beerId))];
  const beers = ids.map(findBeer).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  stockForm.beerId.innerHTML = beers.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("") || `<option value="">Nothing on hand here</option>`;
  fillStockRows();
}
function fillStockRows() {
  const from = stockForm.fromPlaceId.value, beer = stockForm.beerId.value;
  const here = stockOnHand().filter((r) => r.placeId === from && r.beerId === beer && r.count > 0);
  const types = [...new Set(here.map((r) => r.typeId))].map((id) => typeOf(id)).filter(Boolean);
  document.getElementById("stock-rows").innerHTML = types.map((t) => `<label class="package-row"><span>${esc(t.name)}
      <span class="muted">${+sumCount(here.filter((r) => r.typeId === t.id)).toFixed(2)} on hand</span></span>
      <input type="number" min="0" step="any" inputmode="decimal" placeholder="0" data-stock-type="${t.id}" aria-label="How many ${esc(t.name)}"></label>`).join("");
  updateStockSummary();
}
const stockLines = () => [...document.querySelectorAll("[data-stock-type]")]
  .map((i) => ({ beer: stockForm.beerId.value, type: i.dataset.stockType, count: Number(i.value) || 0 })).filter((l) => l.count > 0);
function updateStockSummary() {
  const lines = stockLines();
  const bbl = lines.reduce((sum, l) => sum + l.count * (typeOf(l.type)?.volumeBbl || 0), 0);
  document.getElementById("stock-summary").textContent = lines.length ? `= ${showUnit("volume", bbl)}` : "";
}
stockForm.fromPlaceId.addEventListener("change", fillStockBeers);
stockForm.beerId.addEventListener("change", fillStockRows);
stockForm.addEventListener("input", updateStockSummary);
document.getElementById("inv-move").addEventListener("click", () => openStockEditor("move"));
document.getElementById("inv-remove").addEventListener("click", () => openStockEditor("remove"));

stockForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const lines = stockLines();
  if (!lines.length) { alert("Enter how many."); return; }
  const from = stockForm.fromPlaceId.value, to = stockMode === "move" ? stockForm.toPlaceId.value : null;
  if (to && to === from) { alert("Choose two different places."); return; }
  for (const l of lines) {
    const have = sumCount(stockOnHand().filter((r) => r.placeId === from && r.beerId === l.beer && r.typeId === l.type));
    if (l.count > have + 1e-9) { alert(`There are only ${+have.toFixed(2)} × ${typeOf(l.type).name} there. Count the place first if the numbers are off.`); return; }
  }
  const removal = stockMode === "remove" ? stockForm.removal.value : null;
  const ok = await saveOrKeep("stock", {
    p_id: newId(), p_brewery_id: brewery.id, p_date: stockForm.occurredOn.value, p_from: from, p_to: to, p_removal: removal,
    p_lines: lines, p_account: stockForm.account.value.trim(), p_notes: stockForm.reason.value.trim(),
  }, `${to ? "Move" : REMOVAL_KINDS[removal]}: ${summarizeStock(lines.map((l) => ({ beerId: l.beer, packageTypeId: l.type, count: l.count })))}`);
  if (ok) stockDialog.close();
});

// ----- Pars, restocking, and "on deck" -----
// A par says how much of a beer a place should have (barrels and/or cases); with no place, it's the
// brewery-wide par. Over / under, what to bring up, and what's on deck are worked out from the pars
// and the stock.
const parFor = (placeId, beerId) => (data.pars || []).find((p) => (p.placeId ?? null) === (placeId ?? null) && p.beerId === beerId);
// Barrels and cases of a beer in a place (or everywhere, for null)
function stockOf(placeId, beerId) {
  const rows = stockOnHand().filter((r) => r.beerId === beerId && r.count > 0 && (placeId == null || r.placeId === placeId));
  return {
    bbl: rows.reduce((sum, r) => sum + r.count * (typeOf(r.typeId)?.volumeBbl || 0), 0),
    cases: sumCount(rows.filter((r) => typeOf(r.typeId)?.kind === "case")),
  };
}

// What to bring to a place to reach its par: from storage places (same location first), the
// package type there's most of. [{ from, type, count }]
function restockFor(placeId, beerId, underBbl, underCases) {
  const place = (data.places || []).find((p) => p.id === placeId);
  const sources = activePlaces().filter((p) => p.id !== placeId && p.kind === "storage")
    .sort((a, b) => (b.locationId === place?.locationId) - (a.locationId === place?.locationId));
  const pick = (isCase, needed, perUnit) => {
    for (const source of sources) {
      const rows = stockOnHand().filter((r) => r.placeId === source.id && r.beerId === beerId && r.count > 0 &&
        ((typeOf(r.typeId)?.kind === "case") === isCase));
      if (!rows.length) continue;
      const byType = new Map();
      for (const r of rows) byType.set(r.typeId, (byType.get(r.typeId) || 0) + r.count);
      const [type, available] = [...byType].sort((a, b) => b[1] - a[1])[0];
      const count = Math.min(available, Math.ceil(needed / perUnit(type) - 1e-9));
      if (count > 0) return { from: source.id, type, count };
    }
    return null;
  };
  return [
    underBbl > 0 ? pick(false, underBbl, (t) => typeOf(t).volumeBbl) : null,
    underCases > 0 ? pick(true, underCases, () => 1) : null,
  ].filter(Boolean);
}

function renderPars() {
  const placeId = inventoryPlace === "all" ? null : inventoryPlace;
  const place = (data.places || []).find((p) => p.id === placeId);
  const canSet = can("inventory");
  const beers = orderBeers(placeId, data.beers.filter((b) => parFor(placeId, b.id)).map((b) => b.id)).map(findBeer);
  const signed = (n, unit) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${unit(Math.abs(n))}`;
  const bblText = (n) => showUnit("volume", n);
  const caseText = (n) => `${+n.toFixed(2)} cases`;
  const rows = beers.map((beer) => {
    const par = parFor(placeId, beer.id), have = stockOf(placeId, beer.id);
    const overBbl = par.parBbl != null ? have.bbl - par.parBbl : null;
    const overCases = par.parCases != null ? have.cases - par.parCases : null;
    const under = (overBbl ?? 0) < -1e-9 || (overCases ?? 0) < -1e-9;
    const fixes = placeId && under ? restockFor(placeId, beer.id, -(overBbl ?? 0), -(overCases ?? 0)) : [];
    return `<li class="item par-row${under ? " under" : ""}">
      <div><strong>${esc(beer.name)}</strong>
        <span class="muted">${par.parBbl != null ? `${bblText(have.bbl)} of ${bblText(par.parBbl)} (${signed(overBbl, bblText)})` : ""}
        ${par.parCases != null ? `${par.parBbl != null ? " · " : ""}${caseText(have.cases)} of ${caseText(par.parCases)} (${signed(overCases, caseText)})` : ""}</span></div>
      ${fixes.map((f) => `<div class="restock">Bring up ${+f.count.toFixed(2)} × ${esc(typeOf(f.type).name)} from ${esc(placeName(f.from))}
        ${canSet ? `<button type="button" class="btn small" data-bring='${JSON.stringify({ ...f, to: placeId, beer: beer.id })}'>Bring up</button>` : ""}</div>`).join("")}
      ${placeId && under && !fixes.length ? `<div class="restock muted">None in storage to bring up.</div>` : ""}
    </li>`;
  }).join("");
  document.getElementById("inv-pars").innerHTML = `
    <div class="section-head"><h2>${placeId ? `Pars at ${esc(placeName(placeId))}` : "Brewery-wide pars"}</h2>
      ${canSet ? `<button type="button" class="btn small" id="set-pars">Set pars</button>` : ""}</div>
    <ul class="plain log-list">${rows || `<li class="item muted">No pars set${placeId ? " here" : ""}.${canSet ? " Tap “Set pars” to add some." : ""}</li>`}</ul>`;

  // On deck: for a taproom, what's in storage that isn't here yet
  const deck = document.getElementById("inv-deck");
  deck.hidden = place?.kind !== "taproom";
  if (deck.hidden) return;
  const inStorage = stockOnHand().filter((r) => r.count > 0 && (data.places || []).find((p) => p.id === r.placeId)?.kind === "storage");
  // Already here: kegs on hand, or on one of its draft lines
  const here = new Set([...stockOnHand().filter((r) => r.placeId === placeId && r.count > 0).map((r) => r.beerId),
    ...placeLines(placeId).filter((l) => l.beerId).map((l) => l.beerId)]);
  const waiting = [...new Set(inStorage.map((r) => r.beerId))].filter((id) => !here.has(id)).map(findBeer).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  deck.innerHTML = `<h2>On deck for ${esc(placeName(placeId))}</h2>
    <p class="muted">Beers in storage that aren't here yet.</p>
    <ul class="plain log-list">${waiting.map((beer) => {
      const where = [...new Set(inStorage.filter((r) => r.beerId === beer.id).map((r) => r.placeId))];
      return `<li class="item"><strong>${esc(beer.name)}</strong> <span class="muted">${showUnit("volume", stockOf(null, beer.id).bbl)} · ${where.map((p) => esc(placeName(p))).join(", ")}</span></li>`;
    }).join("") || `<li class="item muted">Everything in storage is already here.</li>`}</ul>`;
}

document.getElementById("inv-pars").addEventListener("click", (e) => {
  if (e.target.closest("#set-pars")) openParsEditor();
  const bring = e.target.closest("[data-bring]");
  if (bring) {
    const f = JSON.parse(bring.dataset.bring);
    openStockEditor("move");
    stockForm.fromPlaceId.value = f.from;
    fillStockBeers();
    stockForm.toPlaceId.value = f.to;
    stockForm.beerId.value = f.beer;
    fillStockRows();
    const input = document.querySelector(`[data-stock-type="${f.type}"]`);
    if (input) input.value = f.count;
    if (!stockForm.reason.value && (brewery.stockReasons || []).length) stockForm.reason.placeholder = brewery.stockReasons[0];
    updateStockSummary();
  }
});

// Setting pars for a place (or the whole brewery): every beer, with boxes for barrels and cases
const parsDialog = document.getElementById("pars-editor");
const parsForm = document.getElementById("pars-form");
function openParsEditor() {
  const placeId = inventoryPlace === "all" ? null : inventoryPlace;
  document.getElementById("pars-title").textContent = placeId ? `Pars at ${placeName(placeId)}` : "Brewery-wide pars";
  // Beers with stock or a par first, then the rest
  const relevant = (b) => !!parFor(placeId, b.id) || stockOf(null, b.id).bbl > 0;
  const beers = [...data.beers].sort((a, b) => relevant(b) - relevant(a) || a.name.localeCompare(b.name));
  document.getElementById("pars-rows").innerHTML = `<table class="inv-table">
    <tr><th>Beer</th><th>Par (<span class="volume-unit"></span>)</th><th>Par (cases)</th></tr>
    ${beers.map((b) => {
      const par = parFor(placeId, b.id);
      return `<tr><td>${esc(b.name)}</td>
        <td><input type="number" min="0" step="any" inputmode="decimal" data-par-beer="${b.id}" data-par="bbl" value="${par?.parBbl != null ? toShown("volume", par.parBbl) : ""}"></td>
        <td><input type="number" min="0" step="any" inputmode="decimal" data-par-beer="${b.id}" data-par="cases" value="${par?.parCases ?? ""}"></td></tr>`;
    }).join("")}</table>`;
  applyUnitLabels();
  parsDialog.showModal();
}
parsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const placeId = inventoryPlace === "all" ? null : inventoryPlace;
  const upserts = [], removals = [];
  for (const beer of data.beers) {
    const bblBox = parsForm.querySelector(`[data-par-beer="${beer.id}"][data-par="bbl"]`);
    const caseBox = parsForm.querySelector(`[data-par-beer="${beer.id}"][data-par="cases"]`);
    const bbl = bblBox.value === "" ? null : fromShown("volume", bblBox.value);
    const cases = caseBox.value === "" ? null : Number(caseBox.value);
    const existing = parFor(placeId, beer.id);
    if (bbl == null && cases == null) { if (existing) removals.push(existing.id); continue; }
    const same = existing && Math.abs((existing.parBbl ?? -1) - (bbl ?? -1)) < 1e-4 && (existing.parCases ?? null) === cases;
    if (!same) upserts.push({ brewery_id: brewery.id, place_id: placeId, beer_id: beer.id, par_bbl: bbl, par_cases: cases });
  }
  const ok = await save(async () => {
    if (upserts.length) await must(db.from("stock_pars").upsert(upserts, { onConflict: "brewery_id,place_id,beer_id" }));
    if (removals.length) await must(db.from("stock_pars").delete().in("id", removals));
  });
  if (ok) parsDialog.close();
});

// ----- Raw materials (Inventory, step 3) -----
// On hand by lot = received - used on batches (additions with the item's name and lot) + count
// corrections. Usage is read straight from the batches' additions, so fixing an addition fixes stock.
const RAW_KINDS = { malt: "Malt / grain", adjunct: "Adjunct / sugar", salt: "Water salt / acid", hop: "Hops", finings: "Finings / nutrient",
  yeast: "Yeast", chemical: "Chemical / cleaning", other: "Other" };
const MASS_LB = { lb: 1, kg: 2.20462, oz: 1 / 16, g: 0.00220462 };
const VOLUME_GAL = { gal: 1, l: 0.264172, ml: 0.000264172 };
// An amount in another unit (lb ⇄ kg ⇄ oz ⇄ g, gal ⇄ L ⇄ mL); null if they don't mix (kg and gal)
function convertAmount(amount, from, to) {
  if (amount == null) return null;
  if (from === to) return amount;
  if (MASS_LB[from] && MASS_LB[to]) return amount * MASS_LB[from] / MASS_LB[to];
  if (VOLUME_GAL[from] && VOLUME_GAL[to]) return amount * VOLUME_GAL[from] / VOLUME_GAL[to];
  return null;
}
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Per lot of an item: { lot, received, used, adjusted, onHand, receivedOn, uses: [additions] }
function rawLots(item) {
  const lots = new Map();
  const lot = (key) => {
    if (!lots.has(key)) lots.set(key, { lot: key, received: 0, used: 0, adjusted: 0, receivedOn: null, uses: [] });
    return lots.get(key);
  };
  for (const r of (data.rawReceipts || []).filter((x) => x.itemId === item.id)) {
    const l = lot(r.lot.trim());
    l.received += r.amount;
    if (!l.receivedOn || r.receivedOn < l.receivedOn) l.receivedOn = r.receivedOn;
  }
  for (const a of (data.rawAdjustments || []).filter((x) => x.itemId === item.id)) lot(a.lot.trim()).adjusted += a.change;
  for (const add of data.additions.filter((x) => sameName(x.name, item.name))) {
    const used = convertAmount(add.amount, add.unit, item.unit);
    const l = lot((add.lot || "").trim());
    if (used != null) l.used += used;
    l.uses.push(add);
  }
  return [...lots.values()].map((l) => ({ ...l, onHand: l.received - l.used + l.adjusted }))
    .sort((a, b) => (a.receivedOn || "9").localeCompare(b.receivedOn || "9"));
}
// "687.5 lb (12.5 sacks)"
function rawAmount(item, amount) {
  const base = `${+amount.toFixed(2)} ${item.unit}`;
  if (!item.packSize) return base;
  const packs = +(amount / item.packSize).toFixed(1);
  const name = item.packName || "pack";
  const plural = packs === 1 ? name : /(s|x|z|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`;
  return `${base} (${packs} ${plural})`;
}

let rawOpen = new Set();
function renderRaw() {
  const items = (data.rawItems || []).filter((i) => i.active).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  document.getElementById("raw-list").innerHTML = items.map((item) => {
    const lots = rawLots(item);
    const onHand = lots.reduce((sum, l) => sum + l.onHand, 0);
    const low = item.reorderLevel != null && onHand < item.reorderLevel;
    const lotRows = rawOpen.has(item.id) ? lots.filter((l) => Math.abs(l.onHand) > 1e-6 || l.uses.length).map((l) => `
      <div class="raw-lot"><div><strong>${l.lot ? `Lot ${esc(l.lot)}` : "No lot number"}</strong>
        <span class="muted">${l.receivedOn ? `received ${formatDate(l.receivedOn)} · ` : (l.received ? "" : "no receipt recorded · ")}${esc(rawAmount(item, l.onHand))} on hand</span></div>
        ${l.uses.length ? `<div class="muted">Used in ${[...new Set(l.uses.map((u) => u.batchId))].map(batchLink).join(", ")}</div>` : ""}</div>`).join("") : "";
    return `<li class="item raw-item${low ? " under" : ""}" data-raw-item="${item.id}">
      <div class="tank-row"><span><strong>${esc(item.name)}</strong> <span class="muted">${RAW_KINDS[item.kind]}</span></span>
        <span>${esc(rawAmount(item, onHand))}</span></div>
      ${low ? `<div class="restock">Below the reorder level (${esc(rawAmount(item, item.reorderLevel))})</div>` : ""}${lotRows}</li>`;
  }).join("") || `<li class="item muted">No raw materials yet. Add items, then record what you receive.</li>`;
}
document.getElementById("raw-list").addEventListener("click", (e) => {
  if (e.target.closest("[data-open-batch]")) return;
  const row = e.target.closest("[data-raw-item]");
  if (!row) return;
  const id = row.dataset.rawItem;
  if (rawOpen.has(id)) rawOpen.delete(id); else rawOpen.add(id);
  renderRaw();
});

// Tabs: finished goods / raw materials
let inventoryTab = "finished";
document.getElementById("inv-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-inv-tab]");
  if (!tab) return;
  inventoryTab = tab.dataset.invTab;
  showInventoryTab();
});
function showInventoryTab() {
  document.querySelectorAll("#inv-tabs [data-inv-tab]").forEach((t) => t.setAttribute("aria-selected", t.dataset.invTab === inventoryTab));
  document.getElementById("inv-finished").hidden = inventoryTab !== "finished";
  document.getElementById("inv-raw").hidden = inventoryTab !== "raw";
  if (inventoryTab === "raw") renderRaw();
}

// ----- Receiving -----
const receiveDialog = document.getElementById("receive-editor");
const receiveForm = document.getElementById("receive-form");
const rawItemOptions = () => (data.rawItems || []).filter((i) => i.active).sort((a, b) => a.name.localeCompare(b.name))
  .map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join("");
function openReceive() {
  if (!(data.rawItems || []).some((i) => i.active)) { alert("Add an item first (Items)."); return; }
  receiveForm.reset();
  receiveForm.itemId.innerHTML = rawItemOptions();
  receiveForm.receivedOn.value = today();
  fillReceiveUnits();
  receiveDialog.showModal();
}
function fillReceiveUnits() {
  const item = data.rawItems.find((i) => i.id === receiveForm.itemId.value);
  receiveForm.unit.innerHTML = `<option value="unit">${item.unit}</option>` +
    (item.packSize ? `<option value="pack">${esc(item.packName || "packs")} (${+item.packSize} ${item.unit})</option>` : "");
  receiveForm.unit.value = item.packSize ? "pack" : "unit";
  // Suppliers used before
  document.getElementById("supplier-list").innerHTML = [...new Set((data.rawReceipts || []).map((r) => r.supplier).filter(Boolean))]
    .map((s) => `<option value="${esc(s)}">`).join("");
}
receiveForm.itemId.addEventListener("change", fillReceiveUnits);
receiveForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const item = data.rawItems.find((i) => i.id === receiveForm.itemId.value);
  const amount = Number(receiveForm.amount.value) * (receiveForm.unit.value === "pack" ? item.packSize : 1);
  const ok = await saveOrKeep("receiveRaw", {
    id: newId(), breweryId: brewery.id, itemId: item.id, receivedOn: receiveForm.receivedOn.value, lot: receiveForm.lot.value.trim(),
    amount, supplier: receiveForm.supplier.value.trim(), cost: receiveForm.cost.value === "" ? null : Number(receiveForm.cost.value),
    notes: receiveForm.notes.value.trim(),
  }, `Received ${rawAmount(item, amount)} of ${item.name}`);
  if (ok) receiveDialog.close();
});

// ----- Counting a raw material -----
const rawCountDialog = document.getElementById("raw-count-editor");
const rawCountForm = document.getElementById("raw-count-form");
function openRawCount() {
  if (!(data.rawItems || []).some((i) => i.active)) { alert("Add an item first (Items)."); return; }
  rawCountForm.reset();
  rawCountForm.itemId.innerHTML = rawItemOptions();
  rawCountForm.adjustedOn.value = today();
  fillRawCountLots();
  rawCountDialog.showModal();
}
function fillRawCountLots() {
  const item = data.rawItems.find((i) => i.id === rawCountForm.itemId.value);
  const lots = rawLots(item).filter((l) => Math.abs(l.onHand) > 1e-6 || l.received);
  rawCountForm.lot.innerHTML = lots.map((l) => `<option value="${esc(l.lot)}">${l.lot ? `Lot ${esc(l.lot)}` : "No lot number"} (${esc(rawAmount(item, l.onHand))})</option>`).join("")
    || `<option value="">No lot number</option>`;
  document.getElementById("raw-count-unit").textContent = item.unit;
  updateRawCountNote();
}
function updateRawCountNote() {
  const item = data.rawItems.find((i) => i.id === rawCountForm.itemId.value);
  const expected = rawLots(item).find((l) => l.lot === rawCountForm.lot.value)?.onHand ?? 0;
  const actual = rawCountForm.actual.value === "" ? null : Number(rawCountForm.actual.value);
  document.getElementById("raw-count-note").textContent = actual == null ? `Expected: ${rawAmount(item, expected)}.`
    : `Expected ${rawAmount(item, expected)}; the difference (${actual - expected >= 0 ? "+" : "−"}${+Math.abs(actual - expected).toFixed(2)} ${item.unit}) is recorded.`;
}
rawCountForm.itemId.addEventListener("change", fillRawCountLots);
rawCountForm.addEventListener("input", updateRawCountNote);
rawCountForm.addEventListener("change", updateRawCountNote);
rawCountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const item = data.rawItems.find((i) => i.id === rawCountForm.itemId.value);
  const expected = rawLots(item).find((l) => l.lot === rawCountForm.lot.value)?.onHand ?? 0;
  const change = Number(rawCountForm.actual.value) - expected;
  if (Math.abs(change) < 1e-9) { rawCountDialog.close(); return; }
  const ok = await saveOrKeep("adjustRaw", {
    id: newId(), breweryId: brewery.id, itemId: item.id, lot: rawCountForm.lot.value, adjustedOn: rawCountForm.adjustedOn.value,
    change, reason: rawCountForm.reason.value.trim() || "count",
  }, `Count of ${item.name}`);
  if (ok) rawCountDialog.close();
});

// ----- Items -----
const itemDialog = document.getElementById("raw-item-editor");
const itemForm = document.getElementById("raw-item-form");
let editingItem = null;
function openItems() {
  document.getElementById("raw-items").innerHTML = (data.rawItems || []).sort((a, b) => a.name.localeCompare(b.name)).map((i) => `
    <li class="item"><button type="button" class="row" data-edit-item="${i.id}"><span>${esc(i.name)}${i.active ? "" : " (hidden)"}</span>
      <span class="muted">${RAW_KINDS[i.kind]} · ${i.packSize ? `${esc(i.packName || "pack")} of ${+i.packSize} ${i.unit}` : i.unit}</span></button></li>`).join("");
  editItem(null);
  itemDialog.showModal();
}
function editItem(item) {
  editingItem = item;
  itemForm.reset();
  document.getElementById("raw-item-save").textContent = item ? "Save item" : "Add item";
  if (!item) return;
  itemForm.name.value = item.name; itemForm.kind.value = item.kind; itemForm.unit.value = item.unit;
  itemForm.packName.value = item.packName; itemForm.packSize.value = item.packSize ?? "";
  itemForm.reorderLevel.value = item.reorderLevel ?? ""; itemForm.active.checked = item.active;
}
document.getElementById("raw-items").addEventListener("click", (e) => {
  const row = e.target.closest("[data-edit-item]");
  if (row) editItem(data.rawItems.find((i) => i.id === row.dataset.editItem));
});
itemForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const row = {
    name: itemForm.name.value.trim(), kind: itemForm.kind.value, unit: itemForm.unit.value, pack_name: itemForm.packName.value.trim(),
    pack_size: itemForm.packSize.value === "" ? null : Number(itemForm.packSize.value),
    reorder_level: itemForm.reorderLevel.value === "" ? null : Number(itemForm.reorderLevel.value), active: itemForm.active.checked,
  };
  const ok = await save(() => editingItem
    ? must(db.from("raw_items").update(row).eq("id", editingItem.id))
    : must(db.from("raw_items").insert({ brewery_id: brewery.id, ...row })));
  if (ok) openItems();
});
document.getElementById("raw-receive").addEventListener("click", openReceive);
document.getElementById("raw-count").addEventListener("click", openRawCount);
document.getElementById("raw-items-open").addEventListener("click", openItems);

// Ingredient form: suggest raw material names, and lots of that item that are on hand
function suggestLots() {
  const item = (data.rawItems || []).find((i) => sameName(i.name, additionForm.name.value));
  document.getElementById("addition-lots").innerHTML = item
    ? rawLots(item).filter((l) => l.lot && l.onHand > 1e-6).map((l) => `<option value="${esc(l.lot)}">${esc(rawAmount(item, l.onHand))} on hand</option>`).join("")
    : "";
}

// ----- Draft lines and the order beers are listed in -----
// A taproom's draft lines: numbered, each pouring a beer, something else (a label), empty, or out
// of order. Each place lists its beers A-Z, oldest batch first, in its own order, or (a taproom) by
// draft line. "All places" remembers its choice on this device.
const SORT_MODES = { az: "A–Z", oldest: "Oldest batch first", custom: "Our own order", lines: "Draft line order" };
const placeLines = (placeId) => (data.lines || []).filter((l) => l.placeId === placeId).sort((a, b) => a.lineNo - b.lineNo);
function readAllPlacesSort() {
  try { return localStorage.getItem("brewery-os.inventory-sort") || "az"; } catch { return "az"; }
}
function sortModeFor(placeId) {
  const place = (data.places || []).find((p) => p.id === placeId);
  if (!place) return readAllPlacesSort();
  return place.sortMode === "lines" && place.kind !== "taproom" ? "az" : place.sortMode;
}
// Beer ids in the place's order; beers without a line or a spot go last, A-Z
function orderBeers(placeId, beerIds) {
  const mode = sortModeFor(placeId);
  const place = (data.places || []).find((p) => p.id === placeId);
  const name = (id) => findBeer(id)?.name || "";
  const lineOf = (id) => Math.min(...placeLines(placeId).filter((l) => l.beerId === id).map((l) => l.lineNo), Infinity);
  const spotOf = (id) => { const i = (place?.beerOrder || []).indexOf(id); return i < 0 ? Infinity : i; };
  const oldest = (id) => {
    const dates = stockOnHand().filter((r) => r.beerId === id && r.count > 0 && (!placeId || r.placeId === placeId))
      .map((r) => (r.batchId ? findBatchById(r.batchId)?.brewDate || "~" : "")); // no batch = from before the app = oldest
    return dates.length ? dates.sort()[0] : "~";
  };
  const key = { lines: lineOf, custom: spotOf, oldest }[mode];
  return [...beerIds].sort((a, b) => {
    if (key) {
      const ka = key(a), kb = key(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
    }
    return name(a).localeCompare(name(b));
  });
}

function renderSortChoice() {
  const placeId = inventoryPlace === "all" ? null : inventoryPlace;
  const place = (data.places || []).find((p) => p.id === placeId);
  const select = document.getElementById("inv-sort");
  select.innerHTML = Object.entries(SORT_MODES).filter(([id]) => id !== "lines" || place?.kind === "taproom")
    .filter(([id]) => id !== "custom" || place).map(([id, label]) => `<option value="${id}">${label}</option>`).join("");
  select.value = sortModeFor(placeId);
  select.disabled = !!place && !can("inventory");
  document.getElementById("inv-arrange").hidden = !(place && select.value === "custom" && can("inventory"));
}
document.getElementById("inv-sort").addEventListener("change", async (e) => {
  const placeId = inventoryPlace === "all" ? null : inventoryPlace;
  if (!placeId) {
    try { localStorage.setItem("brewery-os.inventory-sort", e.target.value); } catch { /* fine: just not remembered */ }
    renderInventory();
    return;
  }
  await save(() => must(db.rpc("set_place_order", { p_place_id: placeId, p_sort_mode: e.target.value, p_beer_order: null })));
});

// Arranging a place's own order: up and down
const arrangeDialog = document.getElementById("arrange-editor");
let arranging = [];
function openArrange() {
  const place = data.places.find((p) => p.id === inventoryPlace);
  const withStock = [...new Set(stockOnHand().filter((r) => r.placeId === place.id && r.count > 0).map((r) => r.beerId))];
  arranging = orderBeers(place.id, [...new Set([...place.beerOrder.filter((id) => findBeer(id)), ...withStock])]);
  renderArrange();
  arrangeDialog.showModal();
}
function renderArrange() {
  document.getElementById("arrange-list").innerHTML = arranging.map((id, i) => `<li class="item arrange-row">
    <span>${i + 1}. ${esc(findBeer(id)?.name ?? "")}</span>
    <span class="actions"><button type="button" class="btn small" data-move="${i}" data-dir="-1" ${i ? "" : "disabled"} aria-label="Up">↑</button>
      <button type="button" class="btn small" data-move="${i}" data-dir="1" ${i < arranging.length - 1 ? "" : "disabled"} aria-label="Down">↓</button></span></li>`).join("");
}
document.getElementById("arrange-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-move]");
  if (!b) return;
  const i = Number(b.dataset.move), j = i + Number(b.dataset.dir);
  [arranging[i], arranging[j]] = [arranging[j], arranging[i]];
  renderArrange();
});
document.getElementById("arrange-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await save(() => must(db.rpc("set_place_order", { p_place_id: inventoryPlace, p_sort_mode: "custom", p_beer_order: arranging })));
  if (ok) arrangeDialog.close();
});
document.getElementById("inv-arrange").addEventListener("click", openArrange);

// The draft lines of the taproom being looked at
function renderLines() {
  const place = (data.places || []).find((p) => p.id === inventoryPlace);
  const box = document.getElementById("inv-lines");
  box.hidden = place?.kind !== "taproom";
  if (box.hidden) return;
  const canEdit = can("inventory");
  const lines = placeLines(place.id);
  const here = stockOnHand().filter((r) => r.placeId === place.id && r.count > 0);
  const what = (l) => {
    if (l.status === "beer") {
      const kegs = here.filter((r) => r.beerId === l.beerId);
      const stock = [...new Set(kegs.map((r) => r.typeId))].map((t) => `${+sumCount(kegs.filter((r) => r.typeId === t)).toFixed(2)} × ${esc(typeOf(t)?.name ?? "")}`).join(", ");
      return `<strong>${esc(findBeer(l.beerId)?.name ?? "A beer")}</strong>${stock ? ` <span class="muted">· ${stock} here</span>` : ` <span class="muted">· none here</span>`}`;
    }
    return { other: esc(l.label || "Something else"), empty: `<span class="muted">Empty</span>`, out: `<span class="muted">Out of order</span>` }[l.status];
  };
  const empty = lines.filter((l) => l.status === "empty").length;
  box.innerHTML = `<div class="section-head"><h2>Draft lines</h2>${empty ? `<span class="muted">${empty} empty</span>` : ""}</div>
    <ul class="plain log-list">${lines.map((l) => `<li class="item"><button type="button" class="entry ${canEdit ? "" : "static"}" data-line="${l.id}">
      <span class="line-no">${l.lineNo}</span> ${what(l)}</button></li>`).join("") || `<li class="item muted">No lines yet.</li>`}</ul>
    ${canEdit ? `<div class="actions"><button type="button" class="btn small" id="add-line">+ Add a line</button>
      ${lines.length && lines.at(-1).status === "empty" ? `<button type="button" class="btn small" id="remove-line">Remove line ${lines.at(-1).lineNo}</button>` : ""}</div>` : ""}`;
}

const lineDialog = document.getElementById("line-editor");
const lineForm = document.getElementById("line-form");
let editingLine = null;
function openLineEditor(line) {
  editingLine = line;
  const placeId = line.placeId;
  document.getElementById("line-title").textContent = `Line ${line.lineNo}`;
  // Beers: those here first, then those in storage (on deck), then the rest
  const here = new Set(stockOnHand().filter((r) => r.placeId === placeId && r.count > 0).map((r) => r.beerId));
  const stored = new Set(stockOnHand().filter((r) => r.count > 0).map((r) => r.beerId));
  const group = (label, ids) => ids.length ? `<optgroup label="${label}">${ids.map((id) => `<option value="${id}">${esc(findBeer(id).name)}</option>`).join("")}</optgroup>` : "";
  const byName = (ids) => [...ids].filter(findBeer).sort((a, b) => findBeer(a).name.localeCompare(findBeer(b).name));
  lineForm.beerId.innerHTML = group("Here", byName(here)) + group("In storage", byName([...stored].filter((id) => !here.has(id))))
    + group("Others", byName(data.beers.map((b) => b.id).filter((id) => !stored.has(id))));
  lineForm.status.value = line.status;
  if (line.beerId) lineForm.beerId.value = line.beerId;
  lineForm.label.value = line.label || "";
  lineDialog.showModal();
}
document.getElementById("inv-lines").addEventListener("click", async (e) => {
  const row = e.target.closest("[data-line]");
  if (row && can("inventory")) openLineEditor(data.lines.find((l) => l.id === row.dataset.line));
  if (e.target.closest("#add-line")) {
    const next = (placeLines(inventoryPlace).at(-1)?.lineNo || 0) + 1;
    await save(() => must(db.from("draft_lines").insert({ brewery_id: brewery.id, place_id: inventoryPlace, line_no: next, status: "empty" })));
  }
  if (e.target.closest("#remove-line")) {
    await save(() => must(db.from("draft_lines").delete().eq("id", placeLines(inventoryPlace).at(-1).id)));
  }
});
lineForm.addEventListener("change", (e) => {
  if (e.target.name === "beerId") lineForm.status.value = "beer";
});
lineForm.label.addEventListener("input", () => { lineForm.status.value = "other"; });
lineForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = lineForm.status.value;
  if (status === "other" && !lineForm.label.value.trim()) { alert("Say what's on this line (like: Wine, Cider)."); return; }
  const ok = await save(() => must(db.from("draft_lines").update({
    status, beer_id: status === "beer" ? lineForm.beerId.value : null, label: status === "other" ? lineForm.label.value.trim() : "",
  }).eq("id", editingLine.id)));
  if (ok) lineDialog.close();
});

// ----- API keys (Settings → API keys) -----
// A key lets an outside tool or AI agent use the API (docs/api.md) as you, with up to all of your
// permissions. It's shown once; only a scrambled copy is kept. Admins see (and can revoke) every
// key in the brewery.
let apiKeys = [];
async function loadApiKeys() {
  try {
    apiKeys = await must(db.from("api_keys").select("id, user_id, name, prefix, permissions, created_at, last_used_at, revoked_at")
      .eq("brewery_id", brewery.id).order("created_at", { ascending: false }));
  } catch { apiKeys = []; }
  renderApiKeys();
}
// The permission boxes are drawn once, when the page opens (redrawing them would undo someone's ticks)
function renderKeyPermissions() {
  const mine = brewery.permissions || [];
  document.getElementById("key-permissions").innerHTML = PERMISSIONS.filter((p) => mine.includes(p.id)).map((p) => `
    <label class="choice"><input type="checkbox" value="${p.id}" checked> ${p.label}</label>`).join("");
}
function renderApiKeys() {
  const who = (id) => (data.members || []).find((m) => m.userId === id)?.email || "someone";
  const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "never");
  document.getElementById("key-list").innerHTML = apiKeys.map((k) => `
    <li class="item"><div><strong>${esc(k.name)}</strong> <span class="muted">${esc(k.prefix)}… · ${esc(who(k.user_id))}</span>
      <div class="muted">${k.revoked_at ? `revoked ${when(k.revoked_at)}` : `made ${when(k.created_at)} · last used ${when(k.last_used_at)}`} ·
        ${k.permissions.length} ${k.permissions.length === 1 ? "permission" : "permissions"}</div></div>
      ${k.revoked_at ? "" : `<button type="button" class="btn small" data-revoke-key="${k.id}">Revoke</button>`}</li>`).join("")
    || `<li class="item muted">No keys yet.</li>`;
}
document.getElementById("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const permissions = [...document.querySelectorAll("#key-permissions input:checked")].map((i) => i.value);
  let key = null;
  const ok = await save(async () => {
    const { data: made, error } = await db.rpc("create_api_key", { p_brewery_id: brewery.id, p_name: e.target.name.value.trim(), p_permissions: permissions });
    if (error) throw error;
    key = made;
  });
  if (!ok || !key) return;
  e.target.reset();
  renderKeyPermissions();
  document.getElementById("new-key").hidden = false;
  document.getElementById("new-key-value").textContent = key;
  await loadApiKeys();
});
document.getElementById("copy-key").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(document.getElementById("new-key-value").textContent); document.getElementById("copy-key").textContent = "Copied"; }
  catch { /* select it instead */ getSelection().selectAllChildren(document.getElementById("new-key-value")); }
});
document.getElementById("key-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-revoke-key]");
  if (!b || !confirm("Revoke this key? Anything using it stops working right away.")) return;
  const ok = await save(async () => { const { error } = await db.rpc("revoke_api_key", { p_id: b.dataset.revokeKey }); if (error) throw error; });
  if (ok) await loadApiKeys();
});

// ----- Export as spreadsheets (CSV) -----
// "Nobody adopts software they can't leave." Every list as a CSV file (opens in Excel or Google
// Sheets), with plain names (not ids) and the brewery's units in the column names, or all of them
// in one zip file. (The JSON backup above is the full-fidelity copy; these are for people.)
function csvText(rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const cell = (v) => {
    const text = v == null ? "" : String(v);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  // The byte-order mark makes Excel read accents and ° correctly
  return "﻿" + [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n");
}
function exportLists() {
  const vol = UNIT_INFO.volume[prefs().volumeUnit].label, grav = UNIT_INFO.gravity[prefs().gravityUnit].label,
    temp = UNIT_INFO.temperature[prefs().temperatureUnit].label;
  const v = (bbl) => (bbl == null ? "" : toShown("volume", bbl));
  const g = (sg) => (sg == null ? "" : toShown("gravity", sg));
  const t = (c) => (c == null ? "" : toShown("temperature", c));
  const batch = (id) => findBatchById(id);
  const label = (id) => (batch(id) ? batch(id).batchNumber : "");
  const beerOf = (id) => (batch(id) ? beerName(batch(id)) : "");
  const field = (key) => catalogFields().find((f) => f.key === key);
  const place = (id) => (id ? placeName(id) : "");
  return {
    "tanks": data.tanks.map((tk) => {
      const b = batchInTank(tk.id);
      return { "Tank": tk.name, "Type": labelFrom(TANK_TYPES, tk.type), "Status": labelFrom(TANK_STATUSES, tk.status), "Location": locationName(tk),
        [`Capacity (${vol})`]: v(tk.capacityBbl), "Batch": b?.batchNumber ?? "", "Beer": b ? beerName(b) : "", "Stage": b ? stageLabel(b.stage) : "",
        [`In the tank (${vol})`]: b ? v(tankBalance(b.id, tk.id)) : "" };
    }),
    "beers": data.beers.map((b) => ({ "Beer": b.name, "Style": b.style || "", [`Target OG (${grav})`]: g(b.targetOg), [`Target FG (${grav})`]: g(b.targetFg),
      "Target ABV (%)": abv(b.targetOg, b.targetFg) ? abv(b.targetOg, b.targetFg).toFixed(1) : "" })),
    "batches": data.batches.map((b) => {
      const og = batchOg(b), last = cellarLog(b).filter((c) => c.gravitySg != null).at(-1);
      return { "Batch": b.batchNumber, "Beer": beerName(b), "Brewed": b.brewDate || "", [`Size (${vol})`]: v(b.sizeBbl), "Turns": b.turns,
        "Stage": stageLabel(b.stage), "Since": b.stageStartDate || "", "Tank": b.tankId ? tankName(b.tankId) : "",
        [`In the tank (${vol})`]: b.tankId && isInTank(b) ? v(tankBalance(b.id, b.tankId)) : "", [`OG (${grav})`]: g(og),
        [`Latest gravity (${grav})`]: g(last?.gravitySg), "ABV (%)": og && last ? abv(og, last.gravitySg).toFixed(1) : "" };
    }),
    "batch-history": data.events.map((e) => ({ "Batch": label(e.batchId), "Beer": beerOf(e.batchId), "Date": e.effectiveDate,
      "Stage": stageLabel(e.stage), "Tank": e.tankId ? tankName(e.tankId) : "" })),
    "cellar-log": data.cellar.map((c) => ({ "Batch": label(c.batchId), "Beer": beerOf(c.batchId), "Date": c.occurredOn, "Action": c.action,
      [`Gravity (${grav})`]: g(c.gravitySg), "pH": c.ph ?? "", [`Temperature (${temp})`]: t(c.tempC), "Cellar change": c.cellarChange, "Notes": c.notes })),
    "brew-day-readings": data.readings.map((r) => {
      const f = field(r.fieldKey);
      const shown = f && UNIT_TYPES.includes(f.type) ? toShown(f.type, r.value) : f?.type === "meter" && r.value != null ? +(r.value * 31).toFixed(1) : r.value;
      const unit = !f ? "" : UNIT_TYPES.includes(f.type) ? UNIT_INFO[f.type][prefs()[`${f.type}Unit`]].label : f.type === "meter" ? "gal" : f.unit || "";
      return { "Batch": label(r.batchId), "Beer": beerOf(r.batchId), "Turn": r.turn ?? "whole batch", "Field": f?.label ?? r.fieldKey,
        "Value": r.valueText ?? shown ?? "", "Unit": unit, "Meter start": r.raw?.start ?? "", "Meter end": r.raw?.end ?? "" };
    }),
    "ingredients-and-additions": data.additions.map((a) => ({ "Batch": label(a.batchId), "Beer": beerOf(a.batchId), "Date": a.addedOn,
      "Brew day": a.brewDay ? "yes" : "", "Turn": a.turn ?? "", "Kind": a.kind, "Name": a.name, "Amount": a.amount ?? "", "Unit": a.unit,
      "When": a.timing, "Lot": a.lot, "Notes": a.notes })),
    "volumes": data.movements.map((m) => ({ "Batch": label(m.batchId), "Beer": beerOf(m.batchId), "Date": m.occurredOn, "Kind": m.kind,
      "From tank": m.fromTankId ? tankName(m.fromTankId) : "", "To tank": m.toTankId ? tankName(m.toTankId) : "",
      [`Volume (${vol})`]: v(m.volumeBbl), "Notes": m.notes })),
    "packaging": (data.packageCounts || []).map((c) => {
      const m = data.movements.find((x) => x.id === c.movementId);
      return { "Batch": label(m?.batchId), "Beer": beerOf(m?.batchId), "Date": m?.occurredOn ?? "", "From tank": m?.fromTankId ? tankName(m.fromTankId) : "",
        "Package": typeOf(c.packageTypeId)?.name ?? "", "Count": c.count, [`Volume (${vol})`]: v(c.count * c.unitVolumeBbl) };
    }),
    "finished-goods-on-hand": stockOnHand().filter((r) => r.count > 0).map((r) => ({ "Place": place(r.placeId), "Beer": findBeer(r.beerId)?.name ?? "",
      "Batch": r.batchId ? label(r.batchId) : "from before the app", "Package": typeOf(r.typeId)?.name ?? "", "Count": +r.count.toFixed(3),
      [`Volume (${vol})`]: v(r.count * (typeOf(r.typeId)?.volumeBbl || 0)) })),
    "stock-moves": (data.stockMoves || []).map((m) => ({ "Date": m.occurredOn, "Kind": m.kind, "Removal": m.removalKind ? REMOVAL_KINDS[m.removalKind] : "",
      "Beer": findBeer(m.beerId)?.name ?? "", "Batch": m.batchId ? label(m.batchId) : "", "Package": typeOf(m.packageTypeId)?.name ?? "", "Count": m.count,
      "From": place(m.fromPlaceId), "To": place(m.toPlaceId), "Account": m.account, "Reason": m.notes })),
    "pars": (data.pars || []).map((p) => ({ "Place": p.placeId ? place(p.placeId) : "whole brewery", "Beer": findBeer(p.beerId)?.name ?? "",
      [`Par (${vol})`]: v(p.parBbl), "Par (cases)": p.parCases ?? "" })),
    "draft-lines": (data.lines || []).map((l) => ({ "Place": place(l.placeId), "Line": l.lineNo,
      "Pouring": l.status === "beer" ? findBeer(l.beerId)?.name ?? "" : { other: l.label, empty: "(empty)", out: "(out of order)" }[l.status] })),
    "raw-materials-on-hand": (data.rawItems || []).flatMap((item) => rawLots(item).filter((l) => Math.abs(l.onHand) > 1e-9)
      .map((l) => ({ "Item": item.name, "Kind": RAW_KINDS[item.kind], "Lot": l.lot, "On hand": +l.onHand.toFixed(3), "Unit": item.unit }))),
    "raw-material-deliveries": (data.rawReceipts || []).map((r) => {
      const item = data.rawItems.find((i) => i.id === r.itemId);
      return { "Item": item?.name ?? "", "Date": r.receivedOn, "Lot": r.lot, "Amount": r.amount, "Unit": item?.unit ?? "", "Supplier": r.supplier, "Cost": r.cost ?? "" };
    }),
  };
}
function downloadFile(name, blob) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}
function renderExports() {
  document.getElementById("export-lists").innerHTML = Object.entries(exportLists()).map(([name, rows]) =>
    `<button type="button" class="btn small" data-export="${name}">${name.replace(/-/g, " ")} <span class="muted">(${rows.length})</span></button>`).join("");
}
document.getElementById("export-lists").addEventListener("click", (e) => {
  const b = e.target.closest("[data-export]");
  if (!b) return;
  const rows = exportLists()[b.dataset.export];
  if (!rows.length) { alert("That list is empty."); return; }
  downloadFile(`${slugName(brewery.name)}-${b.dataset.export}-${today()}.csv`, new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }));
});
const slugName = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "brewery";
// Everything, as one zip of CSV files (the zip library loads only when it's needed)
document.getElementById("export-all").addEventListener("click", async () => {
  if (!window.JSZip) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      script.integrity = "sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==";
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = () => reject(new Error("no signal"));
      document.head.append(script);
    }).catch(() => alert("Making a zip file needs signal the first time. The single lists can be downloaded one by one."));
    if (!window.JSZip) return;
  }
  const zip = new JSZip();
  for (const [name, rows] of Object.entries(exportLists())) if (rows.length) zip.file(`${name}.csv`, csvText(rows));
  downloadFile(`${slugName(brewery.name)}-everything-${today()}.zip`, await zip.generateAsync({ type: "blob" }));
});

// ----- Import from a spreadsheet (Settings → Import) -----
// Most small breweries live in spreadsheets; this is the way in. Paste cells, upload a CSV, or
// read a Google Sheet; columns are matched by name (and can be changed); a preview shows every row
// (to create, already there, or a problem) before anything is saved. Numbers are read in the
// brewery's units.
const IMPORT_KINDS = {
  tanks: { label: "Tanks", needs: "manage_equipment", fields: [
    { key: "name", label: "Tank name", required: true, names: ["tank", "name", "vessel"] },
    { key: "type", label: "Type", names: ["type", "kind"] },
    { key: "capacity", label: "Capacity", unit: "volume", names: ["capacity", "size", "volume"] },
    { key: "location", label: "Location", names: ["location", "site", "building"] },
    { key: "status", label: "Status", names: ["status"] }] },
  beers: { label: "Beers", needs: "manage_beers", fields: [
    { key: "name", label: "Beer name", required: true, names: ["beer", "name"] },
    { key: "style", label: "Style", names: ["style"] },
    { key: "og", label: "Target OG", unit: "gravity", names: ["og", "original", "target og"] },
    { key: "fg", label: "Target FG", unit: "gravity", names: ["fg", "final", "target fg"] }] },
  batches: { label: "Batches in tanks now", needs: "start_batch", fields: [
    { key: "number", label: "Batch #", required: true, names: ["batch", "number", "lot"] },
    { key: "beer", label: "Beer", required: true, names: ["beer", "brand", "name"] },
    { key: "tank", label: "Tank", required: true, names: ["tank", "fv", "vessel"] },
    { key: "brewed", label: "Brew date", names: ["brew date", "brewed", "date"] },
    { key: "size", label: "Size", unit: "volume", names: ["size", "volume", "bbl"] },
    { key: "stage", label: "Stage", names: ["stage", "status"] },
    { key: "since", label: "Stage started", names: ["since", "stage date", "started"] }] },
  cellar: { label: "Cellar log entries", needs: "cellar_log", fields: [
    { key: "number", label: "Batch #", required: true, names: ["batch", "number"] },
    { key: "date", label: "Date", required: true, names: ["date", "day"] },
    { key: "action", label: "Action", names: ["action", "ai", "task"] },
    { key: "gravity", label: "Gravity", unit: "gravity", names: ["gravity", "plato", "°p", "sg"] },
    { key: "ph", label: "pH", names: ["ph"] },
    { key: "temp", label: "Temperature", unit: "temperature", names: ["temp", "temperature"] },
    { key: "change", label: "Cellar change", names: ["cellar change", "cc", "change"] },
    { key: "notes", label: "Notes", names: ["notes", "comment"] }] },
};
let importTable = null; // { headers: [...], rows: [[...]] }
let importMap = {};      // field key -> column index (or -1)

// A table from pasted cells (tabs) or CSV (commas or semicolons), quotes and all
function parseTable(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const sep = first.includes("\t") ? "\t" : (first.split(";").length > first.split(",").length ? ";" : ",");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const kept = rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
  return kept.length ? { headers: kept[0], rows: kept.slice(1) } : null;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9°]+/g, " ").trim();
function guessColumns(kind) {
  importMap = {};
  const used = new Set();
  for (const f of IMPORT_KINDS[kind].fields) {
    const options = [norm(f.label), ...f.names.map(norm)];
    let index = importTable.headers.findIndex((h, i) => !used.has(i) && options.includes(norm(h)));
    if (index < 0) index = importTable.headers.findIndex((h, i) => !used.has(i) && options.some((o) => norm(h).includes(o)));
    importMap[f.key] = index;
    if (index >= 0) used.add(index);
  }
}

// Reading values: numbers (with units or commas), dates (2026-10-07, 10/7/2026, 10/7/26), and choices
const readNumber = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
function readDate(s) {
  s = String(s ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
const importChoice = (s, list) => list.find((x) => norm(x.id) === norm(String(s ?? "")) || norm(x.label) === norm(String(s ?? "")) ||
  norm(x.label).startsWith(norm(String(s ?? "")).slice(0, 4)) && norm(String(s ?? "")).length >= 3)?.id ?? null;
const byName = (list, name) => list.find((x) => norm(x.name) === norm(name || ""));

// The plan: one entry per row, { status: "create" | "skip" | "problem", note, values }
function importPlan(kind) {
  const value = (row, key) => (importMap[key] >= 0 ? row[importMap[key]] ?? "" : "");
  const seen = new Set();
  const createBeers = document.getElementById("import-create-beers")?.checked ?? true;
  return importTable.rows.map((row) => {
    const get = (k) => String(value(row, k)).trim();
    const missing = IMPORT_KINDS[kind].fields.filter((f) => f.required && !get(f.key)).map((f) => f.label);
    if (missing.length) return { status: "problem", note: `missing ${missing.join(", ")}` };
    if (kind === "tanks") {
      const name = get("name");
      if (byName(data.tanks, name) || seen.has(norm(name))) return { status: "skip", note: `${name} is already there` };
      seen.add(norm(name));
      const type = get("type") ? importChoice(get("type"), TANK_TYPES) : "fermenter";
      if (!type) return { status: "problem", note: `unknown type "${get("type")}"` };
      const loc = get("location");
      return { status: "create", note: loc && !byName(data.locations, loc) ? `new location "${loc}"` : "",
        values: { name, type, capacityBbl: get("capacity") ? fromShown("volume", readNumber(get("capacity"))) : null, location: loc,
          status: importChoice(get("status"), TANK_STATUSES.filter((s) => s.id !== "occupied")) || "empty" } };
    }
    if (kind === "beers") {
      const name = get("name");
      if (byName(data.beers, name) || seen.has(norm(name))) return { status: "skip", note: `${name} is already there` };
      seen.add(norm(name));
      return { status: "create", note: "", values: { name, style: get("style"),
        targetOg: get("og") ? fromShown("gravity", readNumber(get("og"))) : null, targetFg: get("fg") ? fromShown("gravity", readNumber(get("fg"))) : null } };
    }
    if (kind === "batches") {
      const number = get("number").replace(/^#/, "");
      if (data.batches.some((b) => norm(b.batchNumber) === norm(number)) || seen.has(norm(number))) return { status: "skip", note: `#${number} is already there` };
      const tank = byName(data.tanks, get("tank"));
      if (!tank) return { status: "problem", note: `no tank called "${get("tank")}" (import tanks first)` };
      if (batchInTank(tank.id) || seen.has(`tank:${tank.id}`)) return { status: "problem", note: `${tank.name} already has a batch in it` };
      const beer = byName(data.beers, get("beer"));
      if (!beer && !createBeers) return { status: "problem", note: `no beer called "${get("beer")}"` };
      const stage = get("stage") ? importChoice(get("stage"), STAGES.filter((s) => !["packaged", "used"].includes(s.id))) : "fermenting";
      if (!stage) return { status: "problem", note: `unknown stage "${get("stage")}"` };
      const brewed = get("brewed") ? readDate(get("brewed")) : today();
      if (!brewed) return { status: "problem", note: `can't read the date "${get("brewed")}"` };
      seen.add(norm(number)); seen.add(`tank:${tank.id}`);
      return { status: "create", note: beer ? "" : `new beer "${get("beer")}"`, values: { number, beerName: get("beer"), beerId: beer?.id, tankId: tank.id,
        brewed, sizeBbl: get("size") ? fromShown("volume", readNumber(get("size"))) : null, stage, since: (get("since") && readDate(get("since"))) || brewed } };
    }
    // cellar log
    const number = get("number").replace(/^#/, "");
    const batch = data.batches.find((b) => norm(b.batchNumber) === norm(number));
    if (!batch) return { status: "problem", note: `no batch #${number} (import batches first)` };
    const date = readDate(get("date"));
    if (!date) return { status: "problem", note: `can't read the date "${get("date")}"` };
    const gravity = readNumber(get("gravity")), ph = readNumber(get("ph")), temp = readNumber(get("temp"));
    const same = data.cellar.some((c) => c.batchId === batch.id && c.occurredOn === date && (c.notes || "") === get("notes") && (c.action || "") === get("action"));
    if (same) return { status: "skip", note: "already logged" };
    return { status: "create", note: "", values: { batchId: batch.id, date, action: get("action"), gravitySg: gravity == null ? null : fromShown("gravity", gravity),
      ph, tempC: temp == null ? null : fromShown("temperature", temp), change: get("change"), notes: get("notes") } };
  });
}

function renderImport() {
  const kind = document.getElementById("import-kind").value;
  const def = IMPORT_KINDS[kind];
  document.getElementById("import-units").textContent = `Numbers are read in your units: ${UNIT_INFO.volume[prefs().volumeUnit].label}, ` +
    `${UNIT_INFO.gravity[prefs().gravityUnit].label}, ${UNIT_INFO.temperature[prefs().temperatureUnit].label}. The first row should be the column names.`;
  document.getElementById("import-allowed").hidden = can(def.needs);
  const mapping = document.getElementById("import-mapping"), preview = document.getElementById("import-preview");
  if (!importTable) { mapping.innerHTML = ""; preview.innerHTML = ""; document.getElementById("import-go").disabled = true; return; }
  mapping.innerHTML = `<h3>Columns</h3><div class="import-map">${def.fields.map((f) => `<label>${f.label}${f.required ? " *" : ""}
    <select data-map="${f.key}"><option value="-1">(none)</option>${importTable.headers.map((h, i) => `<option value="${i}" ${importMap[f.key] === i ? "selected" : ""}>${esc(h || `Column ${i + 1}`)}</option>`).join("")}</select></label>`).join("")}</div>
    ${kind === "batches" ? `<label class="choice"><input type="checkbox" id="import-create-beers" ${document.getElementById("import-create-beers")?.checked === false ? "" : "checked"}> Create beers that aren't in the app yet</label>` : ""}`;
  const plan = importPlan(kind);
  const counts = { create: 0, skip: 0, problem: 0 };
  plan.forEach((p) => counts[p.status]++);
  preview.innerHTML = `<h3>Preview</h3>
    <p><strong>${counts.create} to import</strong> · ${counts.skip} already there (skipped) · ${counts.problem} with a problem (skipped)</p>
    <div class="inv-table-wrap"><table class="inv-table import-table"><tr><th>Row</th><th>What happens</th>${importTable.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>
    ${importTable.rows.slice(0, 200).map((r, i) => `<tr class="${plan[i].status}"><td>${i + 2}</td>
      <td class="outcome">${{ create: "✓ import", skip: "skipped", problem: "✗ not imported" }[plan[i].status]}${plan[i].note ? `: ${esc(plan[i].note)}` : ""}</td>
      ${importTable.headers.map((_, j) => `<td>${esc(r[j] ?? "")}</td>`).join("")}</tr>`).join("")}</table></div>
    ${importTable.rows.length > 200 ? `<p class="muted">Showing the first 200 of ${importTable.rows.length} rows.</p>` : ""}`;
  document.getElementById("import-go").disabled = !counts.create || !can(def.needs);
  document.getElementById("import-go").textContent = counts.create ? `Import ${counts.create} ${counts.create === 1 ? "row" : "rows"}` : "Import";
}

function loadImportText(text) {
  importTable = parseTable(text);
  if (!importTable) { alert("Couldn't find any rows in that."); return; }
  guessColumns(document.getElementById("import-kind").value);
  document.getElementById("import-result").textContent = "";
  renderImport();
}
document.getElementById("import-kind").innerHTML = Object.entries(IMPORT_KINDS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join("");
document.getElementById("import-kind").addEventListener("change", () => { if (importTable) guessColumns(document.getElementById("import-kind").value); renderImport(); });
document.getElementById("import-paste").addEventListener("click", () => loadImportText(document.getElementById("import-text").value));
document.getElementById("import-csv").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) loadImportText(await file.text());
  e.target.value = "";
});
document.getElementById("import-sheet").addEventListener("click", async () => {
  const url = document.getElementById("import-sheet-url").value.trim();
  if (!url) return;
  const button = document.getElementById("import-sheet");
  button.disabled = true;
  try {
    const { data: result, error } = await db.functions.invoke("fetch-sheet", { body: { url } });
    if (error) { const body = await error.context?.json?.().catch(() => null); alert(body?.error || "Couldn't read that sheet."); return; }
    loadImportText(result.csv);
  } finally { button.disabled = false; }
});
document.getElementById("import-mapping").addEventListener("change", (e) => {
  const select = e.target.closest("[data-map]");
  if (select) importMap[select.dataset.map] = Number(select.value);
  renderImport();
});

// Saving: one row at a time through the same steps as the app's own forms
document.getElementById("import-go").addEventListener("click", async () => {
  const kind = document.getElementById("import-kind").value;
  const rows = importPlan(kind).filter((p) => p.status === "create").map((p) => p.values);
  if (!confirm(`Import ${rows.length} ${rows.length === 1 ? "row" : "rows"} into ${brewery.name}?`)) return;
  const b = brewery.id;
  let done = 0;
  const progress = document.getElementById("import-result");
  const ok = await save(async () => {
    if (kind === "tanks") {
      const locations = new Map(data.locations.map((l) => [norm(l.name), l.id]));
      for (const name of [...new Set(rows.map((r) => r.location).filter(Boolean))]) {
        if (locations.has(norm(name))) continue;
        const id = newId();
        await must(db.from("locations").insert({ id, brewery_id: b, name }));
        locations.set(norm(name), id);
      }
      await must(db.from("tanks").insert(rows.map((r) => ({ brewery_id: b, name: r.name, type: r.type, status: r.status,
        capacity_bbl: r.capacityBbl, location_id: r.location ? locations.get(norm(r.location)) : null }))));
      done = rows.length;
    }
    if (kind === "beers") {
      const codes = data.beers.map((x) => ({ code: x.code }));
      await must(db.from("beers").insert(rows.map((r) => {
        const code = beerCodeFor(r.name, codes);
        codes.push({ code });
        return { brewery_id: b, code, name: r.name, style: r.style || "", target_og: r.targetOg, target_fg: r.targetFg };
      })));
      done = rows.length;
    }
    if (kind === "batches") {
      const beers = new Map(data.beers.map((x) => [norm(x.name), x.id]));
      const codes = data.beers.map((x) => ({ code: x.code }));
      for (const r of rows) {
        if (!r.beerId && !beers.has(norm(r.beerName))) {
          const id = newId(), code = beerCodeFor(r.beerName, codes);
          codes.push({ code });
          await must(db.from("beers").insert({ id, brewery_id: b, code, name: r.beerName }));
          beers.set(norm(r.beerName), id);
        }
        await must(db.rpc("save_batch", { p_id: newId(), p_brewery_id: b, p_batch_number: r.number, p_beer_id: r.beerId || beers.get(norm(r.beerName)),
          p_brew_date: r.brewed, p_size_bbl: r.sizeBbl, p_stage: r.stage, p_stage_started_on: r.since, p_tank_id: r.tankId, p_action_date: r.since }));
        progress.textContent = `Imported ${++done} of ${rows.length}…`;
      }
    }
    if (kind === "cellar") {
      for (const r of rows) {
        await must(db.rpc("log_cellar_entry", { p_id: newId(), p_brewery_id: b, p_batch_id: r.batchId, p_occurred_on: r.date, p_action: r.action,
          p_gravity_sg: r.gravitySg, p_ph: r.ph, p_temp_c: r.tempC, p_cellar_change: r.change, p_notes: r.notes, p_new_stage: null }));
        progress.textContent = `Imported ${++done} of ${rows.length}…`;
      }
    }
  });
  progress.textContent = ok ? `Imported ${done} ${done === 1 ? "row" : "rows"}.` : `Imported ${done} before a problem; the rest weren't. Fix it and import again (what's in is skipped).`;
  renderImport();
});

// ----- Recipes (Settings → Beers → Recipes) -----
// Simple, as decided: a beer's targets and ingredient list, optionally for one location, adjusted
// by hand (no scaling). Imported from the major brewing tools as BeerXML (BeerSmith, Brewfather,
// Brewer's Friend...). The brew-day sheet copies a recipe's brew-day ingredients.
const recipesOf = (beerId) => (data.recipes || []).filter((r) => r.beerId === beerId);
const recipeIngredients = (recipeId) => (data.recipeIngredients || []).filter((i) => i.recipeId === recipeId).sort((a, b) => a.position - b.position);
// Timings that happen in the cellar, not on brew day (left out when copying to the brew-day sheet)
const isCellarTiming = (timing) => /^(dry hop|fermenter|packaging)/i.test(timing || "");

// BeerXML (version 1): every recipe in the file, in this brewery's units
function parseBeerXml(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("That file isn't readable as BeerXML.");
  const metric = prefs().volumeUnit === "hl";
  const val = (el, tag) => el.querySelector(`:scope > ${tag}`)?.textContent.trim() ?? "";
  const n = (el, tag) => { const v = parseFloat(val(el, tag).replace(",", ".")); return Number.isFinite(v) ? v : null; };
  const weight = (kg, small) => (kg == null ? { amount: null, unit: small ? "oz" : "lb" } : metric
    ? (kg < 1 ? { amount: +(kg * 1000).toFixed(1), unit: "g" } : { amount: +kg.toFixed(3), unit: "kg" })
    : (small || kg < 0.4536 ? { amount: +(kg * 35.274).toFixed(2), unit: "oz" } : { amount: +(kg * 2.20462).toFixed(2), unit: "lb" }));
  const liquid = (l) => (l == null ? { amount: null, unit: "ml" } : l < 1 ? { amount: +(l * 1000).toFixed(0), unit: "ml" } : { amount: +l.toFixed(2), unit: "l" });
  const recipes = [...xml.querySelectorAll("RECIPE")].map((r) => {
    const ingredients = [];
    for (const f of r.querySelectorAll(":scope > FERMENTABLES > FERMENTABLE")) {
      const type = val(f, "TYPE").toLowerCase();
      ingredients.push({ kind: type === "grain" ? "malt" : "adjunct", name: val(f, "NAME"), ...weight(n(f, "AMOUNT")),
        timing: /true/i.test(val(f, "ADD_AFTER_BOIL")) ? "Fermenter" : (type === "grain" || type === "adjunct" ? "Mash" : "Boil") });
    }
    for (const h of r.querySelectorAll(":scope > HOPS > HOP")) {
      const use = val(h, "USE").toLowerCase(), time = n(h, "TIME") || 0;
      const timing = use === "dry hop" ? `Dry hop ${Math.round(time / 1440) || ""} days`.replace("  ", " ") : use === "mash" ? "Mash"
        : use === "first wort" ? "First wort" : use === "aroma" ? (time > 0 ? `Whirlpool ${Math.round(time)} min` : "Flameout") : `Boil ${Math.round(time)} min`;
      ingredients.push({ kind: "hop", name: val(h, "NAME"), ...weight(n(h, "AMOUNT"), true), timing });
    }
    for (const m of r.querySelectorAll(":scope > MISCS > MISC")) {
      const type = val(m, "TYPE").toLowerCase(), use = val(m, "USE").toLowerCase(), time = n(m, "TIME") || 0;
      const kind = type.includes("water") ? "salt" : type.includes("fining") ? "finings" : /spice|herb|flavor/.test(type) ? "spice" : "other";
      const timing = use === "boil" ? `Boil ${Math.round(time)} min` : use === "mash" ? "Mash" : /primary|secondary/.test(use) ? "Fermenter" : use === "bottling" ? "Packaging" : "";
      const amount = /true/i.test(val(m, "AMOUNT_IS_WEIGHT")) ? weight(n(m, "AMOUNT"), true) : liquid(n(m, "AMOUNT"));
      ingredients.push({ kind, name: val(m, "NAME"), ...amount, timing });
    }
    for (const y of r.querySelectorAll(":scope > YEASTS > YEAST")) {
      const lab = [val(y, "LABORATORY"), val(y, "PRODUCT_ID")].filter(Boolean).join(" ");
      ingredients.push({ kind: "yeast", name: lab ? `${val(y, "NAME")} (${lab})` : val(y, "NAME"), amount: null, unit: "each", timing: "Knockout" });
    }
    const liters = n(r, "BATCH_SIZE");
    const ibu = parseFloat((val(r, "IBU") || val(r, "EST_IBU")).replace(",", "."));
    return { name: val(r, "NAME") || "Recipe", style: r.querySelector(":scope > STYLE > NAME")?.textContent.trim() ?? "",
      batchSizeBbl: liters ? liters / 117.348 : null, og: n(r, "OG"), fg: n(r, "FG"), ibu: Number.isFinite(ibu) ? ibu : null,
      notes: val(r, "NOTES"), brewer: val(r, "BREWER"), ingredients: ingredients.filter((i) => i.name) };
  });
  if (!recipes.length) throw new Error("No recipes found in that file.");
  return recipes;
}

function renderRecipes() {
  const canEdit = can("manage_beers");
  const beers = [...data.beers].filter((b) => recipesOf(b.id).length).sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById("recipe-list").innerHTML = beers.flatMap((beer) => recipesOf(beer.id).map((r) => `
    <li><button class="row" data-recipe="${r.id}"><span><strong>${esc(beer.name)}</strong> <span class="muted">${esc(r.name)}</span></span>
      <span class="muted">${[r.batchSizeBbl ? showUnit("volume", r.batchSizeBbl) : "", r.locationId ? findLocation(r.locationId)?.name : "",
        `${recipeIngredients(r.id).length} ingredients`].filter(Boolean).map(esc).join(" · ")}</span></button></li>`)).join("")
    || `<li class="muted">No recipes yet.${canEdit ? " Import a BeerXML file from your recipe software." : ""}</li>`;
  document.getElementById("import-beerxml-label").hidden = !canEdit;
}

// Importing: a preview of the file's recipes, each matched to a beer (or a new one)
const recipeImportDialog = document.getElementById("recipe-import");
let pendingRecipes = [];
document.getElementById("import-beerxml").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try { pendingRecipes = parseBeerXml(await file.text()); } catch (err) { alert(err.message); return; }
  const beerOptions = (match) => `<option value="new">New beer</option>` + [...data.beers].sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => `<option value="${b.id}" ${match?.id === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("");
  const locationOptions = `<option value="">Any location</option>` + data.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  document.getElementById("recipe-import-list").innerHTML = pendingRecipes.map((r, i) => {
    const match = data.beers.find((b) => b.name.trim().toLowerCase() === r.name.trim().toLowerCase());
    return `<li class="item recipe-preview">
      <div><strong>${esc(r.name)}</strong> <span class="muted">${esc(r.style)}</span></div>
      <div class="muted">${[r.batchSizeBbl ? showUnit("volume", r.batchSizeBbl) : "", r.og ? `OG ${showUnit("gravity", r.og)}` : "", r.fg ? `FG ${showUnit("gravity", r.fg)}` : "",
        r.ibu != null ? `${Math.round(r.ibu)} IBU` : "", `${r.ingredients.length} ingredients`].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="two-col"><label>For beer <select data-recipe-beer="${i}">${beerOptions(match)}</select></label>
        <label>Location <select data-recipe-location="${i}">${locationOptions}</select></label></div>
      <label class="choice"><input type="checkbox" data-recipe-take="${i}" checked> Import this recipe</label></li>`;
  }).join("");
  recipeImportDialog.showModal();
});
document.getElementById("recipe-import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const chosen = pendingRecipes.map((r, i) => ({ r, take: document.querySelector(`[data-recipe-take="${i}"]`).checked,
    beer: document.querySelector(`[data-recipe-beer="${i}"]`).value, location: document.querySelector(`[data-recipe-location="${i}"]`).value || null }))
    .filter((c) => c.take);
  const ok = await save(async () => {
    const codes = data.beers.map((x) => ({ code: x.code }));
    for (const { r, beer, location } of chosen) {
      let beerId = beer;
      if (beer === "new") {
        beerId = newId();
        const code = beerCodeFor(r.name, codes);
        codes.push({ code });
        await must(db.from("beers").insert({ id: beerId, brewery_id: brewery.id, code, name: r.name, style: r.style || "", target_og: r.og, target_fg: r.fg }));
      } else {
        // A beer with no targets yet takes the recipe's
        const existing = findBeer(beerId);
        if (existing && existing.targetOg == null && r.og) await must(db.from("beers").update({ target_og: r.og, target_fg: r.fg }).eq("id", beerId));
      }
      const recipeId = newId();
      await must(db.from("recipes").insert({ id: recipeId, brewery_id: brewery.id, beer_id: beerId, location_id: location, name: r.name,
        batch_size_bbl: r.batchSizeBbl, target_og: r.og, target_fg: r.fg, ibu: r.ibu, notes: r.notes.slice(0, 4000), source: "BeerXML" }));
      if (r.ingredients.length) await must(db.from("recipe_ingredients").insert(r.ingredients.map((x, position) => ({
        brewery_id: brewery.id, recipe_id: recipeId, position, kind: x.kind, name: x.name.slice(0, 120), amount: x.amount || null, unit: x.unit, timing: x.timing }))));
    }
  });
  if (ok) recipeImportDialog.close();
});

// One recipe
const recipeDialog = document.getElementById("recipe-view");
let viewingRecipe = null;
document.getElementById("recipe-list").addEventListener("click", (e) => {
  const row = e.target.closest("[data-recipe]");
  if (!row) return;
  viewingRecipe = data.recipes.find((r) => r.id === row.dataset.recipe);
  const r = viewingRecipe;
  document.getElementById("recipe-title").textContent = `${findBeer(r.beerId)?.name ?? ""}: ${r.name}`;
  document.getElementById("recipe-facts").textContent = [r.batchSizeBbl ? showUnit("volume", r.batchSizeBbl) : "", r.targetOg ? `OG ${showUnit("gravity", r.targetOg)}` : "",
    r.targetFg ? `FG ${showUnit("gravity", r.targetFg)}` : "", r.ibu != null ? `${Math.round(r.ibu)} IBU` : "",
    r.locationId ? `for ${findLocation(r.locationId)?.name}` : "any location", r.source].filter(Boolean).join(" · ");
  document.getElementById("recipe-ingredients").innerHTML = recipeIngredients(r.id).map((i) => `<li class="item">
    <strong>${esc(i.name)}</strong> <span class="muted">${[i.amount != null ? `${+i.amount} ${i.unit}` : "", i.timing].filter(Boolean).map(esc).join(" · ")}${isCellarTiming(i.timing) ? " · in the cellar" : ""}</span></li>`).join("");
  document.getElementById("recipe-notes").textContent = r.notes;
  document.getElementById("delete-recipe").hidden = !can("manage_beers");
  recipeDialog.showModal();
});
document.getElementById("delete-recipe").addEventListener("click", async () => {
  if (!confirm(`Delete the recipe "${viewingRecipe.name}"? (Batches already brewed keep their ingredients.)`)) return;
  const ok = await save(() => must(db.from("recipes").delete().eq("id", viewingRecipe.id)));
  if (ok) recipeDialog.close();
});

// The brew-day sheet: copy a recipe's brew-day ingredients (the batch's location's recipe first)
function recipesForBatch(b) {
  const location = brewLocation(b)?.id;
  return recipesOf(b.beerId).sort((x, y) => (y.locationId === location) - (x.locationId === location) || (x.locationId ? 1 : 0) - (y.locationId ? 1 : 0));
}
function copyRecipe(b, recipe) {
  const items = recipeIngredients(recipe.id).filter((i) => !isCellarTiming(i.timing));
  const skipped = recipeIngredients(recipe.id).length - items.length;
  if (!confirm(`Copy ${items.length} brew-day ingredients from the recipe "${recipe.name}"? Lot numbers start empty.` +
    (skipped ? ` (${skipped} for the cellar, like dry hops, aren't copied: log them when they go in.)` : ""))) return;
  for (const i of items) {
    queueChange("logAddition", { id: newId(), breweryId: brewery.id, batchId: b.id, addedOn: b.brewDate || today(), kind: i.kind, name: i.name,
      amount: i.amount, unit: i.unit, timing: i.timing, lot: "", notes: "", brewDay: true, turn: null }, `${beerName(b)} ${batchLabel(b)}: ${i.name}`);
  }
}

// ----- Alerts (Phase 6¾): from the records, emailed to chosen people -----
// The server checks every 15 minutes (supabase/functions/alerts); the app also asks for a check
// when it opens, so the list on the tank board is current.
const ALERT_KINDS = [
  { kind: "no_gravity", label: "No gravity logged", help: "A batch with no gravity reading for this many days (counting from brewing if there's none yet)." },
  { kind: "stage_too_long", label: "Too long in a stage", help: "A batch in a stage longer than its limit. Leave a stage empty for no limit." },
  { kind: "acid_due", label: "Acid due", help: "An empty tank that needs an acid cycle (the same rule as on the tank board)." },
  { kind: "under_par", label: "Under par", help: "A beer below its par, at a place or across the brewery (Inventory → pars)." },
  { kind: "low_stock", label: "Low on a raw material", help: "Below the item's reorder level (Inventory → Raw materials → Items)." },
];
const ALERT_DEFAULTS = { no_gravity: { days: 3, stages: ["fermenting", "dry-hopping"] },
  stage_too_long: { days: { fermenting: 21, "dry-hopping": 7, conditioning: 28, carbonating: 7, ready: 30 } } };
const ruleFor = (kind) => {
  const r = (data.alertRules || []).find((x) => x.kind === kind);
  return { enabled: r ? r.enabled : true, params: { ...(ALERT_DEFAULTS[kind] || {}), ...(r?.params || {}) }, recipients: r?.recipients || [] };
};

// Every reload checks the alerts first (see loadAll), so a fresh check is just a reload
async function refreshAlerts() {
  if (!brewery?.id || offline || !navigator.onLine) return;
  await refresh().catch(() => {});
}
const mapAlert = (a) => ({ id: a.id, kind: a.kind, title: a.title, detail: a.detail, openedAt: a.opened_at, acknowledgedAt: a.acknowledged_at });

function renderAlerts() {
  const open = (data.alerts || []).filter((a) => !a.acknowledgedAt);
  const box = document.getElementById("alerts-box");
  box.hidden = !open.length;
  if (!open.length) return;
  box.innerHTML = `<details ${open.length <= 3 ? "open" : ""}><summary><strong>⚠ ${open.length} ${open.length === 1 ? "alert" : "alerts"}</strong></summary>
    <ul class="plain">${open.map((a) => `<li class="alert-row"><div><strong>${esc(a.title)}</strong>${a.detail ? `<div class="muted">${esc(a.detail)}</div>` : ""}</div>
      <button type="button" class="btn small" data-ack="${a.id}">I've got it</button></li>`).join("")}</ul></details>`;
}
document.getElementById("alerts-box").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ack]");
  if (!b) return;
  b.disabled = true;
  await save(async () => { const { error } = await db.rpc("acknowledge_alert", { p_id: b.dataset.ack }); if (error) throw error; });
});

// Settings → Alerts
function renderAlertSettings() {
  const allowed = can("manage_settings");
  const members = (data.members || []).filter((m) => m.email);
  const stageInputs = (params) => STAGES.filter((s) => !["packaged", "used"].includes(s.id)).map((s) => `
    <label>${s.label} <input type="number" min="1" step="1" inputmode="numeric" data-stage-days="${s.id}" value="${params.days?.[s.id] ?? ""}" placeholder="no limit"></label>`).join("");
  document.getElementById("alert-rules").innerHTML = ALERT_KINDS.map(({ kind, label, help }) => {
    const r = ruleFor(kind);
    const extra = kind === "no_gravity" ? `<div class="two-col"><label>After how many days <input type="number" min="1" step="1" inputmode="numeric" data-param="days" value="${r.params.days}"></label>
        <div><span class="muted">In these stages</span>${STAGES.filter((s) => !["packaged", "used"].includes(s.id)).map((s) => `
          <label class="choice"><input type="checkbox" data-gravity-stage="${s.id}" ${r.params.stages.includes(s.id) ? "checked" : ""}> ${s.label}</label>`).join("")}</div></div>`
      : kind === "stage_too_long" ? `<div class="stage-days">${stageInputs(r.params)}</div>` : "";
    return `<fieldset class="group alert-rule" data-alert-kind="${kind}">
      <legend><label class="choice"><input type="checkbox" data-enabled ${r.enabled ? "checked" : ""}> ${label}</label></legend>
      <p class="muted">${help}</p>${extra}
      <div class="muted">Email to:</div>
      <div class="check-grid">${members.map((m) => `<label class="choice"><input type="checkbox" data-recipient="${m.userId}" ${r.recipients.includes(m.userId) ? "checked" : ""}> ${esc(m.email)}</label>`).join("")}</div>
    </fieldset>`;
  }).join("");
  const hours = (sel) => `<option value="">—</option>` + Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${sel === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("");
  document.getElementById("quiet-start").innerHTML = hours(brewery.alertQuietStart ?? null);
  document.getElementById("quiet-end").innerHTML = hours(brewery.alertQuietEnd ?? null);
  for (const el of document.querySelectorAll("#alerts-form input, #alerts-form select, #alerts-form button")) el.disabled = !allowed;
  document.getElementById("alerts-note").hidden = allowed;
}
document.getElementById("alerts-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const rows = [...document.querySelectorAll("[data-alert-kind]")].map((box) => {
    const kind = box.dataset.alertKind;
    const params = {};
    if (kind === "no_gravity") {
      params.days = Number(box.querySelector('[data-param="days"]').value) || 3;
      params.stages = [...box.querySelectorAll("[data-gravity-stage]:checked")].map((i) => i.dataset.gravityStage);
    }
    if (kind === "stage_too_long") {
      params.days = Object.fromEntries([...box.querySelectorAll("[data-stage-days]")].filter((i) => i.value !== "").map((i) => [i.dataset.stageDays, Number(i.value)]));
    }
    return { brewery_id: brewery.id, kind, enabled: box.querySelector("[data-enabled]").checked, params,
      recipients: [...box.querySelectorAll("[data-recipient]:checked")].map((i) => i.dataset.recipient) };
  });
  const start = document.getElementById("quiet-start").value, end = document.getElementById("quiet-end").value;
  const ok = await save(async () => {
    await must(db.from("alert_rules").upsert(rows, { onConflict: "brewery_id,kind" }));
    await must(db.from("breweries").update({ alert_quiet_start: start === "" ? null : Number(start), alert_quiet_end: end === "" ? null : Number(end) }).eq("id", brewery.id));
  });
  if (ok) document.getElementById("alerts-saved").textContent = "Saved.";
});

// ----- Stock places (Settings → Equipment) -----
function renderPlaces() {
  const allowed = can("manage_equipment");
  document.getElementById("place-list").innerHTML = (data.places || []).map((p) => `
    <li class="item"><span class="who">${esc(placeName(p.id))} <span class="muted">· ${p.kind === "taproom" ? "Taproom" : "Storage"}${p.active ? "" : " · hidden"}</span></span>
      ${allowed ? `<span class="actions"><button type="button" class="btn small" data-rename-place="${p.id}">Rename</button>
        <button type="button" class="btn small" data-toggle-place="${p.id}">${p.active ? "Hide" : "Show"}</button></span>` : ""}</li>`).join("");
  const form = document.getElementById("place-form");
  form.locationId.innerHTML = data.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("") + `<option value="">No location</option>`;
}
document.getElementById("place-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const ok = await save(() => must(db.from("stock_places").insert({
    brewery_id: brewery.id, name: f.name.value.trim(), location_id: f.locationId.value || null, kind: f.kind.value })));
  if (ok) f.name.value = "";
});
document.getElementById("place-list").addEventListener("click", async (e) => {
  const rename = e.target.closest("[data-rename-place]"), toggle = e.target.closest("[data-toggle-place]");
  if (rename) {
    const place = data.places.find((p) => p.id === rename.dataset.renamePlace);
    const name = prompt("Name for this place:", place.name)?.trim();
    if (name && name !== place.name) await save(() => must(db.from("stock_places").update({ name }).eq("id", place.id)));
  }
  if (toggle) {
    const place = data.places.find((p) => p.id === toggle.dataset.togglePlace);
    await save(() => must(db.from("stock_places").update({ active: !place.active }).eq("id", place.id)));
  }
});

// ----- A batch's numbers: OG, gravity now, ABV, attenuation, and the fermentation chart -----
// OG: the tank sample (taken once every turn is in the tank; the last turn's is the whole tank) if
// recorded, otherwise the average of the turns' knockout gravities. Nothing here is stored: it's
// all worked out from the readings, so a corrected reading corrects the numbers.
function batchOg(b) {
  const values = (key) => data.readings.filter((r) => r.batchId === b.id && r.fieldKey === key && r.value != null);
  const samples = values("tank_sample_gravity").sort((x, y) => (y.turn ?? 0) - (x.turn ?? 0));
  if (samples.length) return samples[0].value;
  const ko = values("ko_gravity").map((r) => r.value);
  if (ko.length) return ko.reduce((sum, v) => sum + v, 0) / ko.length;
  // A split or blend: its sources' OG, weighted by how much of each went in (or plain average)
  const parts = madeFrom(b.id).map((m) => ({ og: batchOg(data.batches.find((x) => x.id === m.sourceBatchId) || {}), v: m.volumeBbl }))
    .filter((p) => p.og);
  if (!parts.length) return null;
  const weighted = parts.every((p) => p.v > 0);
  const weight = (p) => (weighted ? p.v : 1);
  return parts.reduce((sum, p) => sum + p.og * weight(p), 0) / parts.reduce((sum, p) => sum + weight(p), 0);
}

// Cellar log entries for a batch, oldest first
function cellarLog(b) {
  return data.cellar.filter((c) => c.batchId === b.id)
    .sort((x, y) => x.occurredOn.localeCompare(y.occurredOn) || (x.recordedAt || "").localeCompare(y.recordedAt || ""));
}

function renderNumbers(b) {
  const beer = findBeer(b.beerId);
  const og = batchOg(b);
  const last = cellarLog(b).filter((c) => c.gravitySg != null).at(-1);
  const pct = (n) => `${n.toFixed(1)}%`;
  const target = (text) => `<span class="muted">target ${text}</span>`;
  const chips = [];
  if (og) chips.push(`<span><b>OG</b> ${showUnit("gravity", og)} ${beer?.targetOg ? target(showUnit("gravity", beer.targetOg)) : ""}</span>`);
  else if (beer?.targetOg) chips.push(`<span><b>OG</b> not recorded yet ${target(showUnit("gravity", beer.targetOg))}</span>`);
  if (last) {
    const finished = ["conditioning", "carbonating", "ready", "packaged"].includes(b.stage);
    chips.push(`<span><b>${finished ? "FG" : "Now"}</b> ${showUnit("gravity", last.gravitySg)} <span class="muted">${formatDate(last.occurredOn)}</span>${
      beer?.targetFg ? ` ${target(showUnit("gravity", beer.targetFg))}` : ""}</span>`);
    if (og) {
      const targetAbv = abv(beer?.targetOg, beer?.targetFg);
      chips.push(`<span><b>ABV</b> ${pct(abv(og, last.gravitySg))}${finished ? "" : " so far"} ${targetAbv ? target(pct(targetAbv)) : ""}</span>`);
      chips.push(`<span><b>Attenuation</b> ${pct((og - last.gravitySg) / (og - 1) * 100)}</span>`);
    }
  }
  document.getElementById("bv-numbers").innerHTML = chips.join("");
}

// Gravity and temperature over the days since brewing, drawn as a small chart (no library needed)
function renderChart(b) {
  const beer = findBeer(b.beerId);
  const og = batchOg(b);
  const start = parseDate(b.brewDate);
  const day = (date) => Math.max(0, (parseDate(date) - start) / 86400000);
  const log = cellarLog(b);
  const gravity = [...(og ? [{ x: 0, y: toShown("gravity", og) }] : []),
    ...log.filter((c) => c.gravitySg != null).map((c) => ({ x: day(c.occurredOn), y: toShown("gravity", c.gravitySg) }))];
  const temp = log.filter((c) => c.tempC != null).map((c) => ({ x: day(c.occurredOn), y: toShown("temperature", c.tempC) }));
  const box = document.getElementById("bv-chart");
  if (gravity.length < 2 && temp.length < 2) {
    box.innerHTML = `<p class="muted">The chart appears once there are a couple of gravity or temperature readings (the OG counts as the first).</p>`;
    return;
  }
  const W = 420, H = 210, L = 40, R = 34, T = 14, B = 26;
  const days = Math.max(7, ...gravity.map((p) => p.x), ...temp.map((p) => p.x));
  const fg = beer?.targetFg ? toShown("gravity", beer.targetFg) : null;
  const range = (values, pad) => {
    const lo = Math.min(...values), hi = Math.max(...values);
    return hi - lo < pad ? [lo - pad / 2, hi + pad / 2] : [lo, hi];
  };
  const sg = prefs().gravityUnit === "sg";
  const [gLo, gHi] = range([...gravity.map((p) => p.y), ...(fg != null ? [fg] : [])], sg ? 0.01 : 2);
  const [tLo, tHi] = temp.length ? range(temp.map((p) => p.y), 4) : [0, 1];
  const x = (d) => L + (d / days) * (W - L - R);
  const yG = (v) => T + (1 - (v - gLo) / (gHi - gLo)) * (H - T - B);
  const yT = (v) => T + (1 - (v - tLo) / (tHi - tLo)) * (H - T - B);
  const line = (points, y) => points.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  const dots = (points, y, cls) => points.map((p) => `<circle class="${cls}" cx="${x(p.x).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="3.5"/>`).join("");
  const fmtG = (v) => v.toFixed(sg ? 3 : 1);
  const step = days <= 14 ? 2 : days <= 35 ? 7 : 14;
  const ticks = Array.from({ length: Math.floor(days / step) + 1 }, (_, i) => i * step);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Gravity and temperature by day">
    ${ticks.map((d) => `<line class="grid" x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${H - B}"/><text class="axis" x="${x(d)}" y="${H - 8}" text-anchor="middle">${d === 0 ? "brew" : "day " + d}</text>`).join("")}
    ${fg != null ? `<line class="target" x1="${L}" x2="${W - R}" y1="${yG(fg)}" y2="${yG(fg)}"/><text class="axis" x="${W - R - 4}" y="${yG(fg) - 4}" text-anchor="end">target FG</text>` : ""}
    <text class="axis gravity" x="${L - 6}" y="${T + 4}" text-anchor="end">${fmtG(gHi)}</text>
    <text class="axis gravity" x="${L - 6}" y="${H - B}" text-anchor="end">${fmtG(gLo)}</text>
    ${temp.length ? `<text class="axis temp" x="${W - R + 6}" y="${T + 4}">${tHi.toFixed(0)}°</text><text class="axis temp" x="${W - R + 6}" y="${H - B}">${tLo.toFixed(0)}°</text>` : ""}
    ${gravity.length > 1 ? `<polyline class="gravity" points="${line(gravity, yG)}"/>` : ""}${dots(gravity, yG, "gravity")}
    ${temp.length > 1 ? `<polyline class="temp" points="${line(temp, yT)}"/>` : ""}${dots(temp, yT, "temp")}
  </svg>
  <p class="muted legend"><span class="key gravity"></span> gravity (${UNIT_INFO.gravity[prefs().gravityUnit].label})
    ${temp.length ? `<span class="key temp"></span> temperature (${UNIT_INFO.temperature[prefs().temperatureUnit].label})` : ""}</p>`;
}

// One movement, for the batch history: "29.5 bbl FV-1 → BT-1"
function movementText(m) {
  const v = m.volumeBbl ?? (m.kind === "knockout" ? knockoutVolume(m.batchId) : null);
  const amount = v == null ? "volume not recorded" : showUnit("volume", v);
  const from = m.fromTankId ? esc(tankName(m.fromTankId)) : "", to = m.toTankId ? esc(tankName(m.toTankId)) : "";
  const note = m.notes ? ` <span class="muted">(${esc(m.notes)})</span>` : "";
  switch (m.kind) {
    case "knockout": return `${amount} knocked out into ${to}${m.volumeBbl == null && v != null ? ` <span class="muted">(from the brew sheet or batch size)</span>` : ""}`;
    case "transfer": return `${amount} moved ${from} → ${to}`;
    case "package": {
      const counts = (data.packageCounts || []).filter((c) => c.movementId === m.id).map((c) =>
        `${+c.count.toFixed(2)} × ${esc(data.packageTypes.find((t) => t.id === c.packageTypeId)?.name ?? "package")}`);
      return `${amount} packaged from ${from}${counts.length ? ` <span class="muted">(${counts.join(", ")})</span>` : ""}${note}`;
    }
    case "served": return `${amount} served from ${from}${note}`;
    case "level": return `Level check: ${amount} in ${to}${note}`;
    case "to_batch": return `${amount} from ${from} into ${batchLink(m.sourceBatchId)}`;
    case "from_batch": return `${amount} into ${to} from ${batchLink(m.sourceBatchId)}`;
    case "loss": return `${amount} lost from ${from}${note}`;
    default: return `${amount} ${to ? "added to " + to : "taken out of " + from} as a correction${note}`;
  }
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
    isInTank(b) && b.tankId ? `${volumeText(tankBalance(b.id, b.tankId))} in the tank` : "",
    `brewed ${formatDate(b.brewDate)}`,
  ].filter(Boolean).join(" · ");
  renderNumbers(b);
  renderChart(b);
  const inTank = isInTank(b);
  document.getElementById("bv-log").hidden = !can("cellar_log") || !inTank;
  document.getElementById("bv-add").hidden = !can("cellar_log") || !inTank;
  document.getElementById("bv-package").hidden = !can("package") || !inTank;
  document.getElementById("bv-level").hidden = !can("move_beer") || !inTank;
  document.getElementById("bv-blend").hidden = !can("start_batch") || !can("move_beer") || !inTank;
  document.getElementById("bv-edit").hidden = b.stage === "used"; // all of it went into another batch: nothing left to move
  renderFamily(b);

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
      <span class="when">${formatDate(a.addedOn)} · ${esc(a.name)}</span>${a.brewDay ? ` <span class="tag">brew day${a.turn && b.turns > 1 ? `, turn ${a.turn}` : ""}</span>` : ""}
      <div class="readings">${[a.amount != null ? `${a.amount} ${a.unit}` : "", a.timing, a.lot ? "lot " + a.lot : ""].filter(Boolean).map(esc).join(" · ")}</div>
      ${a.notes ? `<div class="muted">${esc(a.notes)}</div>` : ""}
    </button></li>`).join("") || `<li class="item muted">Nothing added yet.</li>`;

  renderSheet();

  // History: stage changes and transfers, and the volumes that moved, oldest first
  const history = [
    ...data.events.filter((e) => e.batchId === b.id)
      .map((e) => ({ date: e.effectiveDate, at: e.recordedAt || "", text: `${stageLabel(e.stage)}${e.tankId ? " in " + esc(tankName(e.tankId)) : ""}` })),
    ...data.movements.filter((m) => m.batchId === b.id).map((m) => ({ date: m.occurredOn, at: m.recordedAt || "~", text: movementText(m), volume: true })),
  ].sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at)); // same day: in the order recorded
  document.getElementById("bv-history").innerHTML = history.map((h) => `
    <li class="item${h.volume ? " volume" : ""}"><span class="when">${formatDate(h.date)}</span> · ${h.text}</li>`).join("");
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
const USUAL_FIELDS = SHEET_CATALOG.flatMap((section) => section.fields).filter((f) => f.usual).map((f) => f.key);

// Kinds of value a brewery's own field can hold (Settings → Brew sheet → Add your own field)
const CUSTOM_TYPES = [
  { id: "number", label: "Number (with your unit)" }, { id: "temperature", label: "Temperature" },
  { id: "gravity", label: "Gravity" }, { id: "volume", label: "Volume" }, { id: "ph", label: "pH" },
  { id: "time", label: "Time of day" }, { id: "text", label: "Text / initials" },
];

// The full catalog: the app's fields plus the brewery's own (each at the end of its section),
// with the brewery's own names and targets applied (Settings → Brew sheet → Edit)
function sheetCatalog() {
  const own = brewery?.sheetCustomFields || [];
  return SHEET_CATALOG.map((section) => ({
    ...section,
    fields: [...section.fields, ...own.filter((c) => c.section === section.title)
      .map((c) => field(c.key, c.label, c.type, { unit: c.unit || undefined, own: true }))].map(withBrewerySettings),
  }));
}
function withBrewerySettings(f) {
  const mine = brewery?.sheetFieldSettings?.[f.key];
  if (!mine) return f;
  const changed = { ...f, usualLabel: f.label, usualTarget: f.target };
  if (mine.label) changed.label = mine.label;
  if (mine.target === "none") { changed.target = undefined; changed.targetSet = true; }
  else if (mine.target) { changed.target = () => ({ ...mine.target }); changed.targetSet = true; }
  return changed;
}
// Field types that can have a target (the rest are times and words)
const TARGET_TYPES = ["temperature", "gravity", "volume", "ph", "number", "meter"];
function catalogFields() {
  return sheetCatalog().flatMap((section) => section.fields);
}
const UNIT_TYPES = ["temperature", "gravity", "volume"];

// The fields this brewery measures (null = the usual set)
function chosenFields() {
  return new Set(brewery?.sheetFields ?? USUAL_FIELDS);
}

// The sheet for one batch: the brewery's fields, plus any other field this batch has a value for
function sheetFor(batch) {
  const chosen = chosenFields();
  const recorded = new Set(data.readings.filter((r) => r.batchId === batch.id).map((r) => r.fieldKey));
  return sheetCatalog()
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
  renderIngredients(b);
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

// Brew-day ingredients: the grain bill, hops, salts... for this turn (and the whole batch), with lots
const KIND_ORDER = ["malt", "adjunct", "salt", "hop", "finings", "yeast", "spice", "fruit", "other"];
function brewDayIngredients(b, turn) {
  return data.additions
    .filter((a) => a.batchId === b.id && a.brewDay && (turn === undefined || a.turn == null || a.turn === turn))
    .sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || (x.recordedAt || "").localeCompare(y.recordedAt || ""));
}

// The most recent other batch of the same beer that has brew-day ingredients (to copy them from)
function lastBatchWithIngredients(b) {
  // Newest brew date first; for batches brewed the same day, the one whose ingredients were recorded last
  const lastRecorded = (x) => data.additions.filter((a) => a.batchId === x.id && a.brewDay)
    .reduce((latest, a) => ((a.recordedAt || "") > latest ? a.recordedAt : latest), "");
  return data.batches
    .filter((x) => x.id !== b.id && x.beerId === b.beerId && data.additions.some((a) => a.batchId === x.id && a.brewDay))
    .sort((x, y) => (y.brewDate || "").localeCompare(x.brewDate || "") || lastRecorded(y).localeCompare(lastRecorded(x)))[0];
}

function renderIngredients(b) {
  const canAdd = can("cellar_log");
  const turn = b.turns > 1 ? sheetTurn : undefined;
  const list = brewDayIngredients(b, turn);
  const source = !brewDayIngredients(b).length && canAdd ? lastBatchWithIngredients(b) : null;
  document.getElementById("sheet-ingredients").innerHTML = `
    <h3>Ingredients <span class="per">· with lot numbers${b.turns > 1 ? ` · turn ${sheetTurn} and whole batch` : ""}</span></h3>
    <ul class="plain log-list">${list.map((a) => `
      <li class="item"><button class="entry ${canAdd ? "" : "static"}" data-addition="${a.id}">
        <span class="when">${esc(a.name)}</span>${a.turn == null && b.turns > 1 ? ` <span class="tag">whole batch</span>` : ""}
        <div class="readings">${[a.amount != null ? `${a.amount} ${a.unit}` : "", a.timing, a.lot ? "lot " + a.lot : "no lot yet"].filter(Boolean).map(esc).join(" · ")}</div>
      </button></li>`).join("") || `<li class="item muted">None yet.</li>`}</ul>
    ${canAdd ? `<div class="actions wrap">
      <button type="button" class="btn small" id="add-ingredient">+ Ingredient</button>
      ${source ? `<button type="button" class="btn small" id="copy-ingredients" data-from="${source.id}">Copy from ${esc(batchLabel(source))} (last ${esc(beerName(source))})</button>` : ""}
      ${!brewDayIngredients(b).length ? recipesForBatch(b).slice(0, 3).map((r) => `<button type="button" class="btn small" data-copy-recipe="${r.id}">Copy from the recipe ${esc(r.name)}</button>`).join("") : ""}
    </div>` : ""}`;
}

document.getElementById("sheet-ingredients").addEventListener("click", (e) => {
  const b = viewingBatch();
  if (e.target.closest("#add-ingredient")) openAdditionEditor(null, { brewDay: true, turn: b.turns > 1 ? sheetTurn : null });
  const row = e.target.closest("[data-addition]");
  if (row && can("cellar_log")) openAdditionEditor(data.additions.find((a) => a.id === row.dataset.addition));
  const copy = e.target.closest("#copy-ingredients");
  if (copy) copyIngredients(b, data.batches.find((x) => x.id === copy.dataset.from));
  const fromRecipe = e.target.closest("[data-copy-recipe]");
  if (fromRecipe) copyRecipe(b, data.recipes.find((r) => r.id === fromRecipe.dataset.copyRecipe));
});

// Copy the grain bill, hops, and the rest from an earlier batch: names, amounts, and timing, but
// not lot numbers (those are this batch's own). Each is kept on the phone first, like any change.
function copyIngredients(b, source) {
  const items = brewDayIngredients(source);
  if (!confirm(`Copy ${items.length} ingredients from ${beerName(source)} ${batchLabel(source)}? Lot numbers start empty.`)) return;
  for (const a of items) {
    queueChange("logAddition", {
      id: newId(), breweryId: brewery.id, batchId: b.id, addedOn: b.brewDate || today(), kind: a.kind, name: a.name,
      amount: a.amount, unit: a.unit, timing: a.timing, lot: "", notes: "", brewDay: true,
      turn: a.turn != null && a.turn <= b.turns ? a.turn : null,
    }, `${beerName(b)} ${batchLabel(b)}: ${a.name}`);
  }
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
  const field = catalogFields().find((f) => f.key === key);
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
  if (field.targetSet) return targetText(field, field.target ? field.target({}) : null).replace(/^target /, "");
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

// Ingredients on paper: what's known so far, plus empty rows to write in, each with a Lot box
function printIngredients(b) {
  const items = brewDayIngredients(b);
  const turns = b.turns > 1;
  const blank = Math.max(4, 10 - items.length);
  const row = (a) => `<tr><td>${a ? esc(a.name) : ""}</td><td class="box">${a?.amount != null ? `${a.amount} ${esc(a.unit)}` : ""}</td>
    <td class="box">${a ? esc(a.timing) : ""}</td>${turns ? `<td class="box">${a ? a.turn ?? "all" : ""}</td>` : ""}<td class="lot">${a ? esc(a.lot) : ""}</td></tr>`;
  return `<table class="print-table ingredients"><tr><th>Ingredients</th><th class="box">Amount</th><th class="box">When</th>
    ${turns ? `<th class="box">Turn</th>` : ""}<th class="lot">Lot</th></tr>
    ${items.map(row).join("")}${Array.from({ length: blank }, () => row(null)).join("")}</table>`;
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
    ${printIngredients(b)}
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
let additionBrewDay = false; // adding a brew-day ingredient (from the brew-day sheet)

// Suggested "when" for each kind of addition
const BREW_DAY_TIMINGS = ["Mash", "Sparge", "First wort", "Boil 60 min", "Boil 30 min", "Boil 15 min", "Boil 5 min",
  "Flameout", "Whirlpool", "Knockout", "In fermenter"];
const CELLAR_TIMINGS = ["KO in FV", "Primary", "Regular", "Secondary", "Dry hop"];

// addition: one to change, or null for a new one; brewDay: start a brew-day ingredient for this turn
function openAdditionEditor(addition, { brewDay = false, turn = null } = {}) {
  editingAddition = addition;
  additionBrewDay = addition ? !!addition.brewDay : brewDay;
  const b = viewingBatch();
  document.getElementById("addition-title").textContent = addition ? (additionBrewDay ? "Ingredient" : "Addition")
    : (additionBrewDay ? "New brew-day ingredient" : "New addition");
  document.getElementById("addition-timings").innerHTML = (additionBrewDay ? BREW_DAY_TIMINGS : CELLAR_TIMINGS)
    .map((t) => `<option value="${t}">`).join("");
  additionForm.turn.innerHTML = `<option value="">Whole batch</option>` +
    Array.from({ length: b.turns }, (_, i) => `<option value="${i + 1}">Turn ${i + 1}</option>`).join("");
  additionForm.turn.value = String(addition ? addition.turn ?? "" : turn ?? "");
  document.getElementById("addition-turn-field").hidden = !additionBrewDay || b.turns < 2;
  // Suggest names used before
  const names = [...new Set([...data.additions.map((a) => a.name), ...(data.rawItems || []).filter((i) => i.active).map((i) => i.name)])].sort();
  document.getElementById("addition-names").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
  additionForm.addedOn.value = addition?.addedOn ?? (additionBrewDay ? b.brewDate || today() : today());
  additionForm.kind.value = addition?.kind ?? (additionBrewDay ? "malt" : "hop");
  additionForm.name.value = addition?.name ?? "";
  additionForm.amount.value = addition?.amount ?? "";
  additionForm.unit.value = addition?.unit ?? (additionBrewDay ? "lb" : "oz");
  additionForm.timing.value = addition?.timing ?? "";
  additionForm.lot.value = addition?.lot ?? "";
  additionForm.notes.value = addition?.notes ?? "";
  document.getElementById("delete-addition").hidden = !addition;
  suggestLots();
  additionDialog.showModal();
}
document.getElementById("bv-add").addEventListener("click", () => openAdditionEditor(null));
additionForm.name.addEventListener("input", suggestLots); // lots of that raw material that are on hand
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
    brewDay: additionBrewDay, turn: additionBrewDay && additionForm.turn.value ? Number(additionForm.turn.value) : null,
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

// ----- A newer version of the app -----
// A tab left open keeps running the version it opened with. Every so often (and when coming back
// to the app) this compares the app's files with what's published, and if they've changed, offers
// a reload. It never reloads by itself: someone might be in the middle of typing.
const WATCHED_FILES = ["index.html", "app.js", "style.css"];
let loadedVersion = null;
async function publishedVersion() {
  const texts = await Promise.all(WATCHED_FILES.map(async (file) => {
    const response = await fetch(file, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${file}: ${response.status}`);
    return response.text();
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texts.join("\n")));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
async function checkForUpdate() {
  if (!navigator.onLine || offline) return;
  try {
    const version = await publishedVersion();
    loadedVersion ??= version; // the first check remembers the version this page is running
    document.getElementById("update-banner").hidden = version === loadedVersion;
  } catch {
    // no signal or a hiccup: try again next time
  }
}
document.getElementById("update-reload").addEventListener("click", () => location.reload());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
setInterval(checkForUpdate, 10 * 60 * 1000);

// ---------- 15. Go ----------
showSyncProblems();
start();
checkForUpdate();
