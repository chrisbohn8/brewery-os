# Brewery OS

A simple web app for small craft breweries that replaces the whiteboard, clipboard, or spreadsheet used to track what's in every tank.

**Live prototype:** https://brew.chrisbohn.org/

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

### Acid tracking
- Each tank keeps a log of its **acid cycles** (date and an optional note). Log one with "Log acid cycle…" in the tank's settings; remove one logged by mistake from the same list.
- **Turns** are worked out, not typed: one turn is one batch that has left the tank (transferred out or packaged) since its last acid cycle.
- A tank is flagged **"Acid due"** on its card when it has reached its own **"acid every X turns"** setting, or when a batch of one of the brewery's **acid-after styles** has left it (for example Sour or Brett). The reason shows next to the flag.
- The acid-after styles are **one list for the whole brewery**, in the "Acid cleaning" section. Only admins can change it.
- Starting a batch in a tank that's due asks first ("due for an acid cycle… put it in anyway?"). It's a warning, not a block, because the acid may have been run and not logged yet.

### Beers
- The product itself, separate from any one brew of it: name, style, target OG, and target FG.
- Target ABV is **calculated** from OG and FG: (OG − FG) × 131.25.
- Add beers from the Beers list or right from the batch form ("+ New beer…").
- A beer that has batches can't be deleted.

### The batch page and cellar log
- **Tap a full tank** to open its batch's page: stage, days in stage, tank and location, and three lists: **cellar log**, **additions**, and **history** (stage changes and transfers). "Stage / transfer…" opens the batch form.
- **Log cellar work:** date, action item (Check, Tank sample, Dry hop, Rouse, Crash, Harvest, Drain, Spund, …), gravity, pH, and temperature in the brewery's units, a **cellar change** ("FR to 62", spunded, slow crash), and notes. Actions like *Dry hop* or *Crash* offer to move the batch to the matching stage in the same step, so the tank board keeps itself current.
- **Additions:** dry hops, spices, and fruit, with amount, timing, and **lot number**.
- Entries can be corrected (marked "edited") or deleted, and all of it works offline.
- **Brewhouse settings per location** (Settings → Equipment → a location): turn size, usual turns per batch, kettle-full volume, flow target, water-to-grist ratio, and grain absorption, used by the brew-day sheet.

### The brew-day sheet
- **"Brew-day sheet"** on a batch's page, in paper order: brew day, water treatment, mash, lauter and runoff, boil and whirlpool, gravity, pH, knockout, fermenter and yeast, time log, cleaning sign-offs, and notes.
- **Each brewery chooses its fields** (Settings → Brew sheet) from a catalog of about 100: water salts and acids, step-mash temps, lauter pressure, post-boil volume and gravity, knockout temperature, dissolved oxygen, yeast viability, cell count and pitch rate, cleaning sign-offs, and more. A usual set is ticked to start. Unticking a field never hides anything already recorded: a batch always shows every field it has a value for.
- **Add your own fields** for anything the catalog doesn't have: a name, the section it belongs in, and the kind of value (a number with your unit, temperature, gravity, volume, pH, time, or text).
- **Turns are tabs** (Turn 1, Turn 2, …). A new batch starts with its brewhouse's usual number of turns, and the count can be changed on the sheet. Yeast, knockout volume, and notes belong to the whole batch.
- **Targets show next to each field**: fixed ones from the sheet (sparge 168 °F, pH ranges), the brewhouse's (flow, kettle full), and the beer's OG for knockout and tank-sample gravity.
- **Water worked out from grist weight** with the brewhouse settings: mash water = grist × water-to-grist ÷ 4; total = kettle full × 31 + grist × grain absorption; sparge = total − mash.
- **Flow meter fields** take the start and end readings and save the difference.
- **Each value saves as soon as you leave its box**, also with no signal. Values far from their target are highlighted ("Typo?"); how far is adjustable in Settings → Brewery (by default 1 °P, 3 °F, 0.15 pH, 10% for volumes), and each flag can be turned off. Corrections keep the earlier value in the database's history.

### Staying up to date
- A tab left open keeps running the version it opened with. Every 10 minutes, and when you come back to the app, it checks whether a newer version has been published and, if so, shows **"A new version of the app is ready. Reload"**. It never reloads by itself, since someone might be typing.
- Reloading always gets the newest version (the offline copy checks with the server each time).

