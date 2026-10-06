# Brewery OS

A simple web app for small craft breweries that replaces the whiteboard, clipboard, or spreadsheet used to track what's in every tank.

**Live prototype:** https://chrisbohn8.github.io/brewery-os/

> **Status: early prototype.** It works, and it's useful for trying out ideas on the brew floor, but it is **not ready for real production records**. Data lives only in the browser you entered it in (see [Known limitations](#known-limitations)). Use it with sample data or as a scratchpad, not as your system of record.

---

## The core job

A brewer glances at a phone on the floor and instantly knows:

- what's in every tank,
- what stage each batch is at, and
- how long it's been there.

Everything else (brew logs, packaging, inventory, TTB reporting) builds on that foundation.

---

## Product requirements

These shape every decision, even for features that come later:

- **Phone-first on the floor, paper where hands are wet.** The dashboard is built for a quick glance at a phone. Brew-day data entry also needs a **printable brew sheet**, because wet hands on the brew deck make phones awkward. Each printed sheet carries a **QR code that opens that exact batch** in the app, so numbers written on paper can be entered later from the sheet.
- **Everything the brewery sets up is data,** not code: locations, tanks, beers, and (later) recipes. Admins create and change them in the app.
- **Multi-tenant from the start of the backend.** This will serve many breweries. Every record will belong to a brewery, and one brewery can never see another's data.
- **Accurate volumes and history,** because TTB reporting depends on them.

---

## What it does today

### Tank dashboard
- One card per tank, **grouped by location**, for breweries with more than one facility.
- Each card shows the tank's beer and style, batch number, batch size, brew date, the current **stage** as a colored badge, and **days in stage** in large type.
- Empty tanks show their status (**Empty**, **Cleaning**, or **Maintenance**) and their capacity.
- Designed for phones first: one column on a phone, more columns on wider screens, and large tap targets.

### Batches
- Tap a full tank to edit its batch. Tap an empty tank to start a new one.
- Stages: Fermenting → Dry hopping → Conditioning → Carbonating → Ready → Packaged.
- Changing the stage sets the stage start date to today, which you can change.
- **Transfer** a batch by changing its tank, for example FV-3 → BT-2.
- **Package** a batch to take it out of its tank. It moves to the "Packaged batches" list.
- Guardrails:
  - Batch numbers must be unique (blocked).
  - Only one batch per tank (blocked).
  - Filling a tank marked Cleaning or Maintenance asks you to confirm.
  - A batch bigger than the tank's capacity asks you to confirm.
- When beer leaves a tank, that tank is automatically marked **Cleaning**.

### Locations
- The brewery's facilities, as their own records: add, rename, or delete them in the Locations list, or with "+ New location…" right from the tank form.
- A location that still has tanks can't be deleted.

### Tanks
- Name, type (fermenter, brite, serving, or lagering), capacity in bbl, location, and status.
- Set them up once with "+ Add tank" and change them through "Tank settings" in the batch form.
- A tank with beer in it can't be deleted.

### Beers
- The product itself, separate from any one brew of it: name, style, target OG, and target FG.
- Target ABV is **calculated** from OG and FG: (OG − FG) × 131.25.
- Add beers from the Beers list or right from the batch form ("+ New beer…").
- A beer that has batches can't be deleted.

### Backup
- **Download** saves everything (locations, beers, tanks, batches) as one `.json` file.
- **Restore…** loads a backup file, after showing what's in it and asking you to confirm. It replaces everything on the device.
- Files that aren't backups are rejected without touching your data. Backups from older versions are upgraded automatically, the same way saved data is.

---

## How it's built

Plain HTML, CSS, and JavaScript, with no frameworks, no build step, and no server. That keeps it easy to read and follow.

| File | What's in it |
|---|---|
| `index.html` | Page structure: the tank area; the packaged, beer, and location lists; the backup buttons; and the pop-up forms for batches, tanks, beers, and locations. |
| `style.css` | The look. Colors are defined once at the top, one per stage and status, with a dark mode. |
| `app.js` | Everything the page does, in numbered sections: fixed lists → helpers → sample data → saving/loading → lookups → drawing → batch, tank, beer, and location forms → backup → wiring up taps. |
| `.claude/launch.json` | Starts a small local web server for previewing while developing. |

