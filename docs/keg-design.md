# Kegs: design

Status: **step 1 built (2026-10-10).** Step 2 is optional and comes later, for breweries that track keg shells.

## What the brewery told us

- **Full kegs are already counted** as finished goods (by beer and size, at each place). Empty keg shells aren't counted at all, and that's fine: plenty of breweries work this way.
- **Kegs leave** for the taprooms, a distributor, dock sales, and festivals and events.
- **A monthly kicked-keg sheet:** every keg kicked in the taproom, so each month shows "X kegs of Y beer kicked".
- **"Almost gone"** on the menu board means the last kegs: a beer is almost gone when **storage** has no kegs of it left, however many are still in the taproom. One half left at the taproom with four in storage is *not* almost gone.

## Step 1: kicked kegs and "Almost gone" (built)

**Kicked.** Each draft line pouring something has a **Kicked** button. It logs the keg:

- the taproom and line;
- the beer, or the label for something else, like a guest cider;
- the keg's size;
- the day.

The size is filled in with the size last kicked of that beer at that taproom, or else the size there's most of. Then the person says what's on the line now:

- **the next keg of the same beer** (the usual answer);
- **something else**, which opens the line's form to choose it;
- **nothing**, which leaves the line empty.

**A log, not a stock change.** Stock is kept right by counts, as before. If kicks also took kegs out of stock, every count would have to know which kegs had been kicked since, and the two could disagree. So a kick changes nothing in stock. For the same reason, count the kegs on tap along with the rest.

**The month's kicks.** Under a taproom's lines, **Kicked kegs** adds up a month by beer and size: "House Hazy: 6 × ½ bbl keg, 2 × ⅙ bbl keg", plus the total kegs and barrels. ‹ › moves between months. **Download (CSV)** gives the month as a spreadsheet, and **Each keg** lists every kick, where a mistake can be removed. Every kick ever logged is also in Settings → Export ("kicked kegs") and in backups.

**Almost gone.** This is worked out by the database for each beer on a board: kegs of it have been in a storage place before, and no active storage place, at any location, has a keg (or cask) of it now. A beer that has never been in storage in kegs is never marked, because the app can't know. On a board it's a part like tags ("Almost gone", outlined in the board's accent color). New boards show it; an existing board gets it by ticking it in the builder.

**API.** `POST /kicks` logs one; it can be undone, which removes the kick. `GET /kicks?month=2026-10` lists a month's kicks, each one and added up. Both are in docs/api.md.

## Step 2: keg shells (optional, later)

This is for breweries that want to know where their kegs are. It's off unless a brewery turns it on.

- **Counts first.** Empty kegs by size at each place, and full kegs out at each account, distributor, or event. These come from the moves the app already records: a "sold" removal to an account sends kegs out, and a return brings them back.
- **Numbered kegs,** for breweries that number them: register a keg (number, size, maybe a QR sticker), then see what it was filled with, where it went, and how long it's been out.
- **Festivals:** kegs that go out and come back part full come back in as a **returned** move.

## Not decided yet

- Whether "Almost gone" should also wait for beer still in tanks (a fresh batch about to be packaged). Today it follows the brewery's rule exactly: kegs in storage only.
