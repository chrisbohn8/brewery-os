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
| `GET /beers` | Beers with target OG / FG, their menu details (description, ABV, IBU, prices), their recipes (size, targets, IBU, ingredients), and the latest batch's brew-day ingredients |
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

## What's next

Exports (CSV and JSON), spreadsheet imports, recipe import (BeerXML), and later a sensor inbox for tank probes. Rate limits and public documentation come when someone outside the brewery holds a key.
