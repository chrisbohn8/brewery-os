# Inventory: design (draft for review)

Status: **proposal, not built yet.** Comments welcome before building. Same principles as the rest of the app: sensible defaults, flexibility, and the brewery chooses.

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

**Where it is:** each location has its own stock (packaging at one location puts it there). **Moving stock between locations** is a simple "move 10 halves from location A to location B".

**What you see:**
- **An Inventory screen:** for each beer, what's on hand by package type ("Amber Ale: 22 × ½ bbl, 8 × ⅙ bbl, 41 cases of 16 oz"), with the batches behind it and their age (oldest first).
- **Quick removal:** pick the beer and package type, then type a count. The oldest batch goes first unless you choose one.
- **A count check:** like a level check for tanks. Count what's actually in the cooler, and the app records the difference.

## 2. Raw materials

- **Items** come from the names already used in brew-day ingredients (malt, hops, salts, yeast...), with a unit each (lb, kg, oz, g, each).
- **Receipts:** date, item, lot number, amount, supplier, and optionally the cost. Cost is the start of Phase 10 (costing).
- **Used up automatically** by brew-day ingredients with the same item and lot.
- **On hand** per item and per lot, with a **low stock** level the brewery sets ("reorder below 10 sacks").
- **Traceability both ways:** a lot shows every batch that used it; a batch shows every lot it used.
- **Count checks** to correct what's on the shelf.

## 3. Keg tracking (optional)

For breweries that number their kegs: register kegs (number, size, maybe a QR sticker), and record that a keg was **filled** (with which batch), **delivered** (to which account), and **returned** (empty). Then you can see which kegs are full, empty, or out at accounts, and for how long. Breweries that don't number kegs skip this entirely; finished-goods counts work either way.

## Suggested build order

1. **Finished goods:** on hand (from packaging), removals by kind, moves between locations, count checks.
2. **Raw materials:** receipts, use from brew-day ingredients, on hand, low stock, lot traceability.
3. **Keg tracking**, for breweries that want it.

## Questions for you

1. **Where finished goods go:** does each location have its own cooler and stock, and do kegs or cases move between locations?
2. **Removals:** which kinds do you use (distributor, self-distribution to accounts, taproom, events, donations, dumps)? And does the taproom pour from kegs, tanks, or both?
3. **Kegs:** do you number or track individual kegs today (or keg deposits)? Or is a count by size enough?
4. **Raw materials:** do you track malt, hops, and yeast on hand today? By lot? What units do you buy in (55 lb sacks, 44 lb boxes of hops, kg)?
5. **Accounts:** do you want customers (bars, stores, distributors) as records, so removals and kegs can be "to Corner Bar"? Or is a note enough for now?

Until we hear otherwise: stock per location, all the removal kinds above, counts by size (no numbered kegs), raw materials by lot, and accounts as a simple name on a removal.
