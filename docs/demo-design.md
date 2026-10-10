# The demo: design (draft for review)

Status: **built and tested on the private test copy (2026-10-10): the demo brewery (step 1, live) and "Try the demo" with the weekly clean-up (steps 2 and 3).** "Try the demo" is open on the real site since 2026-10-10 (anonymous sign-ins switched on, with the user's yes). The user's decisions (2026-10-10) are below; the build order is at the end.

## What it's for

One tap shows a prospective brewer (and the user, testing) everything the app can do, on a brewery that looks lived-in: beers in every stage, a busy calendar, menus on the TV. No email, no account, nothing to set up.

## Decided (the user, 2026-10-10)

1. **A copy per visitor, reset weekly or so.** Each visitor gets their own demo brewery, so prospects never trip over each other and can change anything. A copy is deleted about a week after it was made.
2. **A demo never becomes a real brewery.** Real records start clean. (Anything worth keeping, like a recipe, can be exported.)
3. **Two locations, to show one-, two-, and three-turn batches:**
   - **Location 1: a 15 bbl brewhouse,** with 15 and 30 bbl fermenters and brites (a 30 is two turns).
   - **Location 2: a 30 bbl brewhouse,** with 30 and 60 bbl fermenters and brites, and a 90 bbl fermenter (three turns).

## How a visitor gets in

- **"Try the demo"** on the sign-in screen, and a link (`/#demo`) to send prospects. It doesn't depend on an email address or the site's domain, so it keeps working when the address changes.
- Behind it: a **signed-in session with no email** (Supabase's anonymous sign-in), then a fresh demo brewery made for that session in **one all-or-nothing step** (the same loader backups use). If the visitor comes back on the same device within the week, they're back in their copy.
- **A "Demo brewery" bar** across the top, always: "This is a demo: changes are yours alone and it's deleted after a week. Start your own brewery →".

## What's switched off in a demo

- **Emails:** invites are off (no emails from a demo), and a visitor has no email for alerts. (Problem reports still reach the developer: a crash in a demo is a real bug.)
- **API keys** and **calendar links** (they'd outlive the demo). **Menu board TV and public links work**, so a TV can be shown on a sales call.
- **Uploading fonts** (license) and large files; logos work.

## The demo brewery's records

Made by a generator, with every date **relative to today**, so it always looks current ("brewed 4 days ago", Tuesday's brew day, an acid cycle due tomorrow). A made-up name, beers, and people: never a real brewery's.

- **Two locations** as above, about 14 tanks, beers in every stage (fermenting, dry hopping, conditioning, carbonating, ready), some empty, one cleaning, one acid due.
- **About three months of history:** brew-day sheets filled in turn by turn (1, 2, and 3 turns), cellar logs with fermentation charts, additions with lot numbers, transfers with losses, level checks, packaging runs, a split and a blend.
- **Finished goods:** each location's storage and taproom, pars (some under, so "Bring up" shows), draft lines, an inventory view, coming soon.
- **Raw materials** with lots, deliveries, usage from the batches, one low on stock, one on order.
- **Recipes** for each beer (written for one turn), beer schedules, a full planning calendar with a clash and a shortfall to show the warnings.
- **Menus:** pour sizes, sections, tags, prices (one taproom pricier), and two styled boards per taproom.
- **A team** of made-up people at each level, and a few open alerts.
- Later, **TTB reports** filled in from the same records.

## Keeping it tidy and safe

- Demo breweries are marked as demos in the database; a daily job deletes those over a week old, with their sessions.
- Limits against abuse: Supabase's sign-in rate limit, plus a cap on new demos per hour.
- Demo copies never appear in the user's own brewery list, and real breweries can't be reached from a demo (the usual rules apply).

## Build order

1. The generator (two locations, dates relative to today), loaded as one step; checked by a test that every screen has something on it.
2. "Try the demo": anonymous sign-in (a setting to switch on, locally and on the live project), the demo bar, what's switched off, coming back to your copy.
3. The weekly clean-up job.
4. The guide's "Try the demo", and a short "what to look at" tour inside the demo (built 2026-10-10: tour.js, 11 steps on the real screens, picking its examples from the demo's records; checked at computer and phone sizes by tests/browser/tour.mjs).

## Try it yourself (built 2026-10-10)

The tour shows what the app knows; a brewer is convinced by doing the jobs themselves. **Try it yourself** is a short list of real jobs in the demo, each a minute or less, with the real forms:

| Job | Who usually does it | Done when (from the records) | Then it points at |
| --- | --- | --- | --- |
| Log today's check (gravity, temperature, pH) | Cellar | a cellar entry with a gravity, made after the demo was | the new point on the chart and pH strip |
| Dry hop a batch, with a lot number | Cellar | an addition (not brew day) with a lot | the lot used up in raw materials |
| Transfer a batch to a brite | Cellar | a transfer | the volume and the loss in its history |
| Package a batch | Cellar | a packaging run | the kegs and cases in inventory |
| Bring kegs up to the taproom | Taproom | a move into a taproom | the par going green |
| Put a beer on a draft line | Taproom | a draft line changed | the TV menu, with the beer on it |
| Plan next week's brew day | Head brewer | a calendar item added | the calendar (and its warning, if the tank won't be empty) |

- **Where:** "Try it yourself (2 of 7)" on the demo bar, after the tour's last step. The list shows each job's goal, who usually does it, and a tick when it's done.
- **Show me:** guidance that doesn't get in the way. The next button to tap gets a pulsing outline (inside forms too) and a small hint floats above everything ("Tap + Log cellar work"); the visitor does the real thing, and the hint moves on as each step happens. Forms open as dialogs, which sit above everything, so a spotlight can't be used here.
- **Honest ticks:** a job is done when its record exists (made after the demo was), never by clicking through.
- **Checked by a test** that does every job the way a visitor would, on a computer and a phone.
