# Brewery OS API (first version)

For outside tools and AI assistants. Every request acts **as the person who made the key**, through the same rules the app uses, and a key can have some or all of its maker's permissions, never more. If the person loses a permission (or leaves the brewery), so do their keys.

## Getting a key

In the app: **Settings → API keys → Make a key.** Give it a name ("My AI assistant"), untick anything it shouldn't do, and copy the key. It's shown once. Revoke it there any time; it stops working at once.

## Making requests

```
https://itxshxihltidwgwtzdcj.supabase.co/functions/v1/api/<address>
Authorization: Bearer bos_...
```

Answers are JSON. Errors look like `{ "error": "..." }` with a status: 401 (no key, or revoked), 403 (the key or its owner may not do that), 404 (no such tank or batch), 400 (something in the request isn't right).

Tanks and batches can be named by their id **or** their name / number (`FV-3`, `142`).

| Address | What it does |
| --- | --- |
| `GET /me` | The brewery, who the key belongs to, its permissions, and the brewery's units |
| `GET /tanks` | Every tank: type, status, location, and the batch in it (beer, stage, since when, volume in barrels) |
| `GET /tanks/FV-3` | One tank |
| `PATCH /tanks/FV-3` | Change its status: `{ "status": "empty" }`, `"cleaning"`, or `"maintenance"` (needs "Set a tank's status") |
| `GET /batches` | Batches in tanks (`?all=true` for every batch) |
| `GET /batches/142` | One batch, with its cellar log |
| `POST /batches/142/log` | Log cellar work (needs "Log readings and cellar work"), see below |
| `GET /beers` | Beers with target OG / FG, their menu details (short line, description, ABV, IBU, color, section, tags, your own fields, prices by pour size with any taproom's own price, and whether it's on the public menu; all by name), their recipes (size, targets, IBU, ingredients), and the latest batch's brew-day ingredients |
| `GET /inventory` | Finished goods on hand: beer, place, package, count, barrels |

### Logging cellar work

```json
POST /batches/142/log
{
  "action": "Check",
  "gravity_plato": 4.2,
  "temp_f": 64,
  "ph": 4.4,
  "cellar_change": "FR to 62",
  "notes": "Smells great",
  "occurred_on": "2026-10-07",
  "id": "8f3c2c1e-..."
}
```

Everything is optional. Gravity can be `gravity_plato` or `gravity_sg`; temperature `temp_f` or `temp_c`. `action` can be one of the app's actions ("Dry hop", "Crash"...), and `new_stage` moves the batch to a stage at the same time (needs "Change stages and transfer beer"). **Send your own `id`** (any UUID) to make retries safe: sending the same entry twice saves it once.

Readings come back in both units: `"gravity": { "sg": 1.0165, "plato": 4.2 }`, `"temperature": { "c": 17.78, "f": 64 }`.

## Suggest-only keys

A key either **suggests changes** (the usual choice, and the one for AI assistants) or **makes them directly**; it's chosen when the key is made. A suggest-only key's write is checked the same way (an error comes back right away), then answered with `202` and waits for a person:

```json
{ "suggested": true, "id": "…", "summary": "Logged Check on #142 (House Hazy)",
  "note": "This key suggests changes: nothing is saved until a person approves it in the app (the tank board's To review list)." }
```

Someone in the brewery approves it on the tank board (it's saved as them, under their permissions, marked "via" the key, dated the day it was suggested) or rejects it. A key can't approve its own suggestions. `GET` requests work the same for both kinds.

## Undo

A key's change can be undone by a person in the app (Settings → API keys → What keys did lately → Undo): what it added is removed, and what it changed is put back unless it's been changed again since. The answers to `PATCH /tanks/…`, `PATCH /beers/…`, and `PUT /lines/…` include `was` and `now` (the values before and after) for this. Volumes and stock aren't undone: they're corrected with a level check, a count, or a move, so their history is kept. A key can't undo.

## Writing (doing what the app does)

Every write is **the app's own action**, run as you and limited by the key: the API can't do anything the app wouldn't let you do, and the same rules hold (one batch per tank, volumes, oldest stock first). Things are named by **id or name**: a tank `"FV3"`, a beer `"House Hazy"`, a package `"½ bbl keg"`, a place `"Taproom"` (or `"Riverside Taproom"` when two locations have one). Dates are `"2026-10-07"`; left out, they're today (in the brewery's time zone). Volumes are in barrels.

**Every write is stamped with the key** (the app shows it as "via My AI assistant" on the records) and **listed** in Settings → API keys → *What keys did lately*. Send your own `"id"` (a UUID) to make a retry safe.

| Address | Body (example) |
| --- | --- |
| `POST /batches` | `{ "number": "142", "beer": "House Hazy", "tank": "FV3", "brew_date": "2026-10-07", "size_bbl": 15, "volume_bbl": 14.5 }` |
| `POST /batches/142/stage` | `{ "stage": "conditioning" }`, or a transfer: `{ "stage": "carbonating", "tank": "BT1", "volume_bbl": 14 }` |
| `POST /batches/142/package` | `{ "counts": [{ "package": "½ bbl keg", "count": 20 }], "spent": true, "place": "Storage" }` |
| `POST /batches/142/level` | `{ "volume_bbl": 12.5, "reason": "served" }` (`"served"`, `"loss"`, or `"correction"`) |
| `POST /batches/142/additions` | `{ "name": "Citra", "amount": 22, "unit": "lb", "timing": "Dry hop", "lot": "CIT-104" }` |
| `POST /batches/142/log` | cellar work (see above) |
| `POST /tanks/FV3/acid` | `{ "note": "..." }` |
| `PATCH /tanks/FV3` | `{ "status": "cleaning" }` |
| `POST /stock/moves` | `{ "from": "Storage", "to": "Taproom", "lines": [{ "beer": "House Hazy", "package": "½ bbl keg", "count": 2 }] }`, or a removal: `"removal": "sold"` (`"taproom"`, `"transferred"`, `"donated"`, `"dumped"`) with `"account"` |
| `POST /stock/counts` | `{ "place": "Taproom", "counts": [{ "beer": "House Hazy", "package": "½ bbl keg", "count": 3 }], "shortfall": "taproom" }` |
| `POST /raw/receipts` | `{ "item": "Citra", "lot": "CIT-210", "amount": 44, "supplier": "...", "cost": 616 }` (in the item's unit) |
| `POST /plan` | `{ "kind": "brew", "date": "2026-10-14", "tank": "FV3", "beer": "House Hazy" }` |
| `PATCH /beers/House Hazy` | `{ "style": "Hazy IPA", "menu": { "short": "...", "abv": 6.5, "section": "IPAs", "tags": ["New"], "prices": [{ "size": "16 oz", "price": 7 }] } }` (prices replace the beer's list) |
| `PUT /lines/Taproom/4` | `{ "beer": "House Hazy" }`, `{ "label": "Guest cider" }`, or `{ "status": "empty" }` |

A mistake gets a clear answer: `404` for a name that isn't here (`No beer "Hazy House".`), `400` for something that can't be done (`The stage is one of: ...`), `403` for something the key (or you) may not do.

## What's next

More writes (recipes, the brew-day sheet's values, raw counts and orders), and later a sensor inbox for tank probes. Rate limits come when someone outside the brewery holds a key.
