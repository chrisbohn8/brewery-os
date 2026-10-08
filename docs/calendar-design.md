# Planning calendar: design (draft for review)

Status: **proposal, not built yet.** The user answered the open questions on 2026-10-08 (see "Decided" at the end).

## What it's for

Today the plan for the cellar lives in a Google Sheet, apart from the app. The calendar brings it in, so the plan and the records sit side by side, and the app can warn about problems before they happen: a tank that won't be empty on brew day, or not enough malt for next week's brews.

Two rules from the product principles shape everything below:
- **A plan is never a record.** Planned and expected items are drawn differently from what happened, and nothing is recorded from the calendar on its own. Doing the work on the floor (or on the batch's page) records it as usual, and the plan item is ticked off by that record.
- **Simple, visible rules, no guessing.** Every expected date and every shortfall can be checked by hand: "10 days fermenting from the 6th is the 16th"; "on hand 880 lb, minus Monday's 550 lb, is 330 lb".

## The week view

- **Days across the top, tanks down the side,** grouped by location like the tank board. In each square: what's planned or expected for that tank that day. A phone shows three days at a time and swipes; a computer shows the whole week. **Today** is marked, and the past shows what actually happened (from the records), so last week reads like a logbook.
- **Kinds of items:** brew day, dry hop, diacetyl rest, crash, transfer, carbonate, package, clean, acid cycle, yeast harvest, maintenance, delivery, and the brewery's own (any name, any color). The admin or head brewer edits the list.
- **Who's on it** (optional): an item can name a person ("Sam brews Tuesday"); a "My week" filter shows just yours.
- **Tap an item** to open the batch or tank, mark it done (which goes to the usual form: a transfer opens the transfer form), move it, or delete it.
- **Not tied to a tank:** deliveries, meetings, and anything else go in a row at the top for the whole brewery (or a location).

## Who can change it

Two new permissions in the usual levels table, which an admin can change like any other:
- **Plan the schedule** (add, change, and delete anything on it, beer schedules, and item kinds): on for **Head brewer** and **Admin**.
- **Move items on the schedule** (drag an item to another day or tank, and "Push the rest back"): on for **Brewer**, **Head brewer**, and **Admin**.

Everyone in the brewery can see the calendar. Marking an item done goes through the usual forms, under their usual permissions. Changes show who made them and when, like everything else.

## Where the dates come from

### 1. A schedule for each beer

Each beer gets a simple **schedule**: its steps in order, each with how long it usually takes or what triggers it. For example:

| Step | When |
| --- | --- |
| Fermenting | 7 days |
| Dry hop | at 4 °P |
| Diacetyl rest | 2 days |
| Crash | at 2.5 °P, or 3 days after the dry hop |
| Brite (carbonate) | 2 days |
| Package | after that |

- **Filled in for you, to confirm:** from the beer's **recipe** where it says something (BeerXML recipes include fermentation steps with days and temperatures, and dry hops with their days), and from the **average of the past batches** of that beer (how many days each stage really took). The head brewer sees where each number came from and confirms or changes it. Nothing is used until it's confirmed.
- **Gravity triggers** ("dry hop at 4 °P", "crash at 2.5 °P") can't have an exact date ahead of time. On the calendar they sit on their *expected* day (from the days in the schedule), labeled with the trigger. When a logged gravity reaches the trigger, the item becomes **due now**, on the calendar and as an alert ("FV3 is at 3.9 °P: dry hop due"). It's always a reading someone logged that sets it off, never a forecast.
- **How many readings set it off** is a brewery setting (admin): **the latest reading** (the usual) or **two readings in a row**, for breweries that would rather not act on one odd reading.

### 2. Planned brews

- **Plan a brew:** a beer, a day, and a tank (and its location). The calendar then lays out that batch's steps from the beer's schedule, drawn lighter and labeled "expected".
- **Clashes** are shown before they happen: a tank still full (or due for an acid cycle) on the planned brew day, two batches planned into one tank, a brite tank needed by two beers the same day.
- When the brew happens, starting the batch in that tank on that day (as today) **fulfils** the plan; its expected steps then follow the real batch.

### 3. Someday plans

Small breweries plan concretely only a couple of weeks out ("we're brewing Monday"); further out it's "a Dunkel in the fall". A **someday plan** is a beer and a rough time (a month, or a season), with no day or tank. They're listed in a strip above the week, and in a month list. Giving one a day and a tank turns it into a planned brew. Someday plans don't count toward raw materials shortfalls (there's no date to count them on), but the shopping list can show them separately ("coming up this fall: Dunkel").

