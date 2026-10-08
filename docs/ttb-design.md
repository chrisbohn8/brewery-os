# TTB reporting: design (draft for review)

Status: **proposal, not built yet.** The numbers go to the government, so every mapping below is spelled out, and the ones marked **(confirm)** need a yes from someone who files the brewery's reports.

## What we're building first

The **Quarterly Brewer's Report of Operations, TTB F 5130.26**. A brewer may file quarterly if it owed no more than $50,000 in beer excise tax last calendar year and expects the same this year (27 CFR 25.297(b)). At the reduced rate of $3.50 a barrel, that's roughly 14,000 barrels a year, which covers the breweries this app is for. (Quarterly filers may also use the monthly form; monthly filers must use TTB F 5130.9. The monthly form comes next; see the end.)

- Due **the 15th after each quarter**: April 15, July 15, October 15, January 15.
- In **barrels** (31 gallons), **rounded to two decimals**.
- Filed on paper or through Pay.gov. The app **prepares** the report and shows where every number came from; a person with signing authority checks it and files it.

Sources: [TTB F 5130.26 instructions](https://www.ttb.gov/media/70359/download?inline=), [TTB F 5130.26 form](https://www.ttb.gov/media/70360/download?inline=), [TTB F 5130.9 instructions](https://www.ttb.gov/media/70365/download?inline=), 27 CFR part 25.

## The form (Part 1, Beer Summary)

| Line | On the form | Comes from (in the app) |
| --- | --- | --- |
| 1 | Beer on hand at the beginning of the quarter | Line 17 of the previous report prepared in the app; for the **first** report, typed in from the last report filed on paper |
| 2 | Beer produced by fermentation, plus water or other liquids added | **Knockouts** into fermenters during the quarter **(confirm)**, plus anything typed in (water added) |
| 3 | Beer received in bond | Typed in (not tracked yet) |
| 4 | Beer returned to the brewery after removal | Stock **returned** into a place inside the brewery |
| 5 | Physical inventory disclosed an overage | **Count sheets** that found more, and **level checks / corrections** that added beer, inside the brewery |
| 8 | Total (lines 1–7) | Worked out |
| 10 | Removed for consumption or sale, **including beer removed tax determined to a tavern on brewery premises** | Stock **removed** as sold, donated, or taproom; stock **moved into a taproom place**; beer **served** from a serving tank **(confirm)** |
| 11 | Removed without payment of tax (27 CFR part 25, subpart L) | Stock removed as **transferred** (to a brewery of the same ownership, in bond) |
| 12 | Consumed on premises (not in the tavern) | Typed in (staff tastings aren't tracked) |
| 13 | Destroyed on premises | Stock removed as **dumped** (beer never taxpaid) |
| 14 | Losses, including theft | **Losses** in tanks: what's left behind on transfers and packaging, spills, "tank spent" remainders **(confirm)** |
| 15 | Physical inventory disclosed a shortage | Count sheets that found less (marked "not sure"), and level checks / corrections that took beer away |
| 17 | On hand at the end of the quarter | Line 8 minus lines 10–16 |
| 19 | Total beer (lines 10–17) | Equals line 8 |

Lines 9 and 18 (adjustments to an earlier period) and Part 2 (cereal beverage under 0.5%) are typed in when needed. Shortages must be explained in Part 3, Remarks; the app reminds you and lists the counts behind them.

## The rules behind the mapping

- **Beer "on hand" is beer inside the brewery's bond:** in tanks, plus packaged beer in storage places. Moving packaged beer around inside the brewery, packaging, transfers, splits, and blends change nothing on the report.
- **A taproom place is a tavern on the brewery premises (confirm per place).** Beer moved into it is **tax determined on arrival** (line 10) and no longer part of the report; counts, pours, and dumps inside the taproom don't appear on it. Each stock place gets a setting: *"Beer here has been removed (taxed): a tavern"*, on by default for taproom places.
- **Donated beer and samples are taxable removals** (line 10) unless they're for analysis or research, which are tax-free (line 11, typed in) **(confirm)**.
- **Beer from before the app** (opening counts, the first level checks) isn't an overage: it's part of line 1, which comes from the last paper report.

## Every number traceable

- Tap any line to see **the records behind it** (each knockout, removal, count, and loss, with date, batch, and who recorded it).
- **A reconciliation check:** the app also works out what's actually on hand at the end of the quarter (beer in tanks plus packaged beer in storage) and compares it with line 17. If they differ, it says by how much and lists the likely causes: volumes never recorded, a batch with no knockout volume, or beer from before the app.
- **Typed-in entries** (water added, received in bond, consumed on premises, prior-period adjustments) each need a short explanation, and are kept with the report.
- **"Mark as filed"** keeps a copy of the report as filed. Its line 17 becomes the next quarter's line 1, and it can't change afterward. A later correction is made the way TTB asks: as a prior-period adjustment (lines 9 and 18) on a later report.
- **A tax estimate:** line 10 × $3.50 a barrel (the reduced rate on a domestic brewer's first 60,000 barrels a year), for the separate excise tax return (TTB F 5000.24). It's shown as an estimate; the return is filed separately.

## Settings it needs (asked when the first report is opened)

- The brewery's **TTB brewery number** (BR-...), and the name and address as on the Brewer's Notice.
- **Filing frequency:** quarterly (this report) or monthly (TTB F 5130.9, next).
- For the first report: **line 17 of the last report filed** (beer on hand then).
- Which stock places are **taverns** (taxed on arrival).

## What comes after

1. **The monthly report (TTB F 5130.9)**, which splits the same records into more columns (cellar, racking, bottling) and lines.
2. **The excise tax return (TTB F 5000.24).**
3. **State reports** (Phase 9), from the same records.

## Questions for you (or whoever files the brewery's TTB reports)

1. **When is beer "produced" for your reports?** At knockout into the fermenter, or measured later (after fermentation, or at transfer to the brite)? The app can use either; knockout is the usual choice.
2. **Losses on transfers and packaging:** do you report them on line 14 (losses), or does your production number already leave them out?
3. **Your taprooms:** are they taverns on the brewery premises, where beer is tax determined when it moves in? And do you serve from tanks in the taproom?
4. **Donated beer and samples:** taxable removals (line 10)?
5. **Do you file quarterly?** And could you share the numbers (not the names) from your last filed report, so the app's first report can be checked against it?