### Running it locally

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123.

### Deploying

The site is served by **GitHub Pages** from the `master` branch. Pushing to `master` updates the live site within a minute or two.

---

## The data model

Four records form the foundation. The rule of thumb: **define a record early if other records point at it.** Batches point at beers and tanks, and tanks point at locations, so all four exist now. Nothing points at inventory items, kegs, or users yet, so those wait for their modules.

```
LOCATION  (a facility)
  id            hidden internal ID, never changes
  name          "Downtown"

BEER  (the product: "House Hazy")
  id            "house-hazy": readable, made from the name, never changes
  name          "House Hazy"
  style         "Hazy IPA"
  targetOg      1.066
  targetFg      1.016
  (target ABV is calculated, not stored)

TANK  (equipment, mostly static)
  id            hidden internal ID, never changes
  name          "FV-1"
  type          fermenter | brite | serving | lagering
  capacityBbl   15
  locationId    → LOCATION (or none)
  status        empty | cleaning | maintenance
                ("occupied" is worked out: a tank is occupied when a batch is in it)

BATCH  (one actual brew: the living record)
  id              hidden internal ID, never changes
  batchId         "1042": the brewer's batch number
  beerId          → BEER
  tankId          → TANK (where it is now, or where it was last if packaged)
  brewDate        2026-10-01
  sizeBbl         15
  stage           fermenting | dry-hopping | conditioning | carbonating | ready | packaged
  stageStartDate  drives the "days in stage" counter
```

### Design decisions worth knowing

- **Each link is stored in one place only.** A batch records which tank it's in. The tank does *not* also record which batch it holds, because the two copies could drift apart. The tank's current batch is looked up whenever it's needed, and so are "occupied" status and target ABV.
- **Dates, not counts.** The app stores the date a stage started, so "days in stage" goes up by itself every day.
- **Hidden IDs.** Renaming a tank or fixing a typo in a batch number never breaks links between records.
- **Saved data upgrades itself.** When the data shape changes, older saved data is converted on load, so nothing is lost between versions.
- **Hard stops vs. warnings.** Mistakes that would corrupt records, like a duplicate batch number or two batches in one tank, are blocked. Situations that might be fine, like a tank you just finished cleaning or a slightly overfilled tank, only ask you to confirm.

---

## Known limitations

These are the reasons it isn't production-ready yet:

1. **Data lives in one browser on one device.** It's saved in the browser's local storage, so your phone and laptop each have a separate copy, and clearing browser data erases it. The Backup buttons are the safety net until there's a shared database.
2. **No accounts or permissions.** Anyone with the link sees the app, but only their own browser's data.
3. **No history.** When a batch changes stage or tank, the old value is overwritten. The app knows where a batch is, not where it's been. Traceability and TTB reporting both need that history (see Phase 2).
4. **No measurements yet:** gravity, temperature, pH, and actual ABV.
5. **Packaging is only a stage.** It doesn't record yield, package counts, or losses.

---

## Roadmap

The order follows dependencies: each phase sets up what the next one needs. **Brew log → packaging → inventory → TTB** is the backbone, and recipes and costing come last.

One deliberate split: the backup (a quick safety net) is done now, but the **shared database comes right after the brew log**, not before. The brew log adds the biggest new pieces of data (brew-day numbers, readings, event history), and the database is easier to design once that shape is settled.

### ✅ Phase 0: Foundation (done)
- [x] Tank dashboard with stage and days in stage
- [x] Batches as their own records: transfer between tanks, packaging, guardrails
- [x] Tank details: type, capacity, status
- [x] Beers as products, with targets and calculated ABV
- [x] Locations as their own records
- [x] Hosted on GitHub Pages

### ✅ Phase 1: Safety net (done)
- [x] **Backup and restore** as a JSON file

