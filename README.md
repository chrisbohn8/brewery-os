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

## Product principles

These constrain every build.

1. **Deterministic core, probabilistic edge.** The system of record (tanks, batches, brew logs, inventory, numbers) is 100% deterministic. No AI model ever sits between the brewer and their data, and no AI-generated value is ever written into a core record silently.
2. **AI lives only in derived layers:** briefs, suggestions, parsed input, comparisons. Every AI output is visible to a person and correctable before it matters. Anything an AI parser produces (a voice-logged gravity reading, say) needs a one-tap human confirmation before it's saved. Nothing AI touches writes into the record on its own.
3. **API maximalism.** The API exposes everything the app can do (tanks, batches, log entries, recipes, inventory, orders); it's how outside tools and AI assistants work with the brewery.
    - **Nothing written through the API is silent:** every change records which key made it, shows in the history as such, and can be undone.
    - **Keys can be "suggest only":** their changes wait in a "to review" list until a person approves each one. An AI assistant gets a suggest-only key by default; a trusted script (a sensor bridge) can act directly. Reading is open to every key.
4. **Trust is the product.** Our buyer is often tech-hesitant, and one visible AI error undoes months of trust. When in doubt, leave the AI out and ship the deterministic version.
5. **Documentation is a feature, and it must be right.** Most breweries should be able to set up and run without opening a manual: empty states that teach, help on every screen, setup that shows rather than tells. The reference documentation is clear, complete, and accurate. **Docs ship with the release, not after it**; a feature isn't done until its help and guide are written and checked against what the app actually does. Stale docs are worse than no docs, and a feature the user doesn't know about doesn't exist.

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

