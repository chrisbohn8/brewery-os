# Moving beer and packaging: design (draft for review)

Status: **reviewed; decisions recorded below. Building in the order at the end.** The guiding rule from the review: **flexibility.** Every brewery measures, packages, and blends a little differently, so the app offers choices with sensible defaults instead of one fixed way.

## Why this comes next

Today a batch is *in* one tank, and a tank holds one batch. That's enough for a tank board, but not for the things that matter later:

- **TTB reports** are all about volumes: how much beer was produced, moved, packaged, removed, and lost in a period. Without volumes, Phase 7 can't be built, and the free trial is built around TTB reports.
- **Real cellars split and blend.** One fermenter goes into two brites; two batches are blended into one tank; part of a batch goes to kegs and the rest to cans next week.
- **Packaging is where volume leaves.** Counting kegs and cases is what the crew already does; the app should turn those counts into barrels.

## Goals

1. **Track beer by volume:** every tank shows what's in it and roughly how much.
2. **Record moves the way the crew already thinks:** "moved FV3 to BT1", "packaged 40 halves and 12 sixtels", "the tank's done".
3. **Never guess an empty tank.** The app never decides a tank is empty. A person confirms "this tank is spent", and whatever is left on paper becomes a recorded loss.
4. **Every move is a record, never an edit:** append-only, like the batch history, so TTB numbers can always be traced back.
5. **Works offline**, like everything else on the floor.
6. **Unknown volumes are allowed.** Plenty of breweries don't measure every transfer. The app should still work (with gaps shown honestly), not refuse.

## The core idea: a ledger of beer movements

Like a bank account: instead of storing "BT1 has 28 bbl", we record every movement in and out, and **the balance is worked out** from them. (It's the same rule the app already follows for tanks and batches: derive, don't duplicate.)

| Movement | From | To | Example |
| --- | --- | --- | --- |
| **Knockout** (beer produced) | the brewhouse | a fermenter | 31 bbl of #142 into FV3 |
| **Transfer** | a tank | a tank | 29.5 bbl of #142, FV3 → BT1 |
| **Split** | a tank | two tanks | two transfers out of FV3 |
| **Blend** | two tanks | one tank | #142 and #143 both into BT2 |
| **Packaging run** | a tank | packages | 40 × ½ bbl, 12 × ⅙ bbl = 22.3 bbl |
| **Served from the tank** (brewpubs) | a serving tank | the taproom | drawn down from the serving tank |
| **Loss** | a tank | — | tank bottoms, dumped beer, a spill |
| **Correction** | a tank | — | the sight glass says 2 bbl more than the app |

Each movement has a date, the batch, the volume (or "unknown"), who recorded it, and notes. A **level check** (below) is also a movement: the difference between what the app expected and what the sight glass shows. A tank's contents are the sum of what went in minus what came out, **per batch**, so a blend tank shows "BT2: 18 bbl #142 + 12 bbl #143".

### Volumes the app can work out for you

- **Knockout volume** comes from the brew-day sheet's "Total knockout volume" (or the batch size if that's empty).
- **"Move all of it"** is the default for a transfer: the volume is whatever's in the tank. You can type a different number (a split, or a measured loss on the way).
- **Packaging** turns counts into volume using package sizes.

### Three ways to record a volume (use whichever fits)

1. **"All of it"**: the app's own running balance (the default for transfers).
2. **Type a number**, from a flow meter, a measured transfer, or an estimate.
3. **Check the level**: on any tank, type what the **sight glass** shows. The app compares it with what it expected and records the difference, labelled by what it was:
    - **served** (a serving tank pouring to the taproom),
    - **loss** (bottoms, a dump, a spill),
    - **correction** (the earlier numbers were off).

All volumes are typed in the brewery's own unit (bbl, gal, or hL) and stored in barrels, like every other volume in the app.

### When volumes are unknown

If a batch was knocked out without a volume, its tank shows the batch with **"volume not recorded"**, and transfers default to "all of it". Nothing breaks; the TTB report will list what's missing instead of making it up.

## Packaging

**Package types are the brewery's choice** (Settings → Packages): tick the ones you use from a catalog, rename them, and add your own. Like the brew sheet fields, a type you stop using never disappears from past packaging runs.

The catalog:

| Group | Package types (volume) |
| --- | --- |
| US kegs | ½ bbl (15.5 gal), ¼ bbl / pony (7.75 gal), slim ¼ (7.75 gal), ⅙ bbl / sixtel (5.17 gal), ⅛ bbl (3.88 gal) |
| Metric kegs | 50 L, 30 L, 25 L, 20 L |
| One-way kegs (KeyKeg, PolyKeg, Petainer...) | 30 L, 20 L, 10 L |
| Cornelius kegs | 5 gal, 3 gal, 2.5 gal |
| Casks | pin (4.5 imperial gal, 20.5 L), firkin (9 imperial gal, 40.9 L), kilderkin (18 imperial gal, 81.8 L) |
| Cans and bottles, by the case | 24 × 12 oz (2.25 gal), 24 × 16 oz (3 gal), 24 × 19.2 oz (3.6 gal), 12 × 22 oz (2.06 gal), 12 × 750 mL (9 L) |
| Single containers | crowler (32 oz), growler (64 oz), howler (32 oz), 5 L mini keg |
| **Your own** | a name and a volume in gal, L, oz, or mL, optionally "× how many per case" |