### Phase 2: Brew log and history (next)
The as-brewed record for each batch, compared against its beer's targets.
- [ ] **Event history per batch.** Record every stage change and transfer (date, from, to, volume) instead of overwriting. Traceability, the CIP log, and TTB reporting are all built on this. Stage and tank may become "the latest event" rather than fields that get overwritten.
- [ ] **Brew-day actuals:** key numbers such as mash temp and pH, pre-boil gravity, OG, volume to fermenter, yeast and pitch temp. Exact fields come from the brewery's current brew sheet.
- [ ] **Fermentation log:** gravity and temperature readings over time, FG, pH.
- [ ] **Actual ABV**, calculated from actual OG and FG, plus **target vs. actual**: is 1042 hitting House Hazy's numbers?
- [ ] **Fermentation curve:** a simple chart of gravity and temperature over time.
- [ ] **Printable brew sheet** for each batch, laid out for pen and paper, with a **QR code** that opens that batch in the app.
- [ ] **Open a batch from a link** (what the QR code points at).
- [ ] **Brewer notes** per batch.

### Phase 3: Shared data, sign-in, and multiple breweries
Turns the prototype into something a brewery can rely on.
- [ ] **Shared database.** One copy of the data that every phone and computer reads and writes. This needs a hosted backend, since GitHub Pages can only serve files. Hosted database services like Supabase or Firebase are the likely candidates and keep server code to a minimum.
- [ ] **Multi-tenant from day one:** every record belongs to a brewery, and access rules keep each brewery's data separate.
- [ ] **Sign-in and roles** (for example admin, brewer, read-only). This is when "users" become a record. Admins manage locations, tanks, beers, and recipes.
- [ ] **QR codes work on any phone.** Before this phase, a batch only exists in the browser it was entered on.
- [ ] **Move existing data in** from a backup file.
- [ ] **Basic offline tolerance.** Brew floors have bad Wi-Fi. At minimum, the app should show the last data it loaded and clearly say when a save didn't go through.

### Phase 4: Tank care
- [ ] **CIP log:** a record each time a tank is cleaned (date, who, what chemicals). "Last CIP date" comes from this log.
- [ ] **Tank batch history,** looked up from batch events: everything that's been through FV-1.
- [ ] **Tank notes:** quirks, gasket replacements, maintenance history.

### Phase 5: Packaging
- [ ] **Package a batch for real:** package date, yield in bbl, and package counts (½ bbl, ¼ bbl, ⅙ bbl kegs, cans).
- [ ] **Losses:** the difference between batch size and yield (dumps, tank bottoms, packaging loss). TTB cares about this.
- [ ] Packaged batches become finished-goods inventory (Phase 6).

### Phase 6: Inventory
- [ ] **Finished goods:** kegs and cases on hand per beer and batch, and removals (sold, transferred, donated, dumped).
- [ ] **Keg tracking:** which kegs are full, empty, or out at accounts.
- [ ] **Raw materials:** malt, hops, yeast, and chemicals on hand, used up by batches as they're brewed.

### Phase 7: TTB reporting
The payoff for keeping accurate volumes at every step.
- [ ] **Brewer's Report of Operations** (TTB F 5130.9): beer produced, received, transferred, removed, and lost over the reporting period, calculated from batch events, packaging, and inventory.
- [ ] **Excise tax return support** (TTB F 5000.24): taxable removals for the period.
- [ ] Export in a format that's easy to copy into the TTB forms. Accuracy here depends entirely on the history from Phase 2 and the volumes from Phases 5–6. That's why those phases come first.

### Phase 8: Recipes and costing
- [ ] **Recipe builder (admins):** grain bill, hop schedule, yeast strain, and process notes on each beer.
- [ ] **As-brewed snapshot:** each batch keeps a copy of the recipe as it was actually brewed, so later recipe changes don't rewrite history.
- [ ] **Printable brew sheets pre-filled from the recipe:** target numbers and additions already printed, with blanks for the actuals.
- [ ] **Ingredient cost per batch** and cost per barrel, using raw-material inventory from Phase 6.

### Phase 9: Ready for other breweries
Multi-tenancy itself arrives in Phase 3. This phase is about letting a new brewery sign up on its own.
- [ ] **Self-serve onboarding:** set up locations, tanks, and beers in a few minutes.
- [ ] **Billing.**
- [ ] Possibly a big-screen "cellar TV" view of the dashboard.

---

## Project history

| Commit | Change |
|---|---|
| `997bf62` | First tank dashboard: tanks with a beer, stage, and day counter |
| `1ff6bf1` | Batches split out from tanks: transfers, packaging, guardrails |
| `41cc5fa` | Tank details: type, capacity, location, status |
| `0d32d75` | Beers split out from batches: style, targets, calculated ABV |
