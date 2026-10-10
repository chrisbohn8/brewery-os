// Brewery OS — the demo brewery (docs/demo-design.md)
//
// Makes a lived-in brewery, in the same shape as a backup file, so it's loaded the way a backup is
// (loadIntoBrewery in app.js: one all-or-nothing step, through the database's usual rules).
//
// It isn't a fixed file: it SIMULATES about three months of brewing, day by day, ending today, so
// the records always look current ("brewed 4 days ago", next Tuesday's brew day), and they follow
// the same rules the app's forms do: a batch only starts in an empty tank, a transfer only goes to
// a free brite big enough, volumes add up, stock is taken oldest batch first and never below zero,
// ingredients are used from lots that were received first.
//
// Two locations show one-, two-, and three-turn batches (the user's choice):
//   Riverside   a 15 bbl brewhouse: 15 and 30 bbl fermenters and brites
//   Northgate   a 30 bbl brewhouse: 30 and 60 bbl tanks, and a 90 bbl fermenter
// Everything is made up: the brewery, beers, people, accounts, and suppliers.
//
// The same seed gives the same brewery every time (only the dates move with today).
//
//   DemoBrewery.make(today)  the demo's records ("YYYY-MM-DD" = the last day of history)
(function () {
  const DAYS = 90; // how much history

  // ---------- Helpers ----------
  // A small seeded random number generator (mulberry32), so the demo is the same every time
  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const F = (f) => round((f - 32) * 5 / 9, 2); // °F -> °C (stored in °C)

  // ---------- The brewery ----------
  const LOCATIONS = [
    { id: "riverside", name: "Riverside", turnSizeBbl: 15, usualTurns: 1, kettleFullBbl: 17.5, flowTarget: "1.5 gal/min",
      waterGristQtLb: 1.4, absorptionGalLb: 0.1, brewDays: [1, 3, 5] },   // Mon, Wed, Fri
    { id: "northgate", name: "Northgate", turnSizeBbl: 30, usualTurns: 2, kettleFullBbl: 35, flowTarget: "3 gal/min",
      waterGristQtLb: 1.4, absorptionGalLb: 0.1, brewDays: [2, 4] },       // Tue, Thu
  ];
  const tank = (id, name, type, capacityBbl, locationId) => ({ id, name, type, capacityBbl, locationId, status: "empty", acidEveryTurns: type === "fermenter" ? 12 : null });
  const TANKS = [
    tank("r-fv1", "FV1", "fermenter", 15, "riverside"), tank("r-fv2", "FV2", "fermenter", 15, "riverside"),
    tank("r-fv3", "FV3", "fermenter", 15, "riverside"), tank("r-fv4", "FV4", "fermenter", 15, "riverside"),
    tank("r-fv5", "FV5", "fermenter", 30, "riverside"), tank("r-fv6", "FV6", "fermenter", 30, "riverside"),
    tank("r-bt1", "BT1", "brite", 15, "riverside"), tank("r-bt2", "BT2", "brite", 15, "riverside"),
    tank("r-bt3", "BT3", "brite", 30, "riverside"), tank("r-bt4", "BT4", "brite", 30, "riverside"),
    tank("n-fv11", "FV11", "fermenter", 30, "northgate"), tank("n-fv12", "FV12", "fermenter", 30, "northgate"),
    tank("n-fv13", "FV13", "fermenter", 60, "northgate"), tank("n-fv14", "FV14", "fermenter", 60, "northgate"),
    tank("n-fv15", "FV15", "fermenter", 90, "northgate"),
    tank("n-bt11", "BT11", "brite", 30, "northgate"), tank("n-bt12", "BT12", "brite", 60, "northgate"),
    tank("n-bt13", "BT13", "brite", 90, "northgate"),
  ];

  // How each kind of beer moves through the cellar (days after brewing). A transfer that finds no
  // free brite waits a day, and so does everything after it.
  const PROFILES = {
    hazy:   { k: 0.5, fermC: F(68), steps: [["dry-hopping", 4], ["conditioning", 10]], transfer: 12, ready: 14, pkg: 15, dryHops: [4, 7] },
    ipa:    { k: 0.5, fermC: F(66), steps: [["dry-hopping", 6], ["conditioning", 9]], transfer: 11, ready: 13, pkg: 14, dryHops: [6] },
    ale:    { k: 0.5, fermC: F(66), steps: [["conditioning", 8]], transfer: 11, ready: 13, pkg: 14, dryHops: [] },
    dark:   { k: 0.45, fermC: F(66), steps: [["conditioning", 9]], transfer: 13, ready: 15, pkg: 16, dryHops: [] },
    lager:  { k: 0.25, fermC: F(50), steps: [["conditioning", 14]], transfer: 32, ready: 34, pkg: 35, dryHops: [] },
    kolsch: { k: 0.35, fermC: F(60), steps: [["conditioning", 10]], transfer: 20, ready: 22, pkg: 23, dryHops: [] },
    sour:   { k: 0.5, fermC: F(72), steps: [["conditioning", 7]], transfer: 10, ready: 12, pkg: 13, dryHops: [] },
  };

  // The beers: their targets, menu details, how they're packaged, and their recipe for one turn
  // of 15 bbl (a Northgate turn is twice that). Grain in lb, hops in lb, salts in g, acid in ml.
  const BEERS = [
    { id: "hazy", name: "House Hazy", style: "Hazy IPA", og: 1.066, fg: 1.016, ibu: 35, srm: 5, profile: "hazy", section: "ipas", tags: ["brewers"],
      short: "Juicy, soft, and bright", description: "Oats and wheat for a pillowy body, double dry hopped with Citra and Mosaic: mango, peach, and orange.",
      hops: "Citra, Mosaic", price: 7, cans: true, home: ["riverside", "northgate"],
      grain: { "Pale 2-Row": 520, "Flaked Oats": 90, "White Wheat": 60 }, kettle: { Magnum: 2, Citra: 8 }, dry: { Citra: 22, Mosaic: 15 } },
    { id: "wcipa", name: "West Coast IPA", style: "American IPA", og: 1.062, fg: 1.010, ibu: 65, srm: 6, profile: "ipa", section: "ipas", tags: [],
      short: "Piney, dry, and bitter", description: "Crystal clear and bone dry: grapefruit, pine, and a firm bitterness.",
      hops: "Simcoe, Centennial", price: 7, cans: true, home: ["riverside", "northgate"],
      grain: { "Pale 2-Row": 600, "Munich": 30 }, kettle: { Magnum: 4, Simcoe: 10, Centennial: 8 }, dry: { Simcoe: 18, Centennial: 12 } },
    { id: "dipa", name: "Double Hazy", style: "Double IPA", og: 1.080, fg: 1.016, ibu: 50, srm: 5, profile: "hazy", section: "ipas", tags: ["new"],
      short: "Big, juicy, and dangerously smooth", description: "Our hazy, turned up: more oats, more Citra and Mosaic, 8.4% and dangerously smooth.",
      hops: "Citra, Mosaic, Simcoe", price: 8, small: true, cans: false, home: ["riverside"],
      grain: { "Pale 2-Row": 640, "Flaked Oats": 120, "White Wheat": 70 }, kettle: { Magnum: 2, Citra: 12 }, dry: { Citra: 30, Mosaic: 20 } },
    { id: "pale", name: "Pale Ale", style: "American Pale Ale", og: 1.050, fg: 1.011, ibu: 38, srm: 7, profile: "ale", section: "ipas", tags: [],
      short: "Easy-drinking, citrusy pale", description: "A crisp everyday pale with a little caramel and a lot of Cascade.",
      hops: "Cascade", price: 6, cans: true, home: ["riverside", "northgate"],
      grain: { "Pale 2-Row": 460, "Caramel 40": 25 }, kettle: { Magnum: 1.5, Cascade: 12 }, dry: {} },
    { id: "pils", name: "Czech Pilsner", style: "Czech Pale Lager", og: 1.048, fg: 1.012, ibu: 36, srm: 3, profile: "lager", section: "lagers", tags: [],
      short: "Crisp, floral, and clean", description: "Floor-malted Pilsner malt and Saaz, lagered for a month: soft bread, spicy hops, clean finish.",
      hops: "Saaz", price: 6, cans: true, home: ["northgate"],
      grain: { "Pilsner": 500 }, kettle: { Saaz: 14 }, dry: {} },
    { id: "helles", name: "Helles", style: "Munich Helles", og: 1.047, fg: 1.010, ibu: 18, srm: 4, profile: "lager", section: "lagers", tags: [],
      short: "Soft, bready, and golden", description: "The beer we drink after a long brew day: soft bread, a touch of honey, and gone too fast.",
      hops: "Hallertau", price: 6, cans: false, home: ["northgate"],
      grain: { "Pilsner": 470, "Munich": 25 }, kettle: { Hallertau: 7 }, dry: {} },
    { id: "kolsch", name: "Kölsch", style: "Kölsch", og: 1.046, fg: 1.009, ibu: 22, srm: 3, profile: "kolsch", section: "lagers", tags: [],
      short: "Delicate, crisp, and dry", description: "Fermented cool and lagered: delicate, crisp, and dry with a faint fruitiness.",
      hops: "Hallertau", price: 6, cans: false, home: ["riverside"],
      grain: { "Pilsner": 460, "White Wheat": 20 }, kettle: { Hallertau: 8 }, dry: {} },
    { id: "amber", name: "Amber Ale", style: "American Amber Ale", og: 1.054, fg: 1.013, ibu: 28, srm: 14, profile: "ale", section: "malty", tags: [],
      short: "Toasty caramel, clean finish", description: "Toasted bread and caramel, balanced with a little Cascade.",
      hops: "Cascade", price: 6, cans: false, home: ["riverside"],
      grain: { "Pale 2-Row": 440, "Munich": 50, "Caramel 40": 40, "Chocolate": 4 }, kettle: { Magnum: 1, Cascade: 6 }, dry: {} },
    { id: "stout", name: "Oatmeal Stout", style: "Oatmeal Stout", og: 1.058, fg: 1.016, ibu: 32, srm: 38, profile: "dark", section: "dark", tags: [],
      short: "Silky coffee and chocolate", description: "Roasted barley and oats: coffee, dark chocolate, and a silky finish.",
      hops: "Magnum", price: 6, cans: false, home: ["northgate"],
      grain: { "Pale 2-Row": 420, "Flaked Oats": 50, "Chocolate": 30, "Roasted Barley": 25, "Caramel 40": 20 }, kettle: { Magnum: 3 }, dry: {} },
    { id: "milk", name: "Milk Stout", style: "Sweet Stout", og: 1.062, fg: 1.020, ibu: 25, srm: 40, profile: "dark", section: "dark", tags: ["lactose"],
      short: "Sweet, creamy, and roasty", description: "Lactose for a sweet, creamy body over roast and cocoa. Contains milk sugar.",
      hops: "Magnum", price: 6, cans: false, home: ["riverside"],
      grain: { "Pale 2-Row": 400, "Chocolate": 35, "Roasted Barley": 20, "Caramel 40": 25, "Lactose": 60 }, kettle: { Magnum: 2 }, dry: {} },
    { id: "gose", name: "Raspberry Gose", style: "Gose", og: 1.044, fg: 1.008, ibu: 8, srm: 6, profile: "sour", section: "sours", tags: ["fruit", "seasonal"],
      short: "Tart raspberry, a pinch of salt", description: "Kettle-soured with coriander and sea salt, finished on raspberries. Tart, pink, and refreshing.",
      hops: "Hallertau", price: 7, cans: true, home: ["riverside"],
      grain: { "Pilsner": 230, "White Wheat": 230 }, kettle: { Hallertau: 1.5 }, dry: {} },
    { id: "porter", name: "Robust Porter", style: "American Porter", og: 1.060, fg: 1.016, ibu: 40, srm: 32, profile: "dark", section: "dark", tags: [],
      short: "Roasty, chocolatey, and robust", description: "Black and robust: chocolate, toffee, and a little roast.",
      hops: "Centennial", price: 6, cans: false, home: ["northgate"],
      grain: { "Pale 2-Row": 470, "Munich": 40, "Chocolate": 35, "Caramel 40": 30 }, kettle: { Magnum: 2, Centennial: 5 }, dry: {} },
    { id: "blend", name: "Brewer's Blend", style: "Black IPA", og: 1.061, fg: 1.013, ibu: 50, srm: 30, profile: "ale", section: "dark", tags: ["brewers", "new"],
      short: "Stout meets West Coast IPA", description: "A one-off blend of our Oatmeal Stout and West Coast IPA: roast and pine.",
      hops: "Simcoe, Centennial", price: 7, cans: false, home: [], grain: {}, kettle: {}, dry: {} },
  ];
  // Raw materials: name (what's typed as an ingredient), kind, unit, pack, reorder level
  const RAW = [
    ["Pale 2-Row", "malt", "lb", "sack", 55, 3300], ["Pilsner", "malt", "lb", "sack", 55, 2200], ["Munich", "malt", "lb", "sack", 55, 330],
    ["White Wheat", "malt", "lb", "sack", 50, 400], ["Caramel 40", "malt", "lb", "sack", 50, 200], ["Chocolate", "malt", "lb", "sack", 50, 150],
    ["Roasted Barley", "malt", "lb", "sack", 50, 100], ["Flaked Oats", "adjunct", "lb", "bag", 50, 400], ["Lactose", "adjunct", "lb", "bag", 50, 150],
    ["Magnum", "hop", "lb", "box", 44, 20], ["Citra", "hop", "lb", "box", 44, 90], ["Mosaic", "hop", "lb", "box", 44, 60],
    ["Simcoe", "hop", "lb", "box", 44, 50], ["Centennial", "hop", "lb", "box", 44, 30], ["Cascade", "hop", "lb", "box", 44, 30],
    ["Saaz", "hop", "lb", "box", 44, 40], ["Hallertau", "hop", "lb", "box", 44, 30],
    ["Gypsum", "salt", "kg", "bag", 25, 5], ["Calcium Chloride", "salt", "kg", "bag", 25, 5], ["Lactic Acid 88%", "salt", "l", "jug", 20, 4],
    ["Raspberry Puree", "other", "gal", "pail", 5, 20],
  ];
  const SUPPLIERS = { malt: "Prairie Malt Supply", adjunct: "Prairie Malt Supply", hop: "Valley Hop Merchants", salt: "Brewers Chem Co.", other: "Orchard Fruit Co." };
  const BREWERS = ["Sam", "Jo", "Alex", "Riley", "Pat"];
  const ACCOUNTS = ["Corner Tavern", "Main Street Market", "Riverbend Grill", "Hilltop Bottle Shop", "Station Pub"];

  // ---------- The menu's lists ----------
  const MENU = {
    sizes: [{ id: "pint", name: "16 oz", oz: 16 }, { id: "ten", name: "10 oz", oz: 10 }, { id: "flight", name: "Flight (4 × 4 oz)", oz: 16 },
      { id: "crowler", name: "32 oz crowler", oz: 32 }],
    sections: [{ id: "ipas", name: "IPAs & Pales" }, { id: "lagers", name: "Lagers" }, { id: "sours", name: "Sours" }, { id: "dark", name: "Dark & Malty" },
      { id: "malty", name: "Amber & Red" }],
    tags: [{ id: "new", name: "New", kind: "badge" }, { id: "seasonal", name: "Seasonal", kind: "badge" }, { id: "brewers", name: "Brewer's pick", kind: "badge" },
      { id: "lactose", name: "Contains lactose", kind: "allergen" }, { id: "fruit", name: "Contains fruit", kind: "allergen" }],
    fields: [{ id: "hops", name: "Hops", type: "text", options: [] }],
  };

  function make(todayString) {
    const random = rng(20261010);
    // pH has its own sequence, so adding it didn't change how the rest of the three months play out
    const phRandom = rng(4321);
    const kickRandom = rng(999); // (its own stream, so the rest of the demo stays the same)
    const phJitter = (n) => (phRandom() - 0.5) * 2 * n;
    const pick = (list) => list[Math.floor(random() * list.length)];
    const jitter = (n) => (random() - 0.5) * 2 * n;
    const base = new Date(`${todayString}T12:00:00`);
    const dayString = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const weekday = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d.getDay(); };
    // Records made the same day keep their order (the app orders same-day records by when they were recorded)
    let clock = 0;
    const at = (n) => { clock += 1; return `${dayString(n)}T${String(8 + Math.floor(clock / 3600) % 12).padStart(2, "0")}:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}Z`; };
    let next = 0;
    const id = (prefix) => `${prefix}-${++next}`;

    const d = {
      locations: LOCATIONS.map(({ brewDays, ...l }) => l),
      tanks: TANKS.map((t) => ({ ...t })),
      beers: [], menu: MENU, cleanings: [], acidAfterStyles: ["Gose"],
      batches: [], events: [], movements: [], places: [], packageTypes: [], packageCounts: [], stockMoves: [],
      rawItems: [], rawReceipts: [], rawAdjustments: [], rawOrders: [], recipes: [], recipeIngredients: [],
      cellar: [], additions: [], readings: [], views: [], lines: [], pars: [], kicks: [], planItems: [], schedules: {}, shifts: {},
      planLookaheadDays: 14, recipesPer: "turn", gravityReadings: 1,
      prefs: { temperatureUnit: "F", gravityUnit: "plato", volumeUnit: "bbl", timeZone: "America/Chicago" },
      sheetFields: null, sheetCustomFields: [], sheetFieldSettings: {}, files: [], boards: [],
    };
    const beerById = Object.fromEntries(BEERS.map((b) => [b.id, b]));
    const tankById = Object.fromEntries(d.tanks.map((t) => [t.id, t]));

    // Beers, with their menu details (the Northgate taproom charges a dollar more)
    for (const b of BEERS) {
      const prices = b.small
        ? [{ size: "ten", price: b.price }, { size: "flight", price: 12 }]
        : [{ size: "pint", price: b.price, at: { "n-taproom": b.price + 1 } }, { size: "ten", price: b.price - 2 }, { size: "flight", price: 12 },
          ...(b.cans ? [] : [{ size: "crowler", price: b.price + 6 }])];
      d.beers.push({ id: b.id, name: b.name, style: b.style, targetOg: b.og, targetFg: b.fg,
        menuDescription: b.description, menuShort: b.short, menuAbv: round((b.og - b.fg) * 131.25, 1), menuIbu: b.ibu, menuSrm: b.srm,
        menuSection: b.section, menuTags: b.tags, menuExtra: { hops: b.hops }, menuPublic: true, menuPrices: prices });
    }

    // Places: each location's storage (matched to the one every new location gets) and its taproom
    for (const l of LOCATIONS) {
      d.places.push({ id: `${l.id[0]}-storage`, locationId: l.id, name: "Storage", kind: "storage", active: true, sortMode: "az", beerOrder: [] });
      d.places.push({ id: `${l.id[0]}-taproom`, locationId: l.id, name: "Taproom", kind: "taproom", active: true, sortMode: "lines", beerOrder: [] });
    }
    // Package types: the usual ones every brewery starts with (matched by name)
    d.packageTypes = [
      { id: "half", name: "½ bbl keg", volumeBbl: 0.5, kind: "keg", catalogKey: "keg_half", active: true },
      { id: "quarter", name: "¼ bbl keg", volumeBbl: 0.25, kind: "keg", catalogKey: "keg_quarter", active: true },
      { id: "sixth", name: "⅙ bbl keg", volumeBbl: 1 / 6, kind: "keg", catalogKey: "keg_sixth", active: true },
      { id: "case12", name: "Case, 24 × 12 oz", volumeBbl: 2.25 / 31, kind: "case", catalogKey: "case_24x12", active: true },
      { id: "case16", name: "Case, 24 × 16 oz", volumeBbl: 3 / 31, kind: "case", catalogKey: "case_24x16", active: true },
    ];
    const typeById = Object.fromEntries(d.packageTypes.map((t) => [t.id, t]));

    // ---------- Raw materials: lots received before they're used ----------
    const lots = {}; // item name -> [{ lot, left }]
    let lotNo = 100;
    for (const [name, kind, unit, packName, packSize, reorder] of RAW) {
      d.rawItems.push({ id: `raw-${name}`, name, kind, unit, packName, packSize, reorderLevel: reorder, active: true, leadDays: kind === "hop" ? 10 : 5 });
      lots[name] = [];
    }
    const itemOf = (name) => RAW.find((r) => r[0] === name);
    const toItemUnit = { lb: { lb: 1 }, kg: { g: 0.001, kg: 1 }, l: { ml: 0.001, l: 1 }, gal: { gal: 1 } };
    // Use an amount (in the addition's unit) on day n: the current lot, or a new delivery a few days before
    function useRaw(name, amount, unit, n) {
      const [, kind, itemUnit, , packSize, reorder] = itemOf(name);
      const need = amount * toItemUnit[itemUnit][unit];
      let lot = lots[name].at(-1);
      if (!lot || lot.left < need) {
        // A delivery: a few packs, enough for a while (and over the reorder level)
        const packs = Math.max(4, Math.ceil((need * 4 + reorder) / packSize));
        lot = { lot: `${name.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X")}-${++lotNo}`, left: packs * packSize };
        lots[name].push(lot);
        d.rawReceipts.push({ itemId: `raw-${name}`, receivedOn: dayString(Math.max(-DAYS - 5, n - 3 - Math.floor(random() * 4))), lot: lot.lot,
          amount: packs * packSize, supplier: SUPPLIERS[kind], cost: round(packs * packSize * (kind === "hop" ? 14 : kind === "malt" || kind === "adjunct" ? 0.9 : 6), 2),
          notes: "", recordedAt: null });
      }
      lot.left -= need;
      return lot.lot;
    }

    // ---------- The cellar, day by day ----------
    const occupant = {};   // tank id -> batch
    const freeFrom = {};   // tank id -> the first day it can be filled again (after cleaning)
    const turnsSinceAcid = {};
    const lastStyleOut = {}; // tank id -> style of the last batch that left (for acid cycles)
    const active = [];     // batches still in a tank
    const onHand = [];     // finished goods: { place, beer, batch, type, count, packedOn }
    let batchNo = 400;
    const rotation = { riverside: ["hazy", "wcipa", "pale", "kolsch", "amber", "gose", "milk", "dipa", "hazy", "pale"],
      northgate: ["pils", "hazy", "stout", "wcipa", "helles", "porter", "hazy", "pale"] };
    const rotationAt = { riverside: 0, northgate: 0 };

    function addMovement(m) { const mv = { id: id("mv"), notes: "", ...m, occurredOn: dayString(m.day), recordedAt: at(m.day) }; delete mv.day; d.movements.push(mv); return mv; }
    function addEvent(batch, n, stage, tankId) { d.events.push({ batchId: batch.id, effectiveDate: dayString(n), stage, tankId, recordedAt: at(n) }); batch.stage = stage; }
    function addCellar(batch, n, entry) { d.cellar.push({ batchId: batch.id, occurredOn: dayString(n), action: "", gravitySg: null, ph: null, tempC: null,
      cellarChange: "", notes: "", ...entry, recordedAt: at(n) }); }
    const balance = (batch, tankId) => d.movements.filter((m) => m.batchId === batch.id && (m.toTankId === tankId || m.fromTankId === tankId))
      .reduce((sum, m) => (m.kind === "level" ? m.volumeBbl : sum + (m.toTankId === tankId ? 1 : -1) * m.volumeBbl), 0);
    const gravityOn = (batch, day) => round(batch.fg + (batch.og - batch.fg) * Math.exp(-batch.profile.k * day) + jitter(0.0004), 4);
    // pH: from knockout (about 4.85) it drops fast in the first couple of days of fermentation, then levels
    // off (ales lower than lagers; dark beers a little higher). A kettle sour starts low and barely moves.
    const phOn = (batch, day) => { jitter(0.1); return round(batch.endPh + (batch.koPh - batch.endPh) * Math.exp(-1.1 * day) + phJitter(0.02), 2); }; // (main draw kept in step)

    // A brew day: a batch into an empty fermenter, its brew-day sheet turn by turn, and its ingredients
    function brew(n, location) {
      const fermenters = d.tanks.filter((t) => t.locationId === location.id && t.type === "fermenter" && !occupant[t.id] && (freeFrom[t.id] ?? -Infinity) <= n);
      if (!fermenters.length) return;
      const list = rotation[location.id];
      const beer = beerById[list[rotationAt[location.id]++ % list.length]];
      // Bigger tanks for the busiest beers; otherwise any free fermenter, smallest first
      const sizes = [...new Set(fermenters.map((t) => t.capacityBbl))].sort((a, b) => a - b);
      const want = beer.id === "hazy" || beer.id === "pils" ? sizes.at(-1) : sizes[Math.floor(random() * sizes.length)];
      const t = fermenters.find((x) => x.capacityBbl === want);
      const turns = Math.round(t.capacityBbl / location.turnSizeBbl);
      const profile = PROFILES[beer.profile];
      const batch = { id: id("batch"), batchNumber: String(++batchNo), beerId: beer.id, brewDate: dayString(n), sizeBbl: t.capacityBbl, turns,
        beer, profile, og: round(beer.og + jitter(0.0015), 4), fg: round(beer.fg + jitter(0.001), 4), tankId: t.id, start: n, delay: 0, location,
        wait: Math.floor(random() * 5) }; // (ready beer waits a few days in its brite, as it does)
      batch.koPh = beer.profile === "sour" ? round(3.4 + phJitter(0.04), 2) : round(4.85 + phJitter(0.04), 2);
      batch.endPh = beer.profile === "sour" ? round(3.3 + phJitter(0.03), 2)
        : round((profile === PROFILES.lager || profile === PROFILES.kolsch ? 4.45 : profile === PROFILES.dark ? 4.5 : 4.3) + phJitter(0.04), 2);
      d.batches.push({ id: batch.id, batchNumber: batch.batchNumber, beerId: beer.id, brewDate: batch.brewDate, sizeBbl: batch.sizeBbl, turns });
      occupant[t.id] = batch;
      turnsSinceAcid[t.id] = (turnsSinceAcid[t.id] || 0) + 1;
      active.push(batch);
      addEvent(batch, n, "fermenting", t.id);
      const koVolume = round(t.capacityBbl * (0.96 + random() * 0.03), 1);
      addMovement({ day: n, batchId: batch.id, kind: "knockout", toTankId: t.id, volumeBbl: koVolume });

      // The brew-day sheet: each turn's numbers, and the whole batch's
      const scale = location.turnSizeBbl / 15;
      const grist = Object.values(beer.grain).reduce((s, v) => s + v, 0) * scale;
      const brewers = `${pick(BREWERS)}, ${pick(BREWERS)}`;
      const reading = (turn, fieldKey, value, extra = {}) => d.readings.push({ batchId: batch.id, turn, fieldKey, value, valueText: null, raw: null, ...extra });
      const text = (fieldKey, valueText) => d.readings.push({ batchId: batch.id, turn: null, fieldKey, value: null, valueText, raw: null });
      for (let turn = 1; turn <= turns; turn++) {
        const g = round(grist + jitter(4 * scale), 0);
        const mashGal = round(g * location.waterGristQtLb / 4, 0);
        const meterStart = Math.round(10000 + random() * 80000);
        reading(turn, "grist_weight", g);
        reading(turn, "mash_water_volume", round(mashGal / 31, 3), { raw: { start: meterStart, end: meterStart + mashGal, unit: "gal" } });
        reading(turn, "mash_strike_temp", F(163 + jitter(2)));
        reading(turn, "mash_temp", F(152 + jitter(1.5)));
        reading(turn, "mash_ph", round(5.35 + jitter(0.08), 2));
        reading(turn, "vorlauf_start_temp", F(150 + jitter(2)));
        reading(turn, "vorlauf_end_temp", F(152 + jitter(2)));
        reading(turn, "flow_rate", round(1.5 * scale + jitter(0.2), 1));
        reading(turn, "sparge_temp", F(168 + jitter(1)));
        reading(turn, "end_sparge_temp", F(166 + jitter(2)));
        const totalGal = round(location.kettleFullBbl * 31 + g * location.absorptionGalLb, 0);
        reading(turn, "end_sparge_volume", round((totalGal - mashGal) / 31, 3), { raw: { start: meterStart + mashGal, end: meterStart + totalGal, unit: "gal" } });
        reading(turn, "kettle_full_volume", round(location.kettleFullBbl + jitter(0.4), 2));
        reading(turn, "post_boil_volume", round(location.turnSizeBbl * 1.05 + jitter(0.3), 2));
        reading(turn, "first_runnings_gravity", round(batch.og + 0.022 + jitter(0.002), 4));
        reading(turn, "final_runnings_gravity", round(1.008 + jitter(0.002), 4));
        reading(turn, "kettle_full_gravity", round(batch.og - 0.008 + jitter(0.001), 4));
        reading(turn, "ko_gravity", round(batch.og + jitter(0.001), 4));
        reading(turn, "first_runnings_ph", round(5.3 + jitter(0.05), 2));
        reading(turn, "kettle_full_ph", round(5.25 + jitter(0.04), 2));
        jitter(0.05); // (keeps the main sequence in step: this used to draw the knockout pH)
        reading(turn, "ko_ph", round(batch.koPh + phJitter(0.03), 2));
        reading(turn, "ko_temp", F((beer.profile === "lager" || beer.profile === "kolsch" ? 50 : 66) + jitter(1)));
        // Ingredients, with their lots
        for (const [name, lb] of Object.entries(beer.grain)) {
          const amount = round(lb * scale, 0);
          d.additions.push({ batchId: batch.id, addedOn: dayString(n), kind: itemOf(name)[1] === "adjunct" ? "adjunct" : "malt", name, amount, unit: "lb",
            timing: "Mash", lot: useRaw(name, amount, "lb", n), notes: "", brewDay: true, turn, recordedAt: at(n) });
        }
        for (const [name, g2] of [["Gypsum", 900 * scale], ["Calcium Chloride", 600 * scale]]) {
          d.additions.push({ batchId: batch.id, addedOn: dayString(n), kind: "salt", name, amount: round(g2, 0), unit: "g",
            timing: "Mash", lot: useRaw(name, g2, "g", n), notes: "", brewDay: true, turn, recordedAt: at(n) });
        }
        if (beer.id === "gose") d.additions.push({ batchId: batch.id, addedOn: dayString(n), kind: "salt", name: "Lactic Acid 88%", amount: round(800 * scale, 0), unit: "ml",
          timing: "Kettle sour", lot: useRaw("Lactic Acid 88%", 800 * scale, "ml", n), notes: "", brewDay: true, turn, recordedAt: at(n) });
        Object.entries(beer.kettle).forEach(([name, lb], i) => {
          const amount = round(lb * scale, 1);
          d.additions.push({ batchId: batch.id, addedOn: dayString(n), kind: "hop", name, amount, unit: "lb",
            timing: i === 0 ? "60 min" : "Whirlpool", lot: useRaw(name, amount, "lb", n), notes: "", brewDay: true, turn, recordedAt: at(n) });
        });
      }
      d.additions.push({ batchId: batch.id, addedOn: dayString(n), kind: "yeast", name: beer.profile === "lager" ? "Lager yeast" : "House ale yeast",
        amount: round(t.capacityBbl * 0.8, 0), unit: "l", timing: "Pitch", lot: `Gen ${2 + Math.floor(random() * 6)}`, notes: "", brewDay: true, turn: null, recordedAt: at(n) });
      d.readings.push({ batchId: batch.id, turn: null, fieldKey: "ko_volume", value: koVolume, valueText: null, raw: null });
      d.readings.push({ batchId: batch.id, turn: turns, fieldKey: "tank_sample_gravity", value: batch.og, valueText: null, raw: null });
      reading(null, "oxygen_rate", round(3 + jitter(0.3), 1));
      text("brewers", brewers);
      text("yeast_strain", beer.profile === "lager" ? "Lager yeast" : "House ale yeast");
      text("yeast_source", pick(["Brink 1", "Brink 2", `FV${1 + Math.floor(random() * 6)}`]));
      text("yeast_generation", String(2 + Math.floor(random() * 6)));
      text("yeast_amount", `${round(t.capacityBbl * 0.8, 0)} L`);
      if (random() < 0.4) text("brew_notes", pick(["Smooth day.", "Stuck sparge on turn 1, fixed by raking.", "Ran a little long on the boil.", "Hit every number."]));
    }

    // The cellar's work for one batch on day n (what's due today)
    function tend(batch, n) {
      const age = n - batch.start - batch.delay;
      const p = batch.profile;
      // Readings: every day while fermenting hard, every other day after
      if (batch.stage === "fermenting" || batch.stage === "dry-hopping" || (batch.stage === "conditioning" && age % 3 === 0)) {
        if (n - batch.start <= 6 || (n - batch.start) % 2 === 0) {
          const temp = batch.stage === "conditioning" ? F(34 + jitter(1)) : p.fermC + jitter(0.4);
          addCellar(batch, n, { action: "Check", gravitySg: gravityOn(batch, n - batch.start), tempC: round(temp, 2), ph: phOn(batch, n - batch.start) });
        }
      }
      for (const [stage, day] of p.steps) {
        if (age !== day || batch.stage === stage) continue;
        if (stage === "dry-hopping") addCellar(batch, n, { action: "Dry hop", gravitySg: gravityOn(batch, n - batch.start), tempC: p.fermC, cellarChange: "" });
        if (stage === "conditioning") addCellar(batch, n, { action: "Crash", gravitySg: gravityOn(batch, n - batch.start), tempC: F(34), cellarChange: "Crash to 34°F" });
        addEvent(batch, n, stage, batch.tankId);
      }
      // Dry hops, with their lots
      if (p.dryHops.includes(age) && Object.keys(batch.beer.dry).length) {
        const share = 1 / p.dryHops.length;
        for (const [name, lb] of Object.entries(batch.beer.dry)) {
          const amount = round(lb * (batch.sizeBbl / 15) * share, 1);
          d.additions.push({ batchId: batch.id, addedOn: dayString(n), kind: "hop", name, amount, unit: "lb", timing: p.dryHops.length > 1 ? `Dry hop ${p.dryHops.indexOf(age) + 1}` : "Dry hop",
            lot: useRaw(name, amount, "lb", n), notes: "", brewDay: false, turn: null, recordedAt: at(n) });
        }
      }
      if (batch.beer.id === "gose" && age === p.steps[0][1]) {
        const gal = round(batch.sizeBbl * 1.5, 0);
        d.additions.push({ batchId: batch.id, addedOn: dayString(n), kind: "fruit", name: "Raspberry Puree", amount: gal, unit: "gal", timing: "Secondary",
          lot: useRaw("Raspberry Puree", gal, "gal", n), notes: "", brewDay: false, turn: null, recordedAt: at(n) });
      }
      // Transfer to a free brite big enough (or wait a day)
      if (age === p.transfer && tankById[batch.tankId].type === "fermenter") {
        const volume = balance(batch, batch.tankId);
        const brite = d.tanks.filter((t) => t.locationId === batch.location.id && t.type === "brite" && !occupant[t.id]
          && (freeFrom[t.id] ?? -Infinity) <= n && t.capacityBbl >= volume).sort((a, b) => a.capacityBbl - b.capacityBbl)[0];
        if (!brite) { batch.delay += 1; return; }
        const moved = round(volume * (0.95 + random() * 0.02), 2);
        addMovement({ day: n, batchId: batch.id, kind: "transfer", fromTankId: batch.tankId, toTankId: brite.id, volumeBbl: moved });
        addMovement({ day: n, batchId: batch.id, kind: "loss", fromTankId: batch.tankId, volumeBbl: round(volume - moved, 2), notes: "left in the tank" });
        leave(batch.tankId, n, batch);
        batch.tankId = brite.id;
        occupant[brite.id] = batch;
        addEvent(batch, n, "carbonating", brite.id);
        addCellar(batch, n, { action: "Carbonate", tempC: F(33), cellarChange: "Carb to 2.6 vols" });
      }
      if (age === p.ready && batch.stage === "carbonating") {
        addEvent(batch, n, "ready", batch.tankId);
        addCellar(batch, n, { action: "Ready", notes: "Tastes great." });
      }
      // Packaging days are Tuesday and Thursday
      if (age >= p.pkg + batch.wait && batch.stage === "ready" && (weekday(n) === 2 || weekday(n) === 4)) packageBatch(batch, n);
      // Once in the demo's history: a split, and a blend (when the tanks allow)
      if (batch.stage === "ready" && n > -60 && n < -5) splitOrBlend(batch, n);
    }

    // A tank is emptied: it goes to cleaning for a day (and an acid cycle after a Gose, or every 12 turns)
    function leave(tankId, n, batch) {
      delete occupant[tankId];
      freeFrom[tankId] = n + 1;
      lastStyleOut[tankId] = batch.beer.style;
    }

    // Packaging: kegs (and cans for some beers) into the location's storage; the tank is spent
    function packageBatch(batch, n) {
      const volume = balance(batch, batch.tankId);
      const mix = batch.beer.cans ? { half: 0.45, sixth: 0.2, case16: 0.3 } : { half: 0.65, sixth: 0.3 };
      const counts = Object.entries(mix).map(([type, share]) => ({ type, count: Math.floor(volume * share / typeById[type].volumeBbl) })).filter((c) => c.count > 0);
      const run = addMovement({ day: n, batchId: batch.id, kind: "package", fromTankId: batch.tankId,
        volumeBbl: round(counts.reduce((s, c) => s + c.count * typeById[c.type].volumeBbl, 0), 4) });
      const storage = `${batch.location.id[0]}-storage`;
      for (const c of counts) {
        d.packageCounts.push({ movementId: run.id, packageTypeId: c.type, count: c.count, unitVolumeBbl: typeById[c.type].volumeBbl });
        d.stockMoves.push({ occurredOn: dayString(n), kind: "packaged", beerId: batch.beerId, batchId: batch.id, packageTypeId: c.type, count: c.count,
          toPlaceId: storage, sourceMovementId: run.id, recordedAt: at(n) });
        onHand.push({ place: storage, beer: batch.beerId, batch: batch.id, type: c.type, count: c.count, packedOn: n });
      }
      const left = round(volume - run.volumeBbl, 4);
      if (left > 0) addMovement({ day: n, batchId: batch.id, kind: "loss", fromTankId: batch.tankId, volumeBbl: left, notes: "tank spent" });
      addEvent(batch, n, "packaged", null);
      leave(batch.tankId, n, batch);
      active.splice(active.indexOf(batch), 1);
    }

    // Finished goods: take stock out, oldest batch first, never more than is there
    function take(place, beer, type, count, n, move) {
      let left = count;
      const lots2 = onHand.filter((h) => h.place === place && h.beer === beer && h.type === type && h.count > 0).sort((a, b) => a.packedOn - b.packedOn);
      for (const h of lots2) {
        if (!left) break;
        const k = Math.min(h.count, left);
        h.count -= k;
        left -= k;
        d.stockMoves.push({ occurredOn: dayString(n), packageTypeId: type, beerId: beer, batchId: h.batch, count: k, fromPlaceId: place, recordedAt: at(n), ...move });
        if (move.toPlaceId) onHand.push({ place: move.toPlaceId, beer, batch: h.batch, type, count: k, packedOn: h.packedOn });
      }
      return count - left;
    }
    const have = (place, beer, type) => onHand.filter((h) => h.place === place && h.beer === beer && h.type === type).reduce((s, h) => s + h.count, 0);

    // The taprooms: restocked from their own storage twice a week, poured, and counted
    function taproomWork(n) {
      for (const l of LOCATIONS) {
        const storage = `${l.id[0]}-storage`, taproom = `${l.id[0]}-taproom`;
        if (weekday(n) === 1 || weekday(n) === 4) {
          const group = id("grp");
          for (const beer of BEERS) {
            if (have(storage, beer.id, "half") > 0 && have(taproom, beer.id, "half") < 2) {
              take(storage, beer.id, "half", 2 - have(taproom, beer.id, "half"), n, { kind: "moved", toPlaceId: taproom, groupId: group, notes: "Stocked the taproom" });
            }
            if (beer.cans && have(storage, beer.id, "case16") > 2 && have(taproom, beer.id, "case16") < 2) {
              take(storage, beer.id, "case16", 2, n, { kind: "moved", toPlaceId: taproom, groupId: group, notes: "Stocked the taproom" });
            }
          }
        }
        // A weekly count: what's gone was poured (or sold to go)
        if (weekday(n) === 0) {
          const group = id("grp");
          for (const beer of BEERS) {
            const kegs = have(taproom, beer.id, "half");
            const poured = kegs > 0 ? take(taproom, beer.id, "half", Math.min(kegs, 1 + Math.floor(random() * 2)), n, { kind: "removed", removalKind: "taproom", groupId: group, notes: "count" }) : 0;
            // ...each poured keg was kicked on some day that week (its line is filled in once the lines are known)
            for (let k = 0; k < poured; k++) {
              const day = n - Math.floor(kickRandom() * 7);
              d.kicks.push({ placeId: taproom, beerId: beer.id, label: "", packageTypeId: "half", kickedOn: dayString(day), lineNo: null, recordedAt: `${dayString(day)}T22:00:00Z` });
            }
            const cases = have(taproom, beer.id, "case16");
            if (cases > 0) take(taproom, beer.id, "case16", Math.min(cases, 1), n, { kind: "removed", removalKind: "taproom", groupId: group, notes: "count" });
          }
        }
        // Wholesale: twice a week, a few kegs and cases to accounts
        if (weekday(n) === 2 || weekday(n) === 5) {
          for (const beer of BEERS) {
            for (const type of ["half", "sixth", "case16"]) {
              const spare = have(storage, beer.id, type) - (type === "half" ? 6 : 4);
              if (spare > 0 && random() < 0.5) take(storage, beer.id, type, Math.min(spare, 1 + Math.floor(random() * 4)), n,
                { kind: "removed", removalKind: "sold", account: pick(ACCOUNTS), groupId: id("grp"), notes: "" });
            }
          }
        }
      }
    }

    // A new batch from others, the way the app's "Split / blend" makes it: out of each source, into
    // the new batch's tank; the new batch carries on in the cellar like any other
    function makeFrom(sources, beerId, t, n, number) {
      const beer = beerById[beerId];
      const nb = { id: id("batch"), batchNumber: number, beerId, brewDate: dayString(n), sizeBbl: t.capacityBbl, turns: 1, beer,
        profile: PROFILES[beer.profile === "hazy" ? "ale" : beer.profile], og: beer.og, fg: beer.fg, tankId: t.id, delay: 0, location: sources[0].batch.location, wait: 2 };
      nb.start = n - nb.profile.transfer; // (as if it had just been transferred)
      nb.koPh = sources[0].batch.koPh;
      nb.endPh = sources[0].batch.endPh;
      d.batches.push({ id: nb.id, batchNumber: number, beerId, brewDate: dayString(n), sizeBbl: t.capacityBbl, turns: 1 });
      for (const s of sources) {
        addMovement({ day: n, batchId: s.batch.id, kind: "to_batch", fromTankId: s.batch.tankId, volumeBbl: s.volume, sourceBatchId: nb.id, notes: `into #${number}` });
        addMovement({ day: n, batchId: nb.id, kind: "from_batch", toTankId: t.id, volumeBbl: s.volume, sourceBatchId: s.batch.id, notes: `from #${s.batch.batchNumber}` });
      }
      occupant[t.id] = nb;
      active.push(nb);
      addEvent(nb, n, "carbonating", t.id);
    }
    const freeBriteAt = (loc, n, size) => d.tanks.filter((t) => t.locationId === loc && t.type === "brite" && !occupant[t.id]
      && (freeFrom[t.id] ?? -Infinity) <= n && t.capacityBbl >= size).sort((a, b) => a.capacityBbl - b.capacityBbl)[0];
    let split = false, blended = false;
    function splitOrBlend(batch, n) {
      // A split: 12 bbl of a big batch into a small brite, packaged on its own
      if (!split && batch.sizeBbl >= 30 && balance(batch, batch.tankId) > 20) {
        const t = freeBriteAt(batch.location.id, n, 12);
        if (t && t.capacityBbl <= 15) { makeFrom([{ batch, volume: 12 }], batch.beerId, t, n, `${batch.batchNumber}-2`); split = true; return; }
      }
      // A blend: stout and West Coast IPA, both ready, into a one-off
      if (!blended && (batch.beerId === "stout" || batch.beerId === "wcipa")) {
        const other = active.find((x) => x.beerId === (batch.beerId === "stout" ? "wcipa" : "stout") && x.location.id === batch.location.id
          && ["conditioning", "carbonating", "ready"].includes(x.stage) && balance(x, x.tankId) > 20);
        const t = other && freeBriteAt(batch.location.id, n, 30);
        if (t && balance(batch, batch.tankId) > 20) {
          const [stout, ipa] = batch.beerId === "stout" ? [batch, other] : [other, batch];
          makeFrom([{ batch: stout, volume: 15 }, { batch: ipa, volume: 15 }], "blend", t, n, `${stout.batchNumber}/${ipa.batchNumber}`);
          blended = true;
        }
      }
    }

    // ---------- Run the days ----------
    for (let n = -DAYS; n <= 0; n++) {
      for (const batch of [...active]) tend(batch, n);
      if (n < 0) {
        for (const l of LOCATIONS) if (l.brewDays.includes(weekday(n))) brew(n, l);
      }
      // Acid cycles: after a Gose leaves a tank (the day after), and every 12 turns, except in the last week
      for (const t of d.tanks) {
        const due = lastStyleOut[t.id] === "Gose" || (turnsSinceAcid[t.id] || 0) >= 12;
        if (due && !occupant[t.id] && freeFrom[t.id] === n && n < -7) {
          d.cleanings.push({ tankId: t.id, cleanedOn: dayString(n), note: "" });
          lastStyleOut[t.id] = null;
          turnsSinceAcid[t.id] = 0;
        }
      }
      taproomWork(n);
    }
    // One batch fermenting (or dry hopping) today hasn't had a gravity logged for 3 days: the demo
    // shows the "no gravity logged" alert (it watches those two stages, from 3 days)
    const quiet = active.filter((b) => (b.stage === "fermenting" || b.stage === "dry-hopping") && b.start <= -3).sort((a, b) => a.start - b.start)[0];
    // (its checks are skipped; any other work logged keeps its entry, without a gravity)
    if (quiet) {
      const late = (c) => c.batchId === quiet.id && c.occurredOn > dayString(-3);
      d.cellar = d.cellar.filter((c) => !(late(c) && c.action === "Check")).map((c) => (late(c) ? { ...c, gravitySg: null } : c));
    }
    // Another fermenting batch stalled partway (the demo shows the "stalled" check): from its second day
    // its gravity barely moves, well above its target FG. (Its own random sequence: nothing else changes.)
    const stallRandom = rng(777);
    const stalled = active.filter((b) => b !== quiet && b.stage === "fermenting" && b.start <= -5).sort((a, b) => a.start - b.start)[0];
    if (stalled) {
      const plateau = gravityOn(stalled, 2);
      for (const c of d.cellar) {
        const age = Math.round((new Date(`${c.occurredOn}T12:00:00`) - new Date(`${dayString(stalled.start)}T12:00:00`)) / 86400000);
        if (c.batchId === stalled.id && c.gravitySg != null && age >= 2) c.gravitySg = round(plateau - 0.0001 * (age - 2) - stallRandom() * 0.0001, 4);
      }
    }

    // ---------- Today: tanks' statuses ----------
    for (const t of d.tanks) {
      if (!occupant[t.id] && freeFrom[t.id] === 1) t.status = "cleaning";
    }
    const idle = d.tanks.find((t) => !occupant[t.id] && t.status === "empty" && t.type === "fermenter" && t.locationId === "northgate");
    if (idle) idle.status = "maintenance";

    // ---------- Recipes (one turn at each brewhouse), beer schedules ----------
    for (const b of BEERS.filter((x) => x.home.length)) {
      for (const loc of b.home) {
        const l = LOCATIONS.find((x) => x.id === loc), scale = l.turnSizeBbl / 15;
        const r = { id: `recipe-${b.id}-${loc}`, beerId: b.id, locationId: loc, name: `${b.name} (${l.turnSizeBbl} bbl turn)`, batchSizeBbl: l.turnSizeBbl,
          targetOg: b.og, targetFg: b.fg, ibu: b.ibu, colorSrm: b.srm, notes: "", source: "" };
        d.recipes.push(r);
        let pos = 0;
        for (const [name, lb] of Object.entries(b.grain)) d.recipeIngredients.push({ recipeId: r.id, position: pos++, kind: "malt", name, amount: round(lb * scale, 0), unit: "lb", timing: "Mash" });
        Object.entries(b.kettle).forEach(([name, lb], i) => d.recipeIngredients.push({ recipeId: r.id, position: pos++, kind: "hop", name, amount: round(lb * scale, 1), unit: "lb", timing: i === 0 ? "60 min" : "Whirlpool" }));
        for (const [name, lb] of Object.entries(b.dry)) d.recipeIngredients.push({ recipeId: r.id, position: pos++, kind: "hop", name, amount: round(lb * scale, 1), unit: "lb", timing: "Dry hop" });
      }
      const p = PROFILES[b.profile];
      d.schedules[b.id] = [
        ...(p.dryHops.length ? [{ kind: "dry_hop", day: p.dryHops[0], ...(b.profile === "hazy" ? { gravity: round(b.fg + 0.006, 3) } : {}) }] : []),
        { kind: "crash", day: p.steps.at(-1)[1] }, { kind: "transfer", day: p.transfer }, { kind: "package", day: p.pkg },
      ];
    }

    // ---------- The plan: the next two weeks of brew days (one on a tank that won't be empty yet), and more ----------
    for (let n = 1; n <= 14; n++) {
      for (const l of LOCATIONS) {
        if (!l.brewDays.includes(weekday(n))) continue;
        const list = rotation[l.id];
        const beer = list[rotationAt[l.id]++ % list.length];
        const fvs = d.tanks.filter((t) => t.locationId === l.id && t.type === "fermenter" && t.status !== "maintenance");
        const fv = fvs[(n * 7) % fvs.length];
        d.planItems.push({ id: id("plan"), kind: "brew", title: "", plannedOn: dayString(n), someday: "", tankId: fv.id, beerId: beer, batchId: null, notes: "", doneAt: null });
      }
    }
    d.planItems.push({ id: id("plan"), kind: "delivery", title: "Malt delivery", plannedOn: dayString(3), someday: "", tankId: null, beerId: null, batchId: null, notes: "Pale 2-Row and Pilsner, 40 sacks", doneAt: null });
    d.planItems.push({ id: id("plan"), kind: "maintenance", title: "Glycol chiller service", plannedOn: dayString(9), someday: "", tankId: null, beerId: null, batchId: null, notes: "", doneAt: null });
    d.planItems.push({ id: id("plan"), kind: "brew", title: "Märzen for fall", plannedOn: null, someday: "Fall", tankId: null, beerId: "helles", batchId: null, notes: "Bigger, darker, more Munich", doneAt: null });

    // ---------- Raw materials: ready for the plan, except one hop (low, and short for a brew) ----------
    const pale = lots["Pale 2-Row"].at(-1);
    if (pale && pale.left > 60) {
      d.rawAdjustments.push({ itemId: "raw-Pale 2-Row", lot: pale.lot, adjustedOn: dayString(-2), change: -55, reason: "Count: one torn sack", recordedAt: at(-2) });
      pale.left -= 55;
    }
    // What the planned brews will use (as the calendar works it out: the location's recipe, times its usual turns)
    const need = {};
    for (const p of d.planItems.filter((x) => x.kind === "brew" && x.plannedOn && x.tankId)) {
      const loc = LOCATIONS.find((l) => l.id === tankById[p.tankId].locationId);
      const recipe = d.recipes.find((r) => r.beerId === p.beerId && r.locationId === loc.id) || d.recipes.find((r) => r.beerId === p.beerId);
      for (const i of d.recipeIngredients.filter((x) => recipe && x.recipeId === recipe.id)) need[i.name] = (need[i.name] || 0) + i.amount * loc.usualTurns;
    }
    // A delivery two days ago of whatever the plan would run short of (Mosaic is left short on purpose)
    for (const [name, kind, , , packSize, reorder] of RAW) {
      if (name === "Mosaic") continue;
      const left = lots[name].reduce((sum, l) => sum + l.left, 0);
      if (left - (need[name] || 0) >= reorder) continue;
      const packs = Math.ceil(((need[name] || 0) + reorder * 1.5 - left) / packSize);
      const lot = { lot: `${name.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X")}-${++lotNo}`, left: packs * packSize };
      lots[name].push(lot);
      d.rawReceipts.push({ itemId: `raw-${name}`, receivedOn: dayString(-2), lot: lot.lot, amount: packs * packSize, supplier: SUPPLIERS[kind],
        cost: round(packs * packSize * (kind === "hop" ? 14 : kind === "malt" || kind === "adjunct" ? 0.9 : 6), 2), notes: "", recordedAt: null });
    }
    // Mosaic: below its reorder level, with a delivery on the way (after it's needed, so one brew shows short)
    const mosaicLeft = lots.Mosaic.reduce((sum, l) => sum + l.left, 0);
    d.rawItems.find((i) => i.name === "Mosaic").reorderLevel = Math.ceil(mosaicLeft + 30);
    d.rawOrders.push({ itemId: "raw-Mosaic", amount: 88, expectedOn: dayString(12), supplier: SUPPLIERS.hop, notes: "Two boxes" });

    // The one-off blend's last kegs in storage went to a festival yesterday, so it's "Almost gone" on the boards
    for (const l of LOCATIONS) {
      const storage = `${l.id[0]}-storage`;
      for (const type of ["half", "sixth"]) {
        const left = have(storage, "blend", type);
        if (left > 0) take(storage, "blend", type, left, -1, { kind: "removed", removalKind: "sold", account: "Fall beer festival", groupId: id("grp"), notes: "" });
      }
    }

    // ---------- Taprooms: draft lines, pars, a view, and boards ----------
    for (const l of LOCATIONS) {
      const taproom = `${l.id[0]}-taproom`;
      const pouring = BEERS.filter((b) => have(taproom, b.id, "half") > 0).slice(0, 12);
      pouring.forEach((b, i) => d.lines.push({ placeId: taproom, lineNo: i + 1, status: "beer", beerId: b.id, label: "" }));
      d.lines.push({ placeId: taproom, lineNo: pouring.length + 1, status: "other", beerId: null, label: "Guest cider" });
      d.lines.push({ placeId: taproom, lineNo: pouring.length + 2, status: "empty", beerId: null, label: "" });
      // Pars of a keg and a half, two for the best sellers (so a few are under, and "Bring up" shows)
      for (const k of d.kicks.filter((x) => x.placeId === taproom)) k.lineNo = pouring.findIndex((b) => b.id === k.beerId) + 1 || null;
      for (const b of pouring) d.pars.push({ placeId: taproom, beerId: b.id, parBbl: b.id === "hazy" || b.id === "pils" ? 1.5 : 1, parCases: b.cans ? 2 : null });
    }
    for (const b of ["hazy", "wcipa", "pils", "pale"]) d.pars.push({ placeId: null, beerId: b, parBbl: 20, parCases: 30 });
    d.views.push({ name: "Master inventory", placeIds: d.places.map((p) => p.id), splitByPlace: true, typeIds: ["half", "sixth", "case16"],
      show: ["total_bbl", "par_bbl", "pipeline"], beers: "stock_or_par", sortMode: "az", position: 0 });
    d.boards.push(
      { placeId: "r-taproom", title: "On tap", orderBy: "sections", showComingSoon: true, showToGo: false, name: "TV 1: drafts", layout: "columns",
        parts: ["number", "color", "name", "almost", "tags", "style", "abv", "words", "prices"], sectionOrder: [], theme: { scheme: "chalkboard", head: "Oswald", body: "Roboto" }, showOnTap: true },
      { placeId: "r-taproom", title: "Riverside menu", orderBy: "sections", showComingSoon: true, showToGo: true, name: "Website menu", layout: "list",
        parts: ["color", "name", "almost", "tags", "style", "abv", "ibu", "words", "fields", "prices"], sectionOrder: [], theme: { scheme: "auto" }, showOnTap: true },
      { placeId: "n-taproom", title: "Northgate taproom", orderBy: "lines", showComingSoon: true, showToGo: false, name: "TV 1: drafts", layout: "cards",
        parts: ["number", "color", "name", "almost", "tags", "style", "abv", "ibu", "words", "prices"], sectionOrder: [], theme: { scheme: "midnight", head: "Bebas Neue", body: "Lato" }, showOnTap: true },
      { placeId: "n-taproom", title: "To go", orderBy: "lines", showComingSoon: false, showToGo: true, name: "TV 2: cans to go", layout: "compact",
        parts: ["name", "style", "abv", "prices"], sectionOrder: [], theme: { scheme: "kraft", head: "Rye", body: "Lora" }, showOnTap: false },
    );

    return d;
  }

  window.DemoBrewery = { make, DAYS };
})();