### The printed brew sheet
- **"Print brew sheet"** on a batch's page (or "Print" on its brew-day sheet) prints one Letter page to fill in by hand on the brew deck: the same fields in the same order, **a box per turn**, targets alongside (water written as the formula, since grist isn't weighed yet), and a line for the brewers.
- Values already entered are printed in their boxes, so a sheet can be reprinted mid-brew.
- A **QR code** opens that batch in the app (after signing in, if needed) to type the numbers in. With no signal, the link is printed instead.

### Batch history
- Every stage change and transfer is recorded with its date. Nothing is overwritten, so the records show where each batch has been, not just where it is.
- A transfer keeps the "days in stage" counter; a stage change restarts it.
- Changing a batch's "stage started" date corrects the history instead of adding to it.

### Works with no signal
- The app keeps a copy of itself and of the last data it loaded on the device. With no signal it still opens and shows the tank board, under a banner like "Offline · showing data from 10:42 AM · 2 changes waiting to send".
- **Floor work can be done offline:** starting a batch, stage changes, transfers, packaging, tank status and settings, and logging an acid cycle. Each change shows on screen right away and is kept on the phone (it survives closing the app) until there's signal.
- When signal returns, the waiting changes are sent **in the order they were made**. If the database refuses one (say a coworker filled that tank first), a note on the page says exactly which change wasn't saved and why, and the screen shows what's really in the tanks. Nothing is silently dropped.
- If the connection drops in the middle of a save, the change is kept and sent later, rather than leaving you guessing.
- Setup changes (adding or deleting beers, locations, and tanks; backups) still need signal and say so.
- When signal returns, the app reloads by itself. It also refreshes whenever you come back to it (phone unlocked, tab switched back).
- If the network is very slow, the app opens from the device copy after a few seconds instead of hanging.
- Signing out deletes the device copy, which matters on a shared phone or tablet. If changes haven't been sent yet, it warns first.

### Brewery settings (units)
- An admin picks the brewery's **temperature** (°F/°C), **gravity** (Plato/SG/Brix), and **volume** (bbl/hL/gal) units, and its **time zone**. Everyone sees and types numbers in those units: beer targets, tank capacities, and batch sizes.
- Values are stored in one standard unit (SG, °C, US barrels), so changing a unit never changes a record. Opening a form and saving it without changes keeps the stored value exactly (no rounding drift).

### Settings and permissions
- The main screen is the tank board. Everything else is under **⚙︎ Settings**, which has these pages: Brewery (name, units, time zone), Equipment (tanks, locations), Beers, Cleaning (acid rules), Team & permissions, Backup, and My account.
- Each person has a **level**, and the database enforces what it allows:

  | Level | By default can |
  |---|---|
  | **Viewer** | look only |
  | **Cellar** | log readings and cellar work, set tank status, log acid cycles, change stages and transfer beer, package beer |
  | **Brewer** | everything Cellar can, plus start batches and edit batch details |
  | **Head brewer** | everything Brewer can, plus beers, tanks and locations, acid rules, units |
  | **Admin** | everything, including the team, permissions, renaming the brewery, backups, and deleting things |

- Admins can change **what a level includes** for their brewery (the table under Team & permissions), or **adjust one person** on top of their level. When an admin changes a person's permission, the app asks: *just this person, or everyone at their level?*
- The checks are fine-grained: a cellar person can set a tank to "Cleaning" but not rename it, and can transfer a batch but not change its batch number. Buttons a person can't use are hidden or greyed out.

### Accounts, breweries, and team
- Sign in by email code or link; no passwords. Sign-in emails come from `noreply@brew.chrisbohn.org`.
- **Invite coworkers:** in the Team section, an admin enters a coworker's email and picks a role. The coworker opens the app and signs in with that email; they join the brewery automatically. **The invite is emailed** to them (who invited them, the brewery, the level, and which address to sign in with), sent by a small server function ([supabase/functions/send-invite](supabase/functions/send-invite/index.ts)) that only a brewery's admins can use. "Email again" resends it.
- Admins change levels and remove people from Team & permissions. A brewery always keeps at least one admin: the database refuses to remove or demote the last one.
- Someone who belongs to more than one brewery picks which one to work in under Account; the choice is remembered.
- Each brewery's data is kept completely separate by the database itself (row-level security), and roles control who can change things: **admin**, **brewer**, and **viewer** (read-only).

