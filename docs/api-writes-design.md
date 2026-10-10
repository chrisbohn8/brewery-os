# API writes: design

Status: **built (2026-10-10): the writes, stamped with the key and listed (step 1); suggest-only keys and the review list (step 2); undo from the activity list (step 3).** Also built: brew-day sheet values, raw counts and orders, and recipes. Next: settings through the API. From the product principles (README): *API maximalism. The API does everything the UI does. API writes are attributed to the key, shown in the history, and undoable. Suggest-only keys: their changes wait in a "to review" list for a person to approve. AI assistants get them by default.*

## The rules

1. **Every write is one of the app's own actions.** An endpoint calls the same database function (or makes the same insert) as the app's form for it, as the key's owner, limited by the key. So the API can't do anything the app wouldn't let that person do, and every rule (one batch per tank, volumes, oldest stock first, permissions) holds the same way.
2. **Every write is attributed.** Each record the API makes carries the key it came through (`via_key`, filled in by the database from the request, so it can't be forgotten or faked), and the app shows it on the record: **"via My AI assistant"**.
3. **Every write is listed.** Settings → API keys shows what keys did lately: when, which key, and what ("Packaged #142 (House Hazy): 20 × ½ bbl keg"). (Links from the list to the records come with undo.)
4. **Suggest-only keys change nothing by themselves.** Their writes are checked (the action is tried and rolled back, so a suggestion that couldn't be saved is refused right away) and then wait in a **changes to review** list on the tank board. A person with the permission taps **Approve** (it's saved as them, noted "suggested by the key") or **Reject**. New keys are suggest-only unless the maker chooses otherwise; the form recommends it for AI assistants.
5. **Undo:** a key's write can be undone from its activity list where the app itself can undo that kind of record (a cellar log entry, an addition, a plan item...). Ledger records (volumes, stock) are corrected the way the app corrects them: with a correcting record, never by erasing history.
6. **Retries are safe.** A write can carry its own `id`; sending it twice saves it once.

## The writes (step 1)

| Address | What it does (the app's equivalent) |
| --- | --- |
| `POST /batches` | Start a batch in a tank (the batch form) |
| `POST /batches/{n}/stage` | Change its stage, or transfer it to another tank, with the volume moved |
| `POST /batches/{n}/package` | A packaging run: counts per package type, into a place, tank spent or not |
| `POST /batches/{n}/level` | A level check (sight glass), with what a drop was |
| `POST /batches/{n}/additions` | An ingredient or addition, with its lot |
| `POST /batches/{n}/log` | Cellar work (already there) |
| `POST /tanks/{name}/acid` | An acid cycle |
| `PATCH /tanks/{name}` | A tank's status (already there) |
| `POST /stock/moves` | Move or remove finished goods (oldest batch first) |
| `POST /stock/counts` | A count of a place |
| `POST /raw/receipts` | A delivery of a raw material, by lot |
| `POST /plan` | A calendar item |
| `PATCH /beers/{name}` | A beer's targets and menu details |
| `PUT /lines/{taproom}/{line}` | What a draft line pours |

Then (built): the brew-day sheet's values, raw counts and orders, recipes. Later: settings.

## Build order

1. Attribution (`via_key`) and the activity list; the writes above.
2. Suggest-only keys and the To review list.
3. Undo from the activity list.