### Help and the user guide
- **[The user guide](https://brew.chrisbohn.org/guide.html)** (`guide.html`): how to use every screen, written for brewers, organized by task, with a "who can do what" table. It works with no signal.
- **A "?" on every screen** opens that screen's part of the same guide (the tank board, a batch, the brew-day sheet, inventory, raw materials, and each Settings page), so the help and the guide can never disagree.
- **Empty lists say what goes there and how to add the first one,** and an empty tank board offers "How to get started".
- **Checked automatically** (`tests/browser/docs.mjs`): every screen opens its own help, every link in the guide works, every button the guide names exists, and the guide's lists (stages, cellar actions, tank types, alert kinds, removal kinds, and the permissions table, tick for tick) match the app's. A guide that falls behind the app fails the tests.

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

### A batch's numbers
- The batch page shows **OG** (the tank sample, or the average of the turns' knockout gravities), the **latest gravity** ("Now", or "FG" once the batch is past fermenting), **ABV** and **attenuation**, each next to the beer's target.
- A **fermentation chart**: gravity and temperature by day since brewing, from the cellar log, with the target FG as a dashed line.
- None of it is stored: it's worked out from the readings, so correcting a reading corrects the numbers.

### The brew-day sheet
- **"Brew-day sheet"** on a batch's page, in paper order: brew day, water treatment, mash, lauter and runoff, boil and whirlpool, gravity, pH, knockout, fermenter and yeast, time log, cleaning sign-offs, and notes.
- **Each brewery chooses its fields** (Settings → Brew sheet) from a catalog of about 100: water salts and acids, step-mash temps, lauter pressure, post-boil volume and gravity, knockout temperature, dissolved oxygen, yeast viability, cell count and pitch rate, cleaning sign-offs, and more. A usual set is ticked to start. Unticking a field never hides anything already recorded: a batch always shows every field it has a value for.
- **Rename any field and set its target** (Settings → Brew sheet → Edit): your crew's own name for it, and the usual target, your own range (in your units), or no target. Renaming never changes what's already recorded.
- **Add your own fields** for anything the catalog doesn't have: a name, the section it belongs in, and the kind of value (a number with your unit, temperature, gravity, volume, pH, time, or text).
- **Turns are tabs** (Turn 1, Turn 2, …). A new batch starts with its brewhouse's usual number of turns, and the count can be changed on the sheet. Yeast, knockout volume, and notes belong to the whole batch.
- **Targets show next to each field**: fixed ones from the sheet (sparge 168 °F, pH ranges), the brewhouse's (flow, kettle full), and the beer's OG for knockout and tank-sample gravity.
- **Water worked out from grist weight** with the brewhouse settings: mash water = grist × water-to-grist ÷ 4; total = kettle full × 31 + grist × grain absorption; sparge = total − mash.
- **Flow meter fields** take the start and end readings and save the difference.
- **Each value saves as soon as you leave its box**, also with no signal. Values far from their target are highlighted ("Typo?"); how far is adjustable in Settings → Brewery (by default 1 °P, 3 °F, 0.15 pH, 10% for volumes), and each flag can be turned off. Corrections keep the earlier value in the database's history.

### Staying up to date
- A tab left open keeps running the version it opened with. Every 10 minutes, and when you come back to the app, it checks whether a newer version has been published and, if so, shows **"A new version of the app is ready. Reload"**. It never reloads by itself, since someone might be typing.
- Reloading always gets the newest version (the offline copy checks with the server each time).

### Volumes (moving beer, step 1)
- **Every tank card shows how much is in it** ("29.5 bbl"), worked out from a **ledger of movements**: knockout into a fermenter, transfers, packaging, losses, corrections. The ledger is append-only; nothing is overwritten. See [docs/moving-beer-design.md](docs/moving-beer-design.md).
- **Knockout volume** comes from the brew sheet's "Total knockout volume", or the batch size.
- **Moving or packaging a batch asks how much moved;** empty means all of it. What's left behind (yeast, trub, bottoms) is recorded as **loss**, and the form says so before saving. Moving more than was on record adds a correction instead of a negative tank.
- **Volumes are optional.** A batch with none recorded says "volume not recorded" and everything still works.
- The batch page shows what's in the tank, and its history lists every movement with its volume.

### Inventory: finished goods (Phase 6, step 1)
- **Stock places:** each location starts with a **Storage** place; add a **taproom** or more (Settings → Equipment).
- **Packaging puts kegs and cases into stock** (the tank location's storage, or a chosen place). Runs from before inventory existed were added too.
- **Inventory** (button on the tank board): each beer by package size, per place or all places, with a barrel total; tap a beer to see the batches behind it (oldest first, and "from before the app" for opening counts).
- **Count a place:** a count sheet like the paper one, starting from what the app expects; the differences are recorded. Less than expected at a taproom is **poured**; elsewhere you say what it was. A beer from before the app can be counted in as opening stock.
- **Move** (up to the taproom, to the other location) and **Remove** (sold, taproom, transferred, donated, dumped, with an account name). Taking stock out uses the **oldest batch first**.
- **Reasons** ("Stocked the taproom", "Dock sale"...): a brewery's own list, offered on every count, move, and removal, and **required** if the admin turns that on (Settings → Packages).
- Everything works offline, and a new permission, **"Count and move finished goods"**, is part of Cellar and up by default.
- **Pars** (step 2): how much of each beer a place should have, in barrels and/or cases (a taproom's pars), plus a **brewery-wide par** per beer. Each place shows **over / under**, and what to **bring up** ("Bring up 3 × ½ bbl keg from Storage", one tap fills in the move). A taproom also shows what's **on deck**: beers in storage that aren't there yet.

### Alerts
- **Settings → Alerts:** each kind on or off, its thresholds, and **who's emailed** (specific people): no gravity logged for N days (in chosen stages), too long in a stage (a limit per stage), acid due, under par, and low on a raw material. **Quiet hours** hold emails until they're over.
- **The server checks every 15 minutes** (a scheduled job calls `supabase/functions/alerts`; set up with `supabase/schedule-alerts.sql`), and each reload of the app checks first, so alerts are current. Each alert is **emailed once** (one email per person listing what's new), stays one alert while it lasts, and **clears by itself** when the condition goes away (a gravity logged, the tank cleaned).
- **On the tank board,** what needs attention shows for everyone, with **"I've got it"**.

### Recipes (BeerXML)
- **Settings → Beers → Recipes → Import BeerXML…** from BeerSmith, Brewfather, Brewer's Friend, or other recipe software: a preview of each recipe (size, OG, FG, IBU, ingredients) matched to one of your beers or a new one (which takes the recipe's style and targets), optionally for one location.
- Ingredients come in your units (malt in lb, hops in oz; kg and g for breweries in hectoliters) with their timing (mash, boil 60 min, whirlpool, dry hop 3 days...).
- **The brew-day sheet copies a recipe's brew-day ingredients** ("Copy from the recipe...", the batch's location's recipe first), lot numbers empty; dry hops and other cellar additions stay out, to be logged when they go in. Recipes stay simple, as decided: no scaling; adjust by hand.
- The API's beer list includes recipes.

### Import from a spreadsheet
- **Settings → Import:** paste cells copied from Excel or Google Sheets, upload a CSV file, or read a **Google Sheet** by its link (shared as "anyone with the link can view"). Tanks (with new locations made on the way), beers, batches in tanks (with new beers made on the way), and cellar log entries.
- **Columns are matched by name** (and can be changed); numbers are read in the brewery's units ("15 bbl" works); dates as 2026-10-07, 10/7/2026, or 10/7/26.
- **A preview** shows every row: imported, already here (skipped), or a problem (and why) before anything is saved. Importing the same sheet twice is safe.

### Export as spreadsheets
- **Settings → Backup → Export as spreadsheets:** every list (tanks, beers, batches, batch history, cellar log, brew-day readings, ingredients and additions, volumes, packaging, finished goods on hand, stock moves, pars, draft lines, raw materials on hand, raw material deliveries) as a CSV file that opens in Excel or Google Sheets, with names instead of codes and the brewery's units in the column names; or **Everything** in one zip file.

### API keys and the API
- **Settings → API keys:** make a key for an outside tool or an AI assistant, with some or all of your permissions (never more), see it once, and revoke it any time. Admins see every key in the brewery, with when each was last used.
- **The API** ([docs/api.md](docs/api.md)): tanks (and changing their status), batches and their cellar logs (and logging cellar work, in °P or SG, °F or °C, safe to retry), beers with their targets and latest ingredients, and inventory. Every request acts as the key's owner through the same database rules as the app, limited to the key's permissions.

### Inventory views (the brewery's own sheets)
- **Views** (chips next to the places, "+ View" to make one): a sheet that adds up the places you choose (a master sheet might be the storage places only), with a column for each **package size**, or **each place and size**, and optional **totals** (barrels, cases), **brewery-wide pars** (highlighted when under), and the **pipeline**: what's still in tanks for each beer. Tap a beer to see the batches in its pipeline (tank, stage, volume).
- Which beers (with stock, with stock or a par, or every beer) and the order (A–Z or oldest batch first) are part of the view.

### Draft lines and the order beers are listed in
- **A taproom's draft lines** (Inventory → a taproom): numbered lines, each pouring a beer, something else (wine, cider, a guest beer), empty, or out of order. Tap a line to change it; add or remove lines. The beer picker lists beers here first, then those in storage.
- **Each place lists its beers in its own order:** A–Z, **oldest batch first**, **our own order** (arranged with up and down), or, for a taproom, **draft line order** (the default). Count sheets follow it, so counting a taproom walks the bar, line by line. "All places" remembers its choice on each device.
- "On deck" leaves out beers that are already on a line.

### Raw materials (Phase 6, step 3)
- **Inventory → Raw materials:** items (malt, hops, salts, yeast, chemicals...) with a unit, a pack (a 55 lb sack, a 44 lb box), and a reorder level.
- **Receive** a delivery by lot, in packs or the item's unit, with the supplier and (optionally) the cost.
- **Used up automatically:** brew-day ingredients and cellar additions with the item's name and lot count against it (lb, kg, oz, and g convert; so do gal, L, and mL). Nothing extra to enter, and fixing an addition fixes the stock.
- **Count** an item's lot to correct what's on the shelf, with a reason.
- **Low stock** shows below the reorder level. **Traceability:** each lot lists the batches that used it, and the ingredient form suggests the lots on hand.

### Splits and blends (moving beer, step 4)
- **"Split / blend…"** on a batch page makes a **new batch** from part or all of this one, and optionally other batches (a blend). Each part is its own batch, with its own stage, additions, and packaging, so a tank always holds one batch.
- A source keeps what's left in its tank, unless it's **all used**: then what's left is a loss, the source becomes **"Used in another batch"** (out of its tank, not packaged), and its tank goes to cleaning. A blend can go into one of its sources' own tanks if that source is all used.
- The new batch shows **what it was made from** ("Made from 12 bbl of #142") and the sources show where their beer went, each a link. Its OG is worked out from its sources, by volume. Suggested numbers: "142-2" for a split, "142/143" for a blend.
- It's a transfer, not new beer: TTB counts beer produced only from knockouts.

### Level checks (moving beer, step 3)
- **"Check level"** on a batch page: type what the **sight glass** shows. The app compares it with what's on record and records a drop as **served** (a serving tank pouring to the taproom; the default for serving tanks), **loss**, or a **correction**; a rise is a correction.
- If a volume wasn't recorded along the way, the reading simply **sets** the tank's volume from then on. Readings are checkpoints: later movements count from the latest one.

### Packaging (moving beer, step 2)
- **Package types are the brewery's choice** (Settings → Packages): tick them from a catalog of US, metric, one-way, and Cornelius kegs, casks, cases of cans and bottles, and single containers, or add your own (a volume, and how many per package for cases). Halves, quarters, sixtels, and cases of 12 and 16 oz cans are ticked to start.
- **"Package…" on a batch page:** a count for each package type; the app shows the barrels as you type ("= 20 bbl · about 10 bbl left") and **what's left fills about** "20 × ½ bbl keg, 60 × ⅙ bbl keg...".
- **Packaging never empties a tank by itself.** Each run asks "Is the tank empty now?": *not yet* keeps the rest for another run; *yes, it's spent* records what's left as loss, packages the batch, and sends the tank to cleaning. A leftover over 10% asks first.
- Each run is one all-or-nothing step, works offline, and keeps the volume per package it was packaged with (changing a type later never changes past runs).

### Brew-day ingredients
- The brew-day sheet starts with **Ingredients**: malt, adjuncts, water salts and acids, hops, finings, yeast, each with amount, when it went in (mash, boil 60 min, whirlpool...), the turn, and its **lot number** for traceability.
- **"Copy from the last batch"** of the same beer fills in names, amounts, timing, and turns, with lot numbers left empty for this batch's own. The last batch is the recipe; the brewer adds lots and adjusts what changed.
- They're kept in the same list as cellar additions (dry hops, fruit), so a batch has one record of everything that went into it. The batch page shows them all, brew-day ones tagged.

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
- **Join code, for a different email:** people often sign in with another address than the one they were invited at (a personal email instead of a work one). So a new email isn't sent straight to "create a brewery": the app first asks whether their brewery already uses Brewery OS. Each invite also has a short code, like `grist-knockout-4821` (two brewing words and four digits, about 40 million possibilities), in the invite email and on the admin's Team page. Typing it in joins from any email. It works once, for 14 days after the invite was made or last emailed, and each person gets 5 wrong tries an hour ([supabase/migrations/20261025000000_join_codes.sql](supabase/migrations/20261025000000_join_codes.sql)).
- Admins change levels and remove people from Team & permissions. A brewery always keeps at least one admin: the database refuses to remove or demote the last one.
- Someone who belongs to more than one brewery picks which one to work in under Account; the choice is remembered.
- Each brewery's data is kept completely separate by the database itself (row-level security), and roles control who can change things: **admin**, **brewer**, and **viewer** (read-only).

### Backup
- **Download** saves everything in the brewery (locations, beers, tanks, batches, history, the acid log, and the acid-after styles) as one `.json` file.
- **Load…** puts a backup into an **empty** brewery (so nothing is mixed up or duplicated), after showing what's in it and asking you to confirm. It loads as **one all-or-nothing step** in the database ([load_into_brewery](supabase/migrations/20261026000000_load_backup.sql)): if anything in the file can't load, nothing does, and the brewery stays empty. The sample data loads the same way.
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
| `guide.html` | The user guide. The in-app "?" help shows its sections, so there's one source. Update it in the same change as the feature. |
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
3. **Packaging is only a stage.** It doesn't record yield, package counts, or losses.

---

## Roadmap

The order follows dependencies: each phase sets up what the next one needs. **Brew log → packaging → inventory → TTB** is the backbone, TTB reports are the first feature breweries are expected to pay for, the taproom loop (POS sync, state returns) follows, and recipes and costing come last. Out of scope by design: CRM, delivery routes, wholesale ordering, and full accounting (export to QuickBooks instead).

The shared database (Phase 3) was pulled ahead of the brew log: real crews can only try the app once data is shared, and multi-tenancy and offline are easier to build in from the start than to add later.

### Up next, in order
1. ~~Settings screen and permission levels~~ (done).
2. ~~Keep the data safe~~: nightly backups are running and a restore has been rehearsed. **Supabase's paid plan before real records** (decided).
3. ~~Brew log~~ (done, Phase 2).
4. ~~Moving beer and packaging~~ (done, Phase 5).
5. **Inventory** (Phase 6, [design](docs/inventory-design.md)): ~~finished goods~~, ~~pars, restocking, and "on deck"~~, ~~raw materials~~ (done); next keg tracking (optional).
6. **API, import, and export** (Phase 6½, below).
7. **Alerts and tank monitoring** (Phase 6¾): alerts from the records first (email), then the sensor inbox.
8. TTB reporting (Phase 7), and the rest in order; **onboarding last** (Phase 11).

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
- [x] **Brew-day ingredients with lot numbers,** copied from the last batch of the beer.
- [x] **Brew sheet field catalog:** each brewery ticks the fields it measures (Settings → Brew sheet). Breweries can also add their own fields. Fields can be renamed and given the brewery's own targets. Still to come: choosing fields during onboarding, and different fields or targets per location.
- [x] **Brew-day sheet:** the brewery's paper sheet as a screen, per turn, with targets, water math from grist weight, meter readings, and "far from target" highlighting. (Admins editing the sheet's fields comes later.)
- [x] **Fermentation log:** gravity, temperature, and pH over time, in the cellar log.
- [x] **Actual ABV**, worked out from the actual OG (tank sample, or the turns' knockout gravities) and the latest gravity, plus **target vs. actual** and attenuation, at the top of the batch page.
- [x] **Fermentation curve:** gravity and temperature by day since brewing, with the target FG.
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
- [x] **Ask before making a brewery:** a new email is asked "joining your team, or setting it up?", and can join with the invite's **join code** from any email (so nobody makes a second copy of their own brewery by mistake).
- [x] **Delete a brewery made by mistake** (Settings → Brewery), only by its admin and only while they're the only person in it.
- [ ] **QR codes work on any phone** (now possible: every batch lives in the shared database).
- [x] **Move existing data in** from a backup file or from the browser-only version.
- [x] **Saving a batch is one all-or-nothing step** (batch, history, and tanks together).
- [x] **Loading a backup as one all-or-nothing step** too: the whole file goes to the database in one request, and it all loads or none of it does (a dropped signal can't leave half a brewery).
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
- [ ] **Passkey sign-in** (the user's idea, 2026-10-08): Face ID or a fingerprint instead of waiting for an emailed code. Faster on the brew deck, and it sidesteps the email service's hourly limit. The emailed code stays as the fallback (a new phone, a borrowed computer). A passkey belongs to one person's device, so shared floor tablets keep using codes. First check what Supabase's sign-in supports for passkeys today; if it isn't ready, wait rather than build our own.

**Polish**
- [ ] **App icon and name** on the home screen (and the branding question that comes with it).

### Phase 4: Tank care
- [x] **Acid tracking:** acid cycle log per tank, "acid every X turns" per tank, a brewery-wide list of styles that need acid afterward, an "Acid due" flag, and a warning before filling a tank that's due.
- [ ] **Full CIP log:** caustic and sanitizer cleanings too (date, who, what chemicals), using the same cleaning records as the acid log.
- [ ] **Tank batch history,** looked up from batch events: everything that's been through FV-1.
- [ ] **Tank notes:** quirks, gasket replacements, maintenance history.

### Phase 5: Moving beer and packaging
Beer is tracked by **volume, not just location**: a batch has barrels in places, and every move records how much moved. This is the foundation for inventory and TTB. **Design draft:** [docs/moving-beer-design.md](docs/moving-beer-design.md) (a ledger of movements; a tank's contents are worked out from it).
- [x] **Volumes and transfers with volumes:** a ledger of movements; each tank shows its running balance; what's left behind on a transfer is a loss.
- [x] **Splits and blends:** both make a new batch from part or all of others (decided: each part is its own batch); sources that are all used become "Used in another batch".
- [x] **Level checks** (sight glass): type what the glass shows; the difference is served, loss, or a correction; with no volume on record, the reading sets it.
- [x] **Package types set per brewery,** from a researched catalog of kegs, casks, cases, and containers, plus their own.
- [x] **A packaging calculator** that turns counts into volume, shows what's left, and what it would fill.
- [x] **Packaging never empties a tank by itself.** A person confirms **"this tank is spent"**; what's left on paper is recorded as **loss**. A leftover over 10% asks before closing.
- [ ] Packaged beer becomes finished-goods inventory (Phase 6).

### Phase 6: Inventory
**Design draft:** [docs/inventory-design.md](docs/inventory-design.md) (stock worked out from records, like volumes: packaged in, removals out).
- [x] **Finished goods:** stock places, packaging into stock, count sheets, moves, removals by kind (oldest batch first), opening counts, and optional required reasons.
- [x] **Pars, restocking, and "on deck"** (from the review of a real inventory workbook).
- [ ] **Keg tracking:** which kegs are full, empty, or out at accounts.
- [x] **Raw materials:** items, deliveries by lot, used up automatically by batches' ingredients, counts, low stock, and lot traceability.

### Phase 6½: API, import, and export
The user's idea (API-first): outside tools and AI agents read and write through the same endpoints the app uses, spreadsheets come in with a one-shot import, and everything can go out again. "Nobody adopts software they can't leave."
- [x] **API keys** made in Settings, shown once, stored hashed, with "last used", and revocable. **Each key belongs to a person and acts with up to all of that person's permissions** (pick some or all when making it), so a key handed to an AI agent can never do more than its maker, and the database's permission checks apply as usual.
- [x] **A small first API** (a server function in front of the same database rules and actions the app uses): tanks (list, update status), batches and their cellar logs (list; log cellar work, safe to retry), beers with targets and latest ingredients, and inventory. **Guide: [docs/api.md](docs/api.md).** A key can only narrow what its owner may do (checked inside the database), and the API checks it's limited before doing anything (fail closed).
- [x] **Export everything** as CSV (per list, or all of them in one zip) and JSON (the backup file).
- [x] **Import from spreadsheets:** pasted cells, a CSV file, or a Google Sheets link, for tanks, beers, batches, and cellar logs, with columns matched by name and a preview of what will be created before anything is saved.
- [x] **Recipe import from all the major tools** via **BeerXML** (BeerSmith, Brewfather, Brewer's Friend, and others export it); later, Brewfather's own API. Recipes stay simple (decided): a beer's targets and ingredient list, which the brew-day sheet copies like "copy from the last batch".
- [ ] **Write through the API, for all data** (the user's go-ahead): recipes (create, change), and everything else the app can do (batches, transfers, packaging, stock, counts, brew-day readings...), each under the same permissions as in the app.
- Later, when someone besides us holds a key: rate limits and public API docs.

### Phase 6¾: Alerts and tank monitoring
The user's idea. Watching only, never controlling equipment (controllers already do that, and remote control brings safety and liability questions).
- [x] **Alerts from the records we already keep (no new hardware):** "no gravity logged on FV3 in 3 days", "crashing for 4 days", "acid due", "under par", "low on Pilsner malt". Each alert type can be turned on, with its own threshold.
- [x] **Who gets them:** specific people, by **email** for now (through the email service already set up); **push notifications** once there's an app. Quiet hours, "I've got it" to acknowledge, and repeats at most about hourly, so alerts don't become noise.
- [ ] **A sensor inbox:** each tank (or cooler place) gets a private address, made with an API key from Phase 6½, that any device able to send readings to a web address can use (Tilt Pi, TiltBridge, iSpindel, RAPT webhooks, Wi-Fi temperature sensors). Readings attach to the batch in the tank, show on its fermentation chart, and drive alerts: a **safe range per stage** (fermenting 64–68 °F, crashing 30–34 °F...) with a per-batch override, an alert only after a few minutes out of range, and **"no reading for an hour"** as its own alert (a dead probe matters too).
- [ ] **Pulling from vendors' clouds,** one at a time as real customers need them: RAPT, Precision Fermentation's BrewMonitor, Sennos, Plaato Pro, glycol and cooler monitors.
- [ ] **A short buying guide:** floating hydrometers' radios struggle through jacketed stainless tanks, so for those a wired probe in the tank's thermowell, connected to a small Wi-Fi sensor or bridge outside the tank, is the practical low-tech option.

### Later: a planning calendar
The user's idea (2026-10-08): see the week ahead, tank by tank, and know before brew day whether there's enough malt and hops.
**Design draft:** [docs/calendar-design.md](docs/calendar-design.md) (week view, beer schedules from recipes and past batches, gravity triggers, push the rest back, raw materials look ahead with on-order deliveries and a shopping list, and the questions to confirm).
- [ ] **Week view:** days across the top, tanks down the side, and in each square what's due on that tank that day: brew day, dry hop, crash, transfer, package, clean, acid cycle. Swipe to the next week; tap an item to open the batch or tank. A phone shows fewer days at a time.
- [ ] **Planned vs. done, kept apart:** a plan is never a record. Planned items come from dates the brewer sets (a brew day, a planned transfer), and "expected" items from simple, visible rules (the usual days in each stage, the acid rules), drawn lighter and labeled "expected". Doing the work on the floor records it as usual and the plan item is ticked off; nothing is ever recorded from the calendar on its own.
- [ ] **Plan ahead:** put a future brew on an empty tank, and see a clash (two batches planned into one tank, a tank still full on the planned brew day) before it happens.
- [ ] **In Google or Apple Calendar:** a private calendar link each person can subscribe to (read-only, one-way, revocable like an API key), with all tanks or just chosen ones. Note: Google Calendar refreshes subscribed calendars only every several hours, so the app stays the live view.

### Later: the official app, and a feature tour
- [ ] **Installable web app** (home-screen icon, full screen): quick, any time.
- [ ] **App Store app** (the user's idea: an "official" app earns respect): the same code in a native shell (Capacitor), so no rewrite. Needs an Apple Developer account ($99/year), icons and screenshots, and Apple's review; native features make the case for it (camera QR scanning, push reminders like "acid due" or "under par", keeping the screen awake on the brew deck). A few days of work plus about a week of review. **Android** from the same project later ($25 one-time). Best timed before the pilots, with onboarding.
- [ ] **An Apple Watch app for brew days** (the user's idea, 2026-10-08): the brew-day sheet on the wrist, hands free on the brew deck.
    - **Where you are:** the current step (mash in, rest, vorlauf, sparge, boil, whirlpool, knockout) and what's next, from the brew-day sheet and the recipe, with a tap to move on.
    - **Timers that tap your wrist:** mash rest, boil, and each hop addition ("15 min: 4 lb Citra"), so nobody misses one while cleaning out the mash tun.
    - **Entering readings** with a couple of presses (the number dial) or by voice ("gravity 12.4"). Voice is read by simple, fixed patterns, never a guess, and every value is shown for a one-tap confirm before it's saved (product principles 1 and 2).
    - Goes through the phone, so no signal on the brew deck is handled like the app's offline changes: kept, sent in order, nothing dropped.
    - Needs the App Store app first (a watch app is a small native companion to it, written separately from the web app's code).
    - **Smart glasses** (Meta and similar) are the same idea with the screen in front of your eyes; not until they're more common.
- [ ] **A video tour of every feature and way to customize the app** (the user's idea): Claude compiles the feature list and a short script for each feature; the user records the videos.

### Phase 7: TTB reporting
The payoff for keeping accurate volumes at every step.
**Design draft:** [docs/ttb-design.md](docs/ttb-design.md) (the quarterly report first, every line traceable to records, a reconciliation check, and the mapping choices to confirm).
- [ ] **Brewer's Report of Operations** (TTB F 5130.9): beer produced, received, transferred, removed, and lost over the reporting period, calculated from batch events, packaging, and inventory.
- [ ] **Excise tax return support** (TTB F 5000.24): taxable removals for the period.
- [ ] Export in a format that's easy to copy into the TTB forms. Accuracy here depends entirely on the history from Phase 2 and the volumes from Phases 5–6. That's why those phases come first.

### Phase 8: Taproom connection (POS sync)
- [ ] Connect one point-of-sale system first (chosen by what pilot breweries use), so taproom sales draw down keg and serving-tank levels and count as taxable removals for TTB.
- [ ] **Menu boards from the taproom's draft lines** (the user's idea, 2026-10-08). The draft lines already know what's on each tap, so the menu comes almost free:
    - **Each beer gets menu details:** a short description, ABV, IBU, color, and prices per pour size (16 oz, 10 oz, flight, crowler...). ABV and IBU fill in from the batch and recipe, for a person to confirm.
    - **A TV view** of the menu (sharing the work with the Cellar TV), a **printable menu**, and a **public link** or embed for the brewery's website and social posts. The public link shows only menu details, never the rest of the brewery, and can be turned off.
    - Changes on the lines (a keg kicked, a new beer tapped) show on the board right away. "On deck" can show what's coming next.
    - Pour sizes and prices are the same ones a POS connection needs, so this is a step toward it.
- [ ] **A Taproom level** (the user's idea, 2026-10-08), for a taproom manager: draft lines, finished-goods counts and moves, pars, and menu details, but nothing on the brewhouse side (batches, tanks, recipes, brew sheets). It needs one permission split first: today "Beers and recipes" covers everything about a beer, so it becomes **"Beers and recipes"** and **"Beer menu details"** (description, prices). An admin can still change what the Taproom level includes, like any level.
- **Stay open to the common taproom POS systems** (the user's reminder): Toast, Square, Clover, and brewery-focused ones like Arryved, among others. Choices made now that keep the door open: **draft lines** map onto a POS's menu items (pours by line), pours become **taproom removals** (and level checks for serving tanks), and the **API** (Phase 6½) is the way in for a POS or a connector. Pour sizes (16 oz, 10 oz, flights) turn sales into volume.

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
    1. Sign in with an emailed code, answer "joining your team, or setting it up?", then name the brewery.
    2. **Your cellar:** locations and tanks in bulk ("FV1 to FV8, 30 bbl fermenters").
    3. **What's in the tanks right now:** tap each tank, pick or type a beer, roughly how many days in.
    4. **Your brew sheet:** tick the fields you measure, or upload a photo or spreadsheet of your current sheet and have the matching fields ticked. Print it.
    5. **Invite the crew.**
    6. A **setup checklist** in Settings for the rest, each item asked when it becomes relevant: TTB permit, state, and filing frequency (at the first TTB report); package types (at the first packaging); acid rules (at the first cleaning); batch numbering and stage list; "too long in a stage" alerts.

  Every step can be skipped and changed later. For the first breweries, also a hands-on setup call.
- [ ] **"Set this up?" cards, just in time** (the user's idea): everything works from sensible defaults, and the first time an admin or head brewer opens something that hasn't been set up (package types, brew sheet fields and targets, brewhouse settings, units, acid rules, the TTB permit), a small card at the top of that screen offers **"Set up yours · Looks fine"**. Not a pop-up, not hidden. Only shown to people who can change that setting; remembered per brewery (once one admin answers, it's gone for everyone). The same list drives the setup checklist in Settings.
- [ ] **Free trial, decided:** every brewery gets **two free TTB reports**. The first usually covers a period that started before the switch (opening inventory from the old system); the second covers a whole period done only in Brewery OS, which is the experience that shows its value, without ever juggling two systems. The trial runs until the second report is filed (so about two months for monthly filers, about six for quarterly). No payment details to start.
    - **One trial per TTB permit number** (each brewery premises has its own Brewer's Notice). The permit is asked for at the first TTB report, which needs it anyway. A permit that already had a trial goes straight to paid, with an offer to pick up the earlier brewery's data. No IP tracking or name matching.
    - **After the trial nothing is deleted or locked away:** the brewery goes read-only, and export is always free.
- [ ] **Billing.**
- **Combining or splitting breweries is never automatic** (decided 2026-10-08). People already move freely: one sign-in can belong to several breweries. Moving *records* between breweries (a brewery buys another; a location becomes its own company) touches tanks, batches, inventory, and TTB history, and reports already filed must never change. So it's done by hand, case by case, with both admins agreeing, and respecting TTB permit boundaries. If it's ever needed often, the likely tool is "move one location and everything in it", confirmed by both admins, never a general merge.
- [ ] Possibly a big-screen "cellar TV" view of the dashboard.

---

## Project history

| Commit | Change |
|---|---|
| `997bf62` | First tank dashboard: tanks with a beer, stage, and day counter |
| `1ff6bf1` | Batches split out from tanks: transfers, packaging, guardrails |
| `41cc5fa` | Tank details: type, capacity, location, status |
| `0d32d75` | Beers split out from batches: style, targets, calculated ABV |