### Backup
- **Download** saves everything in the brewery (locations, beers, tanks, batches, history, the acid log, and the acid-after styles) as one `.json` file.
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
| `supabase/tests/` | Database tests: breweries can't reach each other's data, roles are enforced, saving a batch is all-or-nothing, acid tracking, and invites (including "a brewery always keeps an admin"). |
| `supabase/after-restore.sql` | Run after restoring a backup into a new project: re-locks the functions only signed-in people may use. |
| `supabase/config.toml`, `supabase/templates/` | Settings for the local test copy of the database, and the sign-in email wording. |
| `sw.js` | The service worker: keeps a copy of the app's files on the device so it opens with no signal. |
| `tests/browser/` | Browser tests: real Chrome clicking through the app like a brewer (batches, acid tracking, offline viewing, offline recording with a coworker conflict, and team invites and roles), against the local test copy of the database. |
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

Browser tests (need Google Chrome, Node.js, and the local test copy running):

```bash
cd tests/browser && npm ci && npm run setup && npm test   # setup: test breweries in the local copy (once after a reset)
```

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
  acidEveryTurns  4: flag for acid after this many batches (or none)

TANK CLEANING  (the acid log: one row per acid cycle)
  tankId        → TANK
  kind          acid (room for caustic and others later)
  cleanedOn     2026-10-06
  note          "Acid #2, 30 min recirc"

  Turns since the last acid cycle, and whether a tank is due, are worked out from
  this log and the batch events, never stored. The brewery's acid-after styles
  ("Sour", "Brett") are one list on the brewery record.

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

1. **Setup changes need a connection.** Floor work (batches, tanks, acid) works offline; adding or deleting beers, locations, and tanks doesn't yet.
2. **Pop-up messages** ("Are you sure?") use the browser's built-in boxes, which some apps block. They'll move onto the page.
3. **No actual ABV yet,** and no fermentation chart; readings are recorded but not yet compared over time.
4. **Packaging is only a stage.** It doesn't record yield, package counts, or losses.

---

## Roadmap

The order follows dependencies: each phase sets up what the next one needs. **Brew log → packaging → inventory → TTB** is the backbone, TTB reports are the first feature breweries are expected to pay for, the taproom loop (POS sync, state returns) follows, and recipes and costing come last. Out of scope by design: CRM, delivery routes, wholesale ordering, and full accounting (export to QuickBooks instead).

The shared database (Phase 3) was pulled ahead of the brew log: real crews can only try the app once data is shared, and multi-tenancy and offline are easier to build in from the start than to add later.

### Up next, in order
1. ~~Settings screen and permission levels~~ (done).
2. ~~Keep the data safe~~: nightly backups are running and a restore has been rehearsed. **Supabase's paid plan before real records** (decided).
3. **Brew log, step 2:** ~~cellar log, additions, brew-day sheet~~ (done); ~~printed sheet with QR code~~ (done); next **brew-day ingredients with lot numbers** and the sheet's field list ([design](docs/brew-log-design.md)).
4. **Moving beer** design, ahead of packaging (Phase 5).

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
The as-brewed record for each batch, compared against its beer's targets. **Design draft:** [docs/brew-log-design.md](docs/brew-log-design.md).
- [x] **Brewery preferences, first:** temperature (°F/°C), gravity (SG/Plato/Brix), volume (bbl/hL/gal), and time zone. **Readings are stored in one standard unit** (gravity as SG, temperature as °C, volume as US barrels) and converted for display, so changing a preference never alters old records, breweries' numbers mean the same thing, and TTB math is always in barrels. Brix readings taken after fermentation starts need an alcohol correction (using the original gravity); the app applies it.
- [ ] **Event history per batch.** Record every stage change and transfer (date, from, to, volume) instead of overwriting. Traceability, the CIP log, and TTB reporting are all built on this. Stage and tank may become "the latest event" rather than fields that get overwritten.
- [x] **Cellar log** with action items that move the stage, readings in the brewery's units, cellar changes, notes; **additions** with lot numbers; **brewhouse settings per location**. 
- [x] **Brew sheet field catalog:** each brewery ticks the fields it measures (Settings → Brew sheet). Breweries can also add their own fields. Still to come: renaming fields, per-field targets set by the brewery, and choosing fields during onboarding.
- [x] **Brew-day sheet:** the brewery's paper sheet as a screen, per turn, with targets, water math from grist weight, meter readings, and "far from target" highlighting. (Admins editing the sheet's fields comes later.)
- [ ] **Fermentation log:** gravity and temperature readings over time, FG, pH.
- [ ] **Actual ABV**, calculated from actual OG and FG, plus **target vs. actual**: is 1042 hitting House Hazy's numbers?
- [ ] **Fermentation curve:** a simple chart of gravity and temperature over time.
- [x] **Printable brew sheet** for each batch, laid out for pen and paper, with a **QR code** that opens that batch in the app.
- [x] **Open a batch from a link** (what the QR code points at).
- [ ] **Brewer notes** per batch.