### 4. When things run late: push

When a batch is behind its schedule (still fermenting on its expected crash day), its later steps are flagged **late**, and the calendar offers one button: **Push the rest back** (by the days it's late, or a number you choose). If that pushes into something else (the brite tank is planned for another beer that day), it shows the clash and asks before saving. **Nothing moves on its own.**

## Will we have enough? (raw materials)

Raw materials are already tracked, and brewing already uses them up automatically (Inventory → Raw materials). The calendar adds the look ahead.

- **What a planned brew needs:** the beer's recipe, written for **one turn**, times the number of turns (the location's usual turns per batch, changeable per brew). If there's no recipe, the last batch of the beer is used, which already holds the whole batch's ingredients.
  - Breweries that write recipes for the whole batch: a setting, **"Recipes are written for: one turn / the whole batch"**, asked the first time it matters. The default is one turn.
- **How far ahead:** **two weeks** by default; the admin can change it in Settings → Alerts.
- **Working it out, in date order:** what's on hand now, plus deliveries on order (below), minus each planned brew's needs, brew by brew. A planned brew that comes up short gets a badge on the calendar: *"Tuesday's Hazy needs 550 lb Pilsner malt; after Monday's lager you'll have 330 lb: 220 lb short."*
- **Names must match:** recipe ingredients are matched to raw materials by name, as brewing already does. An ingredient with no match is listed ("'2-Row Pale' isn't in your raw materials"), with a one-tap way to link it to an item, which is remembered. Never guessed.
- **Lead time** (optional, per item): "hops take 5 days to arrive". A shortfall shows up at least that long before the brew, so there's still time to order.
- **Shopping list:** for the next week (or two, or any range): each item short, how much, and in packs ("4 sacks of Pilsner malt"), ready to copy into an order.
- **Alert:** a new kind in Settings → Alerts, **Short for a planned brew**, emailed to the people chosen, like the other alerts.

### On order, and dismissing a shortfall

- **On order:** enter a delivery you're expecting (item, amount, the day it should arrive, the supplier). It counts toward the brews after that day, so an ordered shortfall stops warning you. When it arrives, **Received** opens the usual delivery form already filled in, for the lot number. A delivery past its day and not received is flagged ("Citra was due Thursday").
- **Dismiss:** a shortfall can be acknowledged with a note ("borrowing 2 sacks from next door"), and it stops alerting. If the shortfall gets bigger than when it was dismissed, it comes back.
- Any upcoming change, not only orders: the same "on order" list takes a planned **adjustment** ("returning 1 sack Monday"), so the look ahead stays honest.

## Google and Apple Calendar

- **Subscribe** from Settings → My account: a private calendar link for the phone's calendar app, with all tanks or chosen ones, and optionally only items assigned to you. Read-only and one-way. It can be turned off (the link stops working) like an API key.
- Google Calendar refreshes subscribed calendars only every several hours; Apple's is quicker. The app stays the live view.

## From the Google Sheet

- **Import the plan** from the sheet, like the other imports (paste, CSV, or a shared Google Sheets link): a row per planned item (date, tank, beer, kind of item), with the same preview and "already here" checks.
- **Export:** the week as a spreadsheet or a printable page, for the brewhouse wall.

## API

Everything above goes through the API too, under the same permission (product principle 3): read the calendar, plan and move items, and the look ahead and shopping list. AI assistants with suggest-only keys can **propose** a plan ("here's next month's brew schedule"), which waits in the to-review list for a person to approve.

## Build order

1. **Week view, planned brews, beer schedules (days only), the permission, and clashes.** The calendar is useful from here on.
2. **Push the rest back** and late flags.
3. **Raw materials look ahead:** needs per planned brew, on order, shortfalls, dismiss, the shopping list, and the alert.
4. **Gravity triggers** (due-now items and alerts from logged readings), and schedules filled in from recipes and past batches.
5. **Calendar subscription, people on items, import from the Google Sheet, and the printable week.**

Each step ships with its help and guide sections, checked against the app, as usual.

## Decided (the user, 2026-10-08)

1. The starting list of item kinds is right.
2. Recipes default to **one turn**, with a setting for breweries that write them per batch.
3. Gravity triggers: **the latest reading** by default; an admin can switch to two readings in a row.
4. Shortfalls look **two weeks** ahead by default; an admin can change it. Plans further out are usually loose, hence **someday plans**.
5. **Brewers can move items** on the schedule; it's its own permission, so an admin can change who.
