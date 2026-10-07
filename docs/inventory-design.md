# Inventory: design (draft for review)

Status: **reviewed; decisions recorded below.** Based also on a real brewery's inventory workbook (no names here). Same principles as the rest of the app: sensible defaults, flexibility, and the brewery chooses.

## What the workbook taught us

- **Stock lives in places, not just locations.** Each location has a **storage** area (the main cooler) and a **taproom**. A master sheet adds them up by beer and package size (½, ¼, ⅙ bbl and cases), with a total in barrels.
- **Counting is the habit.** Each place is counted by hand, beer by beer, size by size. The app should fit that, not demand that every keg leaving be logged.
- **Pars drive restocking.** The front of house sets a par for each beer at each taproom (in barrels); "over / under" is what's there minus par, and anything under means "bring more up". There's also a brewery-wide par per beer (barrels and cases), and a case request at the taproom.
- **"On deck"** is, for each taproom, the beers sitting in storage that aren't on tap there yet, with how much there is and which storage it's in.

## Why it matters

- **TTB:** after beer is packaged, the Brewer's Report of Operations still asks where it went: removed tax-paid (sold), consumed on the premises, transferred, returned, destroyed. And the excise tax return is built from taxable removals. Without this, Phase 7 stops at the packaging line.
- **Day to day:** "how many sixtels of the Amber do we have?" should be one glance, not a walk to the cooler.
- **Raw materials:** brew-day ingredients already record lot numbers. If receipts are recorded too, malt and hops on hand come for free, and so does traceability from a lot to every batch that used it.

## The same idea as volumes: a ledger

Like beer in tanks, **stock is never typed in as a number; it's worked out from records**:

- **Finished goods on hand** = everything packaged (packaging runs already record a count per package type) − everything removed since.
- **Raw materials on hand** = everything received − everything used on brew day (brew-day ingredients) ± counts that correct it.

Append-only, works offline, and every number traces back to something a person recorded.

## 1. Finished goods

**Comes in** automatically from packaging runs: "40 × ½ bbl keg of #142 Amber".

**Goes out** as a **removal**: date, batch (or just the beer, picking the oldest batch first), package type, count, and **what kind of removal**:

| Removal | Example | TTB |
| --- | --- | --- |
| **Sold** | a distributor order, a bar, a store | removed tax-paid |
| **Taproom** | a keg put on tap, cases sold to go | consumed on the premises, or sold |
| **Transferred** | to another brewery or location under bond | transferred in bond |
| **Donated / samples** | a festival, a charity event | tax-paid (or tax-free, case by case) |
| **Dumped / destroyed** | out of date, off flavor | destroyed (needs records) |
| **Returned** | kegs or cases coming back with beer in them | returned to the brewery (comes back in) |

**Where it is: stock places.** Each location has one or more **places** where stock sits, each a **storage** place or a **taproom** (to start: one storage place per location; add a taproom, or more, as needed). Packaging puts stock in the location's storage place (or a chosen one). **Moving stock between places** ("bring 3 halves up to the taproom", "send 10 halves to the other location") is a move, not a removal.

**Counting a place (the main way to keep stock right).** A **count sheet** for a place looks like the workbook's tabs: each beer with a box per package size, filled in with what the app expects. The crew types what's actually there; the app records the differences. For a taproom, a drop is usually **poured** (consumed on the premises); for storage, the brewery picks what a drop means (sold, or "not sure, check"). So a brewery that only counts once a week still gets correct stock, and one that logs every removal gets the detail.

**By batch, or not (the brewery chooses).** Stock always remembers which batch it came from (packaging runs know), but by default the screens show **beer and package size only**, like the workbook. Removals and count differences take from the **oldest batch first**. A brewery that wants batch detail turns it on and sees (and can choose) batches everywhere.

**Which removal kinds** show up is the brewery's choice too (Settings), starting with all of them.

**What you see:**
- **An Inventory screen:** for each beer, what's on hand by package type ("Amber Ale: 22 × ½ bbl, 8 × ⅙ bbl, 41 cases of 16 oz"), with the batches behind it and their age (oldest first).
- **Quick removal:** pick the beer and package type, then type a count. The oldest batch goes first unless you choose one.
- **A count check:** like a level check for tanks. Count what's actually in the cooler, and the app records the difference.

## Pars, restocking, and "on deck"

- **Pars** per beer per place (barrels, or a count of a package size like cases), set by whoever runs that place, plus an optional **brewery-wide par** per beer.
- **Over / under** for each taproom: what's there minus par, highlighted when under.
- **Restock list:** for each taproom, what to bring up to reach par, and which storage place has it. It turns into moves with one tap once it's been brought up.
- **On deck:** for each taproom, the beers in storage that aren't there yet, with how much and where.
- **Brewery-wide view:** each beer's total (barrels and cases) against its par, with what's in tanks still to be packaged.

## 2. Raw materials

- **Items** come from the names already used in brew-day ingredients (malt, hops, salts, yeast...), with a unit each (lb, kg, oz, g, each).
- **Receipts:** date, item, lot number, amount, supplier, and optionally the cost. Cost is the start of Phase 10 (costing).
- **Used up automatically** by brew-day ingredients with the same item and lot.
- **On hand** per item and per lot, with a **low stock** level the brewery sets ("reorder below 10 sacks").
- **Traceability both ways:** a lot shows every batch that used it; a batch shows every lot it used.
- **Count checks** to correct what's on the shelf.

## 3. Keg tracking (optional)

For breweries that number their kegs: register kegs (number, size, maybe a QR sticker), and record that a keg was **filled** (with which batch), **delivered** (to which account), and **returned** (empty). Then you can see which kegs are full, empty, or out at accounts, and for how long. Breweries that don't number kegs skip this entirely; finished-goods counts work either way.

## Build order (after review)

1. **Finished goods:** stock places, on hand (from packaging), **count sheets**, moves between places, removals by kind.
2. **Pars, restocking, and "on deck".**
3. **Raw materials:** receipts in the units bought (55 lb sacks, 44 lb boxes, kg...), use from brew-day ingredients, on hand by lot, low stock, lot traceability.
4. **Keg tracking**, for breweries that want it.

## Decisions from the review

1. **Places:** each location has its own stock (storage and taproom), and beer moves between them and between locations.
2. **Removals:** all the kinds above, used; the taproom pours from kegs and sometimes tanks (tanks are covered by level checks).
3. **Counting by size** is the default; batch detail is an option the brewery turns on. Start basic; let the admin choose what fits.
4. **Raw materials:** tracked by lot, bought in sacks, boxes, and kg.
5. **Accounts** (customers) come later; a name typed on a removal for now.
6. **TTB note for Phase 7:** whether moving beer to a taproom counts as "removed" depends on whether the taproom is inside the brewery's bonded premises. Each taproom place will say which; checked against the form in Phase 7.