### Phase 3: Shared data, sign-in, multiple breweries, and offline (in progress)
Turns the prototype into something a brewery can rely on.
- [x] **Database design** on Supabase (hosted Postgres): breweries, members and roles, locations, tanks, beers, batches, and append-only batch history, with row-level security and tests proving breweries can't reach each other's data (`supabase/`).
- [x] **App switched to the shared database:** one copy of the data that every phone and computer reads and writes.
- [x] **Multi-tenant from day one:** every record belongs to a brewery, and access rules keep each brewery's data separate.
- [x] **Sign-in** by emailed code or link, and **roles** (admin, brewer, viewer) enforced by the database.
- [x] **Invite coworkers** to a brewery, and let admins change roles (the last admin can't be removed).
- [x] **A dedicated email service** for sign-in codes (Resend, from `noreply@brew.chrisbohn.org`).
- [x] **Email the invite** to the coworker automatically (a small server function; needs the email service key set once).
- [ ] **QR codes work on any phone** (now possible: every batch lives in the shared database).
- [x] **Move existing data in** from a backup file or from the browser-only version.
- [x] **Saving a batch is one all-or-nothing step** (batch, history, and tanks together).
- [ ] **Loading a backup as one all-or-nothing step** too. Today it empties the brewery again if loading fails partway. (Other changes, like editing a tank, beer, or location, are already a single step.)
- [x] **Works offline, viewing:** the app opens and shows the last data without a connection, with a banner saying how old it is, and reloads by itself when signal returns.
- [x] **Works offline, recording:** floor changes made offline are kept on the device and sent in order when the signal returns; the screen shows what's still waiting.
- [x] **Simple conflict rule:** in a small crew two people rarely change the same thing at once, so there's no merge tool. Changes apply in the order they reach the database. If one can't apply (a duplicate batch number, a tank someone else just filled), the database's checks reject it and the person who made it sees why. Nothing is silently dropped.

### Floor and safety improvements (scheduled between phases)
These make the app trustworthy and quick on the floor. They aren't a separate phase; each is slotted in where it fits.

**Settings and permissions**
- [x] **A Settings screen** (⚙︎ in the header), so the main screen stays about the floor. It has pages for:
    - Brewery (name, units, time zone);
    - Equipment (locations, tanks);
    - Beers and recipes;
    - Cleaning (acid rules);
    - Team and permissions;
    - Backup;
    - My account.

  People only see the pages they're allowed to use.
- [x] **Permission levels, enforced by the database,** with per-person adjustments and editable levels. Admins pick one per person:
    - **Viewer:** look at everything, change nothing.
    - **Cellar:** daily floor work (readings, cellar log, acid cycles, tank status).
    - **Brewer:** adds batches, stages, transfers, packaging, and brew-day sheets.
    - **Head brewer:** adds beers and recipes, tanks and locations, acid rules, and units.
    - **Admin:** adds team and permissions, brewery name, backups, and deleting things.

  Extra per-person exceptions can come later if needed.

**Fewer mistakes (Robust)**
- [ ] **Undo** for a few seconds after a transfer, stage change, or packaging entry.
- [ ] **On-page confirmations and messages** instead of the browser's pop-ups, which some apps block.
- [ ] **Activity feed:** who did what and when ("Sam moved 1042 to BT-2 at 2:14 PM").

**Faster on the floor**
- [ ] **QR stickers on tanks:** scanning one opens whatever is in that tank, ready to log a reading. Printable from the app.
- [ ] **Quick actions on tank cards** (long-press for "Log reading", "Dry hop", ...).
- [ ] **Cellar TV:** a big-screen tank board for a monitor on the wall, laid out with a simple **floor plan builder** (drag tanks to where they really stand, per location) so it's quick to scan.
- [ ] **Reminders:** a "Today" list ("Dry hop FV-2", "1042 conditioning 21 days", "BT-1 due for acid"), then phone notifications.

**Keeping the data safe (Resilient)**
- [x] **Nightly backups** of the whole database (structure, data, sign-in accounts) to a **private** repository, with every night kept. A full restore was rehearsed into a fresh database: every row matched and all database tests passed. Restoring also runs `supabase/after-restore.sql`, which re-locks the sign-in-only functions (a fresh Supabase project opens them to everyone by default).
- [ ] **Supabase's paid plan before real records** (decided): it never pauses and adds Supabase's own daily backups.
- [ ] **Error reporting,** so problems on someone's phone are found right away, not a week later.

**Polish**
- [ ] **App icon and name** on the home screen (and the branding question that comes with it).

### Phase 4: Tank care
- [x] **Acid tracking:** acid cycle log per tank, "acid every X turns" per tank, a brewery-wide list of styles that need acid afterward, an "Acid due" flag, and a warning before filling a tank that's due.
- [ ] **Full CIP log:** caustic and sanitizer cleanings too (date, who, what chemicals), using the same cleaning records as the acid log.
- [ ] **Tank batch history,** looked up from batch events: everything that's been through FV-1.
- [ ] **Tank notes:** quirks, gasket replacements, maintenance history.

### Phase 5: Moving beer and packaging
Beer is tracked by **volume, not just location**: a batch has barrels in places, and every move records how much moved. This is the foundation for inventory and TTB. A short design comes first, like the brew log's, because a batch can now be in more than one tank.
- [ ] **Transfers with volumes,** including **splits** (one batch into two brite tanks) and **blends** (two batches into one tank). Each tank shows its running balance.
- [ ] **Package types set per brewery:**
    - kegs: ½, ¼, and ⅙ bbl, and 50 L;
    - cans and bottles: 12, 16, and 19.2 oz;
    - case formats: 4×6, 6×4, 2×12.
- [ ] **A packaging calculator** that turns counts into volume. For example, a skid of 72 cases of 16 oz 4×6 = 216 gal ≈ 7 bbl, so a 30 bbl batch still has about 23 bbl in the tank.
- [ ] **Packaging never empties a tank by itself.** A person confirms **"this tank is spent"**; whatever is left on paper is recorded as **loss** (tank bottoms, dumped beer), which TTB asks for. A suspicious leftover (say 4 bbl) asks before closing.
- [ ] Packaged beer becomes finished-goods inventory (Phase 6).

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
Recipe *building* is well served by dedicated tools, so this stays light. The brew log (Phase 2) already keeps a simple per-location recipe that a batch starts from and the brewer adjusts by hand.
- [ ] **Import recipes** from popular recipe tools, rather than building a full recipe builder.
- [ ] **As-brewed snapshot:** each batch keeps a copy of the recipe as it was actually brewed, so later recipe changes don't rewrite history.
- [ ] **Printable brew sheets pre-filled from the recipe:** target numbers and additions already printed, with blanks for the actuals.
- [ ] **Ingredient cost per batch** and cost per barrel, using raw-material inventory from Phase 6.

### Phase 11: Ready for other breweries
Multi-tenancy itself arrives in Phase 3. This phase is about letting a new brewery sign up on its own.
- [ ] **Onboarding: the brewer's own tanks on screen in the first 15 minutes.** Ask only what's needed to see value; ask the rest when it first matters. Guess defaults (units from the country, time zone from the phone), enter things in bulk, import what the brewery already has.
    1. Sign in with an emailed code, then name the brewery.
    2. **Your cellar:** locations and tanks in bulk ("FV1 to FV8, 30 bbl fermenters").
    3. **What's in the tanks right now:** tap each tank, pick or type a beer, roughly how many days in.
    4. **Your brew sheet:** tick the fields you measure, or upload a photo or spreadsheet of your current sheet and have the matching fields ticked. Print it.
    5. **Invite the crew.**
    6. A **setup checklist** in Settings for the rest, each item asked when it becomes relevant: TTB permit, state, and filing frequency (at the first TTB report); package types (at the first packaging); acid rules (at the first cleaning); batch numbering and stage list; "too long in a stage" alerts.

  Every step can be skipped and changed later. For the first breweries, also a hands-on setup call.
- [ ] **Free trial, decided:** every brewery gets **two free TTB reports**. The first usually covers a period that started before the switch (opening inventory from the old system); the second covers a whole period done only in Brewery OS, which is the experience that shows its value, without ever juggling two systems. The trial runs until the second report is filed (so about two months for monthly filers, about six for quarterly). No payment details to start.
    - **One trial per TTB permit number** (each brewery premises has its own Brewer's Notice). The permit is asked for at the first TTB report, which needs it anyway. A permit that already had a trial goes straight to paid, with an offer to pick up the earlier brewery's data. No IP tracking or name matching.
    - **After the trial nothing is deleted or locked away:** the brewery goes read-only, and export is always free.
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
