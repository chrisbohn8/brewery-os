# Brew log: design (draft for review)

Status: **proposal, not built yet.** Based on a real brewery's Excel brew log: one sheet per batch, filled in by hand on a printed copy and typed in later. Comments welcome before building.

## Goals

1. **Replace the per-batch spreadsheet** with a record that follows the batch from brew day to the last keg: brew-day readings, cellar log, additions, transfers, and (later) packaging.
2. **Paper first on the brew deck.** Wet hands make phones awkward, so a printed sheet is the main tool on brew day. Its QR code opens that batch's entry screen, and the entry screen follows the paper's order so typing it in is quick.
3. **Fit odd breweries.** Every small brewery has quirks (one measures volumes with a flow meter's start and end readings; another has three turns into one fermenter). The sheet is **built from configurable fields**, not hard-coded columns.
4. **Recipes separate from batches.** Today a "recipe" is just the latest batch of a beer. Here, a beer has a recipe with versions; a batch starts from it and keeps its own as-brewed copy.
5. **Reliable, robust, resilient** (see the README's mission): append-only history, everything works offline, and nothing is overwritten.

## What the current spreadsheet holds (and what changes)

| Spreadsheet section | In the app |
| --- | --- |
| Header: style, brewer, FV, dates, batch # | Filled automatically from the batch, its tank, and who's signed in |
| Malt bill, salts, hops, yeast, targets (OG/FG °P, ABV, IBU) | **Recipe** (per beer, versioned) → copied into the batch as **as-brewed ingredients**, with lot numbers |
| Water targets (calculated from grist and kettle volume) | Calculated from **brewery settings** (water-to-grist ratio, grain absorption, kettle volume) |
| Brew day, Turn 1/2/3: temps, volumes, gravity and pH at each point, KO volume, O2, time log | **Brew-day checkpoints**, one set per turn; a batch has 1 to 3 (or more) turns |
| Cellar log: date, action item (AI), pH, °P, temp, cellar change (CC), notes | **Cellar log entries**; some actions also change the batch's stage on the tank board |
| Dry hop table (also used for spices) | **Additions** (what, how much, when, lot) |
| Transfer log: date, volume, carb, cellar change, finings | Existing **transfers** (batch history), plus volume and carb |
| Packaging log: date, package type, count | Packaging phase (Phase 5); the shape is noted here so it fits |

## The core idea: a brewery's sheet is a list of fields

Each brewery has a **brew sheet template**: sections, and in each section an ordered list of fields. The app ships a sensible default (close to the sheet above); an admin can rename, reorder, add, or hide fields, and set targets.

Each field has a **type**, which decides how it's entered, stored, converted, and printed:

| Field type | Entered as | Stored as | Example |
| --- | --- | --- | --- |
| Temperature | the brewery's unit (°F) | °C | Mash temp: target 152, achieved 151 |
| Gravity | the brewery's unit (°P) | SG | First runnings: target 20+, achieved 21.3 |
| pH | pH | pH | Kettle full: target 5.2–5.3 |
| Volume | the brewery's unit (gal, bbl, hL) | US barrels | Total KO volume |
| **Meter reading** | start and end readings | the difference, as a volume | Mash water: meter 150 → 300 = 150 gal |
| Time of day | a time (7:05 AM) | a timestamp | Mash start, KO end |
| Flow / rate, count, mass | the brewery's unit | a standard unit | O2 L/min, yeast amount |
| Text | free text | text | Notes |

Fields are either **per turn** (asked once for each turn, like the brew-day readings) or **per batch** (asked once).

A **target** can be a number, a range (5.2–5.4), a minimum ("20+"), or calculated (water volumes, or "from the recipe" for OG).

Because values are stored in standard units with the field's type, a brewery can change its preferences later without changing old records, and reports like TTB always add up.

## What a second location's sheets showed

A second location's workbook (one template per beer, sized "30 bbl") has **the same fields** as the first location's sheet, which means one sheet template per brewery works. What differs is the **brewhouse**:

| | Location 1 | Location 2 |
| --- | --- | --- |
| Batch | 15 bbl per turn; 30 bbl = 2 turns | 30 bbl in 1 turn |
| Kettle full / KO | ~16–17 bbl per turn | ~32–34 / 30–37 bbl |
| Flow / pump targets | 6.6 – 5.5 – 6.2 | 20–22 |

What that changes:
- **Brewhouse settings belong to a location:**
    - turn size and the usual number of turns;
    - kettle-full volume;
    - flow and pump targets;
    - water-to-grist ratio and grain absorption.

  A batch's sheet uses the settings of the location where it's brewed.
- **Recipes carry targets for specific sheet fields** (kettle-full, KO, and tank-sample gravity), not just OG/FG/IBU. That's already in the model below as "any sheet field's target".
- **Recipes are sized for a brewhouse.** The same beer at a 15 bbl and a 30 bbl brewhouse has different quantities, and not always a straight multiple. See the open question on recipes per location.
- **Ingredient kinds** need to cover:
    - malt;
    - sugars and adjuncts (dextrose);
    - salts, with timing (Mash / FWH);
    - hops, with timing (FWH, 60, 15, WP, dry hop);
    - yeast, with generation (a number, or "Fresh");
    - process aids (Whirlfloc, bioglucanase in ml, ALDC, Tetra);
    - other.

## Data model sketch

```
BREWERY SETTINGS     units (°F/°C, °P/SG/Brix, gal/bbl/hL), time zone
BREWHOUSE            per location: turn size, usual turns, kettle-full volume, flow/pump targets,
                     water-to-grist ratio, grain absorption

SHEET TEMPLATE       per brewery, versioned
  SECTION            "Mash / runoff", "Gravity", "pH", "Time log", ...
    FIELD            key, label, type, per turn | per batch, target, order, hidden?

RECIPE               per beer (and brewhouse size), versioned (v1, v2, ...); one is current
  RECIPE LINE        kind (malt / sugar-adjunct / salt / hop / yeast / process aid / other), name, supplier,
                     amount + unit, when (mash, 60 min, whirlpool, dry hop ...), notes
  TARGETS            OG, FG, IBU, plus any sheet field's target

BATCH                (exists today) + turns, recipe version it started from, brewer
  AS-BREWED LINE     a copy of each recipe line, editable for this batch, + lot number
  READING            batch, turn (or none), field key, value (standard unit),
                     raw entry (what was typed, e.g. meter 150 → 300), who, when
  CELLAR ENTRY       batch, date/time, action item, gravity, pH, temp,
                     cellar change, notes, who
  ADDITION           batch, ingredient, amount + unit, timing, lot, date
  EVENTS             (exists today) stage changes and transfers; transfers gain volume and carb
```

Every new row has an ID created on the device and is only ever added (corrections add a new value rather than editing in place, so the history shows what changed). That makes it all work offline with the existing "waiting to send" list.

## Action items and the tank board

The cellar log's action items are a short list per brewery (defaults: Check, Tank sample, Dry hop, Rouse, Crash, Harvest, Drain, plus custom). Each action can optionally **move the batch to a stage**. For example, "Dry hop" moves it to Dry hopping, and "Crash" moves it to Conditioning. Logging the cellar work then keeps the tank board current without a separate step. Readings on each entry (°P, pH, temp) build the **fermentation chart** for free.

**Cellar change** is its own field: setpoint changes ("FR to 62"), spunding, slow crash. It's kept separate from notes so it can later become structured (a setpoint the chart can show).

## Recipes

- A beer has a **current recipe** and a history of versions.
- **Starting a batch** copies the current recipe's lines and targets into the batch's as-brewed list, and the printed sheet shows them.
- **On brew day,** changes (a substitution, an extra addition, lot numbers) are recorded on the batch only.
- **After the batch,** "Make this the recipe" saves the batch's as-brewed list as the beer's next recipe version, on purpose and not by accident.
- **Getting started:** a beer with no recipe yet can be started from its most recent batch, which is how the spreadsheet works today. That makes the switch easy.

## The printed sheet

- **Built from the template and the batch:** sections in the same order as the entry screen, targets printed, and blank boxes for actuals, one column per turn.
- **The header is filled in:** beer, batch number, fermenter, brew date, brewer, and number of turns.
- **A QR code opens this batch's entry screen.** It works on any signed-in phone.
- **Sized for letter paper,** in black and white, with large boxes for wet-hands handwriting.
- **The cellar log page** prints with empty dated rows, for batches that live on a clipboard by the fermenter.

## Entering it later ("type it in from the sheet")

- The QR code opens the batch with **the next section that has blanks** already open.
- Fields come **in the same order as the paper.** Pressing Next moves through them, the keypad matches the field type (numbers with a decimal point), and units are shown but not typed.
- **A value far from its target is highlighted** (for example, a pH of 5.9 against 5.2–5.4) as a gentle check for typos, not a block.
- **Meter readings take a start and an end** and show the result in gallons while you type.

## Suggested build order

1. **Brewery preferences** (units, time zone, water settings) and the **default sheet template.**
2. **Brew-day readings** (per turn) and the **cellar log** with action items, connected to the tank board. **Additions** (dry hops and spices).
3. **Printed sheet with QR**, and the **"type it in" screen.**
4. **Recipes** (versions, start a batch from a recipe, as-brewed lines with lot numbers).
5. **Template editing** for admins (rename, reorder, add, hide fields; set targets).
6. **Fermentation chart** from the cellar log readings.

Steps 1–3 replace the brew-day and cellar parts of the spreadsheet; step 4 replaces the "copy last batch" habit.

## Open questions

1. **Which comes first:** the suggested order above, or recipes earlier because they're what a new batch's sheet is printed from?
2. **The time log** (mash start → KO end): is it used for anything later (brewhouse efficiency, scheduling), or just a record?
3. **Who edits the template:** admins only (suggested)?
4. **Corrections:** is it fine that a corrected reading keeps the old value in its history (shown as "changed from 4.8 by Sam, Oct 6")?
5. ~~The same beer at both locations~~ **Decided:** each brewhouse keeps its own recipe and the brewer adjusts by hand; no scaling. Recipes stay simple (the "plan" a sheet is printed from). Full recipe building is left to dedicated tools; importing from them may come later.
6. **Batch logs at the second location** appear to be printed and filled by hand, possibly never typed in. This makes the printed sheet + "type it in" screen central, and means the app is often the *first* digital record.

**The brew log is the core:** it measures the whole process (brew day, fermentation, cellar work, transfers, packaging), not just the recipe.