Ticked to start: ½ bbl, ¼ bbl, ⅙ bbl, and cases of 12 oz and 16 oz cans.

A **packaging run** is: date, tank, batch, and a count per package type. The app shows the volume as you type ("40 halves + 12 sixtels = 22.3 bbl") and **what's left in the tank** ("about 7.7 bbl left").

**The calculator works the other way too:** "about 30 bbl in BT1 = roughly 58 halves, or 310 cases of 16 oz." That helps plan a run before starting it.

### "This tank is spent"

After a packaging run, the app asks: **"Is BT1 empty now?"**

- **"Not yet"**: the rest stays in the tank (packaging over several days, or cans next week).
- **"Yes, it's spent"**: whatever is left on paper is recorded as **loss** (tank bottoms, foam, line loss), the batch moves to Packaged when no tank holds it any more, and the tank goes to Cleaning.
- **A suspicious leftover** (more than about 10% of what was in the tank, say 4 bbl out of 30) asks first: "4.1 bbl unaccounted for. Record it as loss, or was something not entered?"

## Splits (decided: a split makes a new batch too)

Splitting #142 into BT1 and BT2 keeps #142 in one tank and makes **#142-2** in the other, "split from #142". Same mechanism as a blend, so each part has its own stage, additions, and packaging (useful when the halves become variants), and a tank always holds one batch. A source that's all used becomes **"Used in another batch"**.

## Blends

Rare for most breweries, but it has to work. **A blend makes a new batch.** Blending #142 and #143 into BT2 creates batch "#142/143" (the brewer can rename it) whose history lists what went in: "18 bbl #142 + 12 bbl #143". From then on it's one batch: one stage, packaged as one, one line on the tank board.

Why a new batch rather than tracking each share inside the tank: packaging a blend would otherwise have to split every keg between batches by proportion, which is confusing on screen and easy to get wrong. A new batch with its sources listed keeps the traceability (which batches, which lots) without the arithmetic. TTB treats blending as moving beer between tanks, which the ledger already records.

## Serving tanks

A brewpub pouring straight from a tank records a **level check** now and then (each morning, or at the end of the week): the drop since the last check is recorded as **served**. Later (Phase 8), the point-of-sale system can fill this in automatically.

## Losses

Not every brewery measures losses, so the app never demands them. They come from two places: a **level check** labelled "loss", and **"this tank is spent"**, which records what's left on paper as loss (it has to go somewhere for the numbers to add up, and TTB asks for losses). A brewery that wants more detail can label losses (bottoms, dumped, spill, lab samples).

## How this changes what you see

- **Tank cards** show the batch (or batches, for a blend) and the volume: "BT1 · #142 Amber Ale · 29.5 bbl".
- **The batch page** shows where the batch is now ("FV3: 0 · BT1: 29.5 bbl"), and its history gains volumes: "Oct 14 · 29.5 bbl FV3 → BT1", "Oct 21 · packaged 22.3 bbl (40 × ½, 12 × ⅙)", "Oct 21 · 0.6 bbl loss (tank spent)".
- **The batch form's "Move to tank"** becomes a **Transfer** form: from, to, how much (default: all of it).
- **"Packaged" as a stage** stays, but it's reached by packaging runs and "tank is spent", not chosen by hand.

## What stays the same

- **Stages stay per batch** (fermenting, conditioning, ...). A split batch is in one stage everywhere, which matches how a crew talks about a batch. (If that's ever wrong, it can change later without losing anything.)
- **Acid cycles** still count a "turn" each time a batch leaves a tank.
- **Offline:** transfers, packaging runs, and "tank is spent" are kept on the phone and sent in order, with the same "arrival order wins, and refused changes are shown" rule. A transfer from a tank that a coworker already emptied is refused and shown, not merged.

## Moving existing data over

Each batch now in a tank gets a knockout movement into its current tank, with its batch size (or "unknown"). Past transfers stay as history without volumes. Nothing already recorded changes.

## How it maps to the TTB report (Phase 7)

| TTB report line (Brewer's Report of Operations) | Comes from |
| --- | --- |
| Beer produced (brewed) | knockout movements |
| Racked / bottled (packaged) | packaging runs |
| Removed for consumption on the premises | served from tank (and later, the taproom's sales) |
| Losses | loss movements (including "tank spent") |
| On hand at the end of the period | worked out from the ledger |

The exact line mapping gets checked against the form when Phase 7 is built. The point is that every number on it can be traced to movements the crew recorded.

## Suggested build order

1. **The ledger**, volumes on tank cards and the batch page, transfers with volumes (splits included), and moving existing data over.
2. **Package types** (Settings) and **packaging runs** with the calculator, plus **"this tank is spent"** with loss.
3. **Level checks** (sight glass) with served / loss / correction, which also covers serving tanks.
4. **Blends** as a new batch made from others.

## Decisions from the review

1. **Package types:** a catalog the brewery ticks and renames, plus its own; nothing fixed. (The catalog above came from researching keg and package sizes.)
2. **Measuring:** flexible. "All of it", a typed number, or a sight glass level check.
3. **Blends:** must be possible, though rare. A blend makes a new batch that lists its sources.
4. **Serving tanks:** yes, sometimes. Level checks record what was served.
5. **Losses:** never required, always possible. "Tank spent" records the remainder as loss.
