# Brewery OS

A simple web app for small craft breweries that replaces the whiteboard, clipboard, or spreadsheet used to track what's in every tank.

**Live prototype:** https://chrisbohn8.github.io/brewery-os/

> **Status: early prototype.** Data is now saved in a shared database, so every phone and computer signed in to a brewery sees the same tanks. It is still **not ready for real production records** (see [Known limitations](#known-limitations)). Use it to try things out, with sample data or real tanks, alongside your current records.

---

## Mission

**Give small breweries a production record they can trust, on the floor, in any conditions.** A tool that freezes, loses an entry, or shows the wrong number gets abandoned for the whiteboard, so everything is built to three standards:

- **Reliable.** What the screen says is saved is saved, exactly once. Volumes and dates are right, because taxes and traceability depend on them.
- **Robust.** Handles real brewery conditions: bad signal, wet hands, a busy crew, honest mistakes. Each action is saved whole or not at all, and the app blocks records that can't be true (two beers in one tank, a duplicate batch number).
- **Resilient.** Keeps working when something fails, and recovers on its own. It works offline and syncs when the signal returns, keeps backups, and has a paper brew sheet to fall back on.

When a feature and these three conflict, the three win. Simple beats clever, as long as the result is right.

---

## Getting started

1. Open the live app and sign in with your email. You'll get an email with a 6-digit code: type it in (works on any device), or tap the link in the email.
2. The first time, create your brewery. You become its admin.
3. Start from **Sample data**, a **backup file**, data saved by the earlier browser-only version (**Data saved in this browser**, shown when there is some), or add your own tanks.

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
- **Works offline.** Brew floors and cellars have bad Wi-Fi. The app keeps working without a connection, holds onto what you enter, and syncs when the signal comes back, without losing or duplicating anything.
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

### Batch history
- Every stage change and transfer is recorded with its date. Nothing is overwritten, so the records show where each batch has been, not just where it is.
- A transfer keeps the "days in stage" counter; a stage change restarts it.
- Changing a batch's "stage started" date corrects the history instead of adding to it.

### Accounts and breweries
- Sign in by email code or link; no passwords.
- Each brewery's data is kept completely separate by the database itself (row-level security), and roles control who can change things: **admin**, **brewer**, and **viewer** (read-only).

### Backup
- **Download** saves everything in the brewery (locations, beers, tanks, batches, and history) as one `.json` file.
- **Load…** puts a backup into an **empty** brewery (so nothing is mixed up or duplicated), after showing what's in it and asking you to confirm. If loading fails partway, the brewery is emptied again rather than left half-loaded.
- Files that aren't backups are rejected. Backups from older versions are upgraded automatically.

---

## How it's built

Plain HTML, CSS, and JavaScript with no frameworks and no build step, so it's easy to read and follow. Data lives in **[Supabase](https://supabase.com)** (hosted Postgres with sign-in), which the page talks to directly. The database's own rules keep breweries apart and records consistent, so they hold no matter what the page does.

| File | What's in it |
|---|---|
| `index.html` | Page structure: the tank area; the packaged, beer, and location lists; the backup buttons; and the pop-up forms for batches, tanks, beers, and locations. |
| `style.css` | The look. Colors are defined once at the top, one per stage and status, with a dark mode. |
| `app.js` | Everything the page does, in numbered sections: fixed lists → helpers → sample data → connecting to the database → lookups → drawing → batch, tank, beer, and location forms → backups → sign-in → wiring up taps. |
| `supabase/migrations/` | The database design, one file per change, applied in order. |
| `supabase/tests/` | Database tests: breweries can't reach each other's data, roles are enforced, saving a batch is all-or-nothing. |
| `supabase/config.toml`, `supabase/templates/` | Settings for the local test copy of the database, and the sign-in email wording. |
| `.claude/launch.json` | Starts a small local web server for previewing while developing. |

### Running it locally

On your own computer (`localhost`), the app uses a **private test copy** of the database instead of the real one, so testing never touches real data. It needs [Docker](https://www.docker.com/) and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
supabase start
```

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123 and sign in with any made-up `@example.test` address. The sign-in code arrives in the local test inbox at http://127.0.0.1:54324.

Database changes and tests:

```bash
supabase test db
```

```bash
supabase db push --linked
```

The first runs the tests on the local copy (add `--linked` to run them on the real project); the second applies new files in `supabase/migrations/` to the real project.

### Deploying

The site is served by **GitHub Pages** from the `master` branch. Pushing to `master` updates the live site within a minute or two.

---

## The data model

Every record belongs to a **brewery**, and people belong to breweries through **memberships** (with a role). Inside a brewery, four records form the foundation. The rule of thumb: **define a record early if other records point at it.** Batches point at beers and tanks, and tanks point at locations, so all four exist now. Nothing points at inventory items or kegs yet, so those wait for their modules. The full design is in `supabase/migrations/`.

```
LOCATION  (a facility)
  id            hidden internal ID, never changes
  name          "Downtown"

BEER  (the product: "House Hazy")
  id            hidden internal ID, never changes
  code          "house-hazy": readable, made from the name, never changes
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
  batchNumber     "1042": the brewer's batch number
  beerId          → BEER
  brewDate        2026-10-01
  sizeBbl         15

BATCH EVENT  (the batch's history: rows are only ever added)
  batchId         → BATCH
  effectiveDate   the day it happened (on the person's device, so offline entries keep their date)
  stage           fermenting | dry-hopping | conditioning | carbonating | ready | packaged
  tankId          → TANK (none once packaged)

  A batch's current stage, tank, and "stage started" date are worked out from its
  newest events (the batch_status view), never stored twice.
```

### Design decisions worth knowing

- **Each link is stored in one place only.** A batch records which tank it's in. The tank does *not* also record which batch it holds, because the two copies could drift apart. The tank's current batch is looked up whenever it's needed, and so are "occupied" status and target ABV.
- **Dates, not counts.** The app stores the date a stage started, so "days in stage" goes up by itself every day.
- **Hidden IDs.** Renaming a tank or fixing a typo in a batch number never breaks links between records.
- **History is added, never overwritten.** Stage changes and transfers add batch events, which is what traceability and TTB reporting need.
- **One action, one all-or-nothing step.** Saving a batch (its details, history, and both tanks' statuses) is a single database function: all of it happens or none of it. Repeating the same save changes nothing, which makes retries safe.
- **The database enforces the rules.** One batch per tank, unique batch numbers, and "a tank with history can't be deleted" are checked by the database itself, so even an out-of-date phone can't break them.
- **Old data upgrades itself.** Backups and data from earlier versions are converted when loaded, so nothing is lost between versions.
- **Hard stops vs. warnings.** Mistakes that would corrupt records, like a duplicate batch number or two batches in one tank, are blocked. Situations that might be fine, like a tank you just finished cleaning or a slightly overfilled tank, only ask you to confirm.

---

## Known limitations

These are the reasons it isn't production-ready yet:

1. **Needs a connection.** It doesn't work offline yet (planned in Phase 3).
2. **No way to invite coworkers yet.** Each person who signs in creates their own brewery; adding members to an existing brewery is next.
3. **Sign-in emails are limited** to a few per hour (Supabase's free email service) until a dedicated email service is connected.
4. **Pop-up messages** ("Are you sure?") use the browser's built-in boxes, which some apps block. They'll move onto the page.
5. **No measurements yet:** gravity, temperature, pH, and actual ABV.
6. **Packaging is only a stage.** It doesn't record yield, package counts, or losses.

---

## Roadmap

The order follows dependencies: each phase sets up what the next one needs. **Brew log → packaging → inventory → TTB** is the backbone, TTB reports are the first feature breweries are expected to pay for, the taproom loop (POS sync, state returns) follows, and recipes and costing come last. Out of scope by design: CRM, delivery routes, wholesale ordering, and full accounting (export to QuickBooks instead).

The shared database (Phase 3) was pulled ahead of the brew log: real crews can only try the app once data is shared, and multi-tenancy and offline are easier to build in from the start than to add later.

### ✅ Phase 0: Foundation (done)
- [x] Tank dashboard with stage and days in stage
- [x] Batches as their own records: transfer between tanks, packaging, guardrails
- [x] Tank details: type, capacity, status
- [x] Beers as products, with targets and calculated ABV
- [x] Locations as their own records
- [x] Hosted on GitHub Pages

### ✅ Phase 1: Safety net (done)
- [x] **Backup and restore** as a JSON file

### Phase 2: Brew log and history
The as-brewed record for each batch, compared against its beer's targets.
- [ ] **Event history per batch.** Record every stage change and transfer (date, from, to, volume) instead of overwriting. Traceability, the CIP log, and TTB reporting are all built on this. Stage and tank may become "the latest event" rather than fields that get overwritten.
- [ ] **Brew-day actuals:** key numbers such as mash temp and pH, pre-boil gravity, OG, volume to fermenter, yeast and pitch temp. Exact fields come from the brewery's current brew sheet.
- [ ] **Fermentation log:** gravity and temperature readings over time, FG, pH.
- [ ] **Actual ABV**, calculated from actual OG and FG, plus **target vs. actual**: is 1042 hitting House Hazy's numbers?
- [ ] **Fermentation curve:** a simple chart of gravity and temperature over time.
- [ ] **Printable brew sheet** for each batch, laid out for pen and paper, with a **QR code** that opens that batch in the app.
- [ ] **Open a batch from a link** (what the QR code points at).
- [ ] **Brewer notes** per batch.

### Phase 3: Shared data, sign-in, multiple breweries, and offline (in progress)
Turns the prototype into something a brewery can rely on.
- [x] **Database design** on Supabase (hosted Postgres): breweries, members and roles, locations, tanks, beers, batches, and append-only batch history, with row-level security and tests proving breweries can't reach each other's data (`supabase/`).
- [x] **App switched to the shared database:** one copy of the data that every phone and computer reads and writes.
- [x] **Multi-tenant from day one:** every record belongs to a brewery, and access rules keep each brewery's data separate.
- [x] **Sign-in** by emailed code or link, and **roles** (admin, brewer, viewer) enforced by the database.
- [ ] **Invite coworkers** to a brewery, and let admins change roles.
- [ ] **A dedicated email service** for sign-in codes, so the free tier's few-per-hour limit doesn't lock people out.
- [ ] **QR codes work on any phone** (now possible: every batch lives in the shared database).
- [x] **Move existing data in** from a backup file or from the browser-only version.
- [x] **Saving a batch is one all-or-nothing step** (batch, history, and tanks together).
- [ ] **Loading a backup as one all-or-nothing step** too. Today it empties the brewery again if loading fails partway. (Other changes, like editing a tank, beer, or location, are already a single step.)
- [ ] **Works offline:** the app opens and shows the last data without a connection; changes made offline are queued on the device and sent in order when the signal returns; the screen always shows what's saved and what's still waiting.
- [ ] **Simple conflict rule:** in a small crew two people rarely change the same thing at once, so there's no merge tool. Changes apply in the order they reach the database. If one can't apply (a duplicate batch number, a tank someone else just filled), the database's checks reject it and the person who made it sees why. Nothing is silently dropped.

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

### Phase 8: Taproom connection (POS sync)
- [ ] Connect one point-of-sale system first (chosen by what pilot breweries use), so taproom sales draw down keg and serving-tank levels and count as taxable removals for TTB.

### Phase 9: State returns
- [ ] State excise returns built from the same records as TTB, starting with **California**, which requires a return every month even with no activity.

### Phase 10: Recipes and costing
- [ ] **Recipe builder (admins):** grain bill, hop schedule, yeast strain, and process notes on each beer.
- [ ] **As-brewed snapshot:** each batch keeps a copy of the recipe as it was actually brewed, so later recipe changes don't rewrite history.
- [ ] **Printable brew sheets pre-filled from the recipe:** target numbers and additions already printed, with blanks for the actuals.
- [ ] **Ingredient cost per batch** and cost per barrel, using raw-material inventory from Phase 6.

### Phase 11: Ready for other breweries
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
