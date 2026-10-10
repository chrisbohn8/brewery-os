// The Brewery OS API (Phase 6½): outside tools and AI agents read and write with an API key.
//
// Every request runs as the key's owner, under the same database rules the app uses (row-level
// security, permission checks, and the same all-or-nothing actions), and the key can only narrow
// what its owner may do (see supabase/migrations/..._api_keys.sql). Docs: docs/api.md.
//
//   Authorization: Bearer bos_...
//
//   GET   /me                      who the key belongs to, the brewery, and what it may do
//   GET   /tanks                   every tank, with the batch in it (and its volume)
//   GET   /tanks/{id or name}      one tank
//   PATCH /tanks/{id or name}      { "status": "empty" | "cleaning" | "maintenance" }
//   GET   /batches                 batches in tanks (?all=true for every batch)
//   GET   /batches/{id or number}  one batch, with its cellar log
//   POST  /batches/{id or number}/log   a cellar log entry (gravity, pH, temperature, notes...)
//   GET   /beers                   beers with targets, menu details, their recipes, and the latest batch's ingredients
//   GET   /inventory               finished goods on hand, by beer, place, and package
//
// Writes (docs/api-writes-design.md): each one is the app's own action, run as the key's owner, and
// is stamped with the key (via_key) and listed in the key's activity (api_actions).
//   POST  /batches                     start a batch in a tank
//   POST  /batches/{n}/stage           change its stage, or transfer it to another tank
//   POST  /batches/{n}/package         a packaging run
//   POST  /batches/{n}/level           a level check
//   POST  /batches/{n}/additions       an ingredient or addition
//   POST  /tanks/{name}/acid           an acid cycle
//   POST  /stock/moves                 move or remove finished goods
//   POST  /stock/counts                a count of a place
//   POST  /raw/receipts                a delivery of a raw material
//   POST  /plan                        a calendar item
//   PATCH /beers/{name}                a beer's targets and menu details
//   PUT   /lines/{taproom}/{line}      what a draft line pours
//
// A suggest-only key's writes are tried (so one that couldn't be saved is refused right away), undone,
// and kept as suggestions for a person to approve in the app. Approving runs the write here, as that
// person (signed in, not with a key), still marked "via" the key:
//   POST  /suggestions/{id}/approve    Authorization: Bearer <the person's sign-in token>
import { Pool } from "jsr:@db/postgres@0.19.5";

const pool = new Pool(Deno.env.get("SUPABASE_DB_URL")!, 3, true);

// One request = one transaction. tx`...` runs a query in it and returns the rows.
// deno-lint-ignore no-explicit-any
async function inTransaction<T>(work: (tx: (s: TemplateStringsArray, ...v: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const t = client.createTransaction(`api_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    await t.begin();
    const tx = async (s: TemplateStringsArray, ...v: unknown[]) => (await t.queryObject(s, ...v)).rows;
    const result = await work(tx);
    await t.commit();
    return result;
  } catch (e) {
    try { await t.rollback(); } catch { /* the transaction may already be over */ }
    throw e;
  } finally {
    client.release();
  }
}
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
};
class Problem extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Gravity both ways (the same formulas as the app)
const sgToPlato = (sg: number) => -616.868 + 1111.14 * sg - 630.272 * sg ** 2 + 135.997 * sg ** 3;
const platoToSg = (p: number) => 1 + p / (258.6 - (p / 258.2) * 227.1);
const round = (n: number | null, d: number) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const num = (v: unknown) => (v == null ? null : Number(v));
const gravity = (sg: unknown) => (sg == null ? null : { sg: round(Number(sg), 4), plato: round(sgToPlato(Number(sg)), 1) });
const temperature = (c: unknown) => (c == null ? null : { c: round(Number(c), 2), f: round(Number(c) * 9 / 5 + 32, 1) });

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const header = req.headers.get("Authorization") ?? "";
  // Approving a suggestion: a signed-in person (from the app), not a key
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const after = parts.slice(parts.indexOf("api") + 1);
  if (req.method === "POST" && after[0] === "suggestions" && after[2] === "approve" && !header.startsWith("Bearer bos_")) {
    return approve(header.replace(/^Bearer /, ""), after[1]);
  }
  const key = header.startsWith("Bearer bos_") ? header.slice(7) : req.headers.get("X-Api-Key");
  if (!key?.startsWith("bos_")) return reply(401, { error: "Send an API key: Authorization: Bearer bos_..." });
  const path = new URL(req.url).pathname.split("/").filter(Boolean);
  const at = path.indexOf("api");
  const [resource, ref, sub] = path.slice(at + 1).map(decodeURIComponent);
  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await req.json().catch(() => null) : null;

  try {
    const result = await inTransaction(async (tx) => {
      // The key: known, not revoked
      const [k] = await tx`select id, brewery_id, user_id, permissions, revoked_at, last_used_at, mode
                             from public.api_keys where key_hash = ${await sha256(key)}`;
      if (!k || k.revoked_at) throw new Problem(401, "That API key isn't valid (or was revoked).");
      if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60_000) {
        await tx`update public.api_keys set last_used_at = now() where id = ${k.id}`;
      }
      const [owner] = await tx`select email from auth.users where id = ${k.user_id}`; // (before switching: people can't read the user list)
      // Everything this request writes is stamped with the key (via_key), by the database
      await tx`select set_config('brewery_os.api_key', ${k.id}, true)`;
      // From here on, everything runs as the key's owner, limited by the key
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: k.user_id, role: "authenticated", api_permissions: k.permissions })}, true)`;
      await tx`set local role authenticated`;
      // Fail closed: before doing anything, confirm the switch took effect (running as the key's
      // owner, limited by the key). If it didn't, stop: nothing is read or changed.
      const [who] = await tx`select current_user as role, auth.uid()::text as uid, public.api_key_permissions() as perms`;
      if (who?.role !== "authenticated" || who?.uid !== String(k.user_id) || !Array.isArray(who?.perms)) {
        console.error("API: the request wasn't limited to the key's permissions", who);
        throw new Problem(503, "The API couldn't limit this request to the key's permissions, so it did nothing. Try again.");
      }
      const pathText = path.slice(at + 1).join("/");
      const run = (ctx: Ctx) => route(tx, k.brewery_id, owner?.email, req.method, resource, ref, sub, body, new URL(req.url).searchParams, pathText, ctx);
      if (k.mode !== "suggest" || req.method === "GET") return await run({ mode: "direct" });
      // A suggest-only key: try the write (its usual checks and answers), undo it, and keep it for review
      await tx`savepoint suggestion`;
      const tried = await run({ mode: "suggest" });
      await tx`rollback to savepoint suggestion`;
      const [{ id }] = await tx`select public.log_api_suggestion(${req.method}, ${pathText}, ${tried.summary ?? `${req.method} ${pathText}`}, ${JSON.stringify(body ?? {})}::jsonb) as id`;
      return { status: 202, body: { suggested: true, id, summary: tried.summary,
        note: "This key suggests changes: nothing is saved until a person approves it in the app (the tank board's To review list)." } };
    });
    return reply(result.status ?? 200, result.body);
  } catch (e) {
    return failed(e);
  }
});

function failed(e: unknown) {
  {
    if (e instanceof Problem) return reply(e.status, { error: e.message });
    // deno-postgres puts the database's error code and message in e.fields (or, inside a
    // transaction, in the wrapped error: e.cause.fields)
    type Pg = { fields?: { code?: string; message?: string }; cause?: { fields?: { code?: string; message?: string } } };
    const fields = (e as Pg).fields ?? (e as Pg).cause?.fields;
    const pg = { code: fields?.code, message: fields?.message };
    if (pg.code === "42501") return reply(403, { error: pg.message || "Not allowed." });
    if (pg.code && /^(P0001|23|22)/.test(pg.code)) return reply(400, { error: pg.message });
    console.error(e);
    return reply(500, { error: "Something went wrong." });
  }
}

// Approve a suggestion: the person signed in to the app runs it, under their own permissions, still
// marked "via" the key that suggested it, dated as of when it was suggested
async function approve(token: string, id: string) {
  const who = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!who?.id) return reply(401, { error: "Sign in to approve a suggestion." });
  try {
    const result = await inTransaction(async (tx) => {
      const [s] = await tx`select a.id, a.brewery_id, a.key_id, a.status, a.method, a.path, a.request,
                                  (a.created_at at time zone br.time_zone)::date::text as suggested_on
                             from public.api_actions a join public.breweries br on br.id = a.brewery_id where a.id::text = ${id}`;
      if (!s || s.status !== "suggested") throw new Problem(404, "That suggestion isn't waiting for review.");
      await tx`select set_config('brewery_os.api_key', ${s.key_id}, true)`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: who.id, role: "authenticated" })}, true)`;
      await tx`set local role authenticated`;
      const [me] = await tx`select current_user as role, auth.uid()::text as uid, public.is_member(${s.brewery_id}) as member`;
      if (me?.role !== "authenticated" || me?.uid !== who.id) throw new Problem(503, "The approval couldn't run as you, so it did nothing. Try again.");
      if (!me.member) throw new Problem(403, "That suggestion isn't in your brewery.");
      const [resource, ref, sub] = String(s.path).split("/").map(decodeURIComponent);
      const done = await route(tx, s.brewery_id, who.email, s.method, resource, ref, sub, s.request, new URLSearchParams(), s.path,
                               { mode: "approve", today: s.suggested_on });
      await tx`select public.approve_api_suggestion(${s.id}::uuid, ${JSON.stringify(done.body)}::jsonb)`;
      return { approved: true, summary: done.summary, result: done.body };
    });
    return reply(200, result);
  } catch (e) {
    return failed(e);
  }
}

// deno-lint-ignore no-explicit-any
type Tx = any;
// How a write runs: directly, as a suggestion (tried and undone), or as an approved suggestion
type Ctx = { mode: "direct" | "suggest" | "approve"; today?: string };
type Answer = { status?: number; body: unknown; summary?: string };
async function route(tx: Tx, b: string, email: string, method: string, resource?: string, ref?: string, sub?: string,
                     body?: Record<string, unknown> | null, query?: URLSearchParams, pathText = "", ctx: Ctx = { mode: "direct" }): Promise<Answer> {
  const is = (m: string, r: string, hasRef: boolean, s?: string) => method === m && resource === r && !!ref === hasRef && sub === s;
  if (method !== "GET") {
    const done = await write(tx, b, method, resource, ref, sub, body ?? {}, pathText, ctx);
    if (done) return done;
  }

  if (is("GET", "me", false)) {
    const [me] = await tx`select br.name as brewery, br.temperature_unit, br.gravity_unit, br.volume_unit, br.time_zone,
                                 public.my_permissions(br.id) as permissions
                            from public.breweries br where br.id = ${b}`;
    return { body: { brewery: me.brewery, signed_in_as: email, permissions: me.permissions,
      units: { temperature: me.temperature_unit, gravity: me.gravity_unit, volume: me.volume_unit }, time_zone: me.time_zone } };
  }

  if (is("GET", "tanks", false) || is("GET", "tanks", true)) {
    const rows = await tx`select t.id, t.name, t.type, t.status, t.capacity_bbl, l.name as location,
                                 s.id as batch_id, s.batch_number, be.name as beer, s.stage, s.stage_started_on::text as stage_started_on,
                                 public.tank_balance(s.id, t.id) as volume_bbl
                            from public.tanks t
                            left join public.locations l on l.id = t.location_id
                            left join public.batch_status s on s.tank_id = t.id and s.stage not in ('packaged', 'used')
                            left join public.beers be on be.id = s.beer_id
                           where t.brewery_id = ${b} and (${ref ?? null}::text is null or t.id::text = ${ref ?? null} or lower(t.name) = lower(${ref ?? null}))
                           order by t.name`;
    const tanks = rows.map((r: Record<string, unknown>) => ({
      id: r.id, name: r.name, type: r.type, status: r.status, location: r.location, capacity_bbl: num(r.capacity_bbl),
      batch: r.batch_id ? { id: r.batch_id, number: r.batch_number, beer: r.beer, stage: r.stage, stage_started_on: r.stage_started_on,
        volume_bbl: round(num(r.volume_bbl), 3) } : null,
    }));
    if (ref && !tanks.length) throw new Problem(404, `No tank "${ref}".`);
    return { body: ref ? tanks[0] : tanks };
  }

  if (is("PATCH", "tanks", true)) {
    const status = body?.status;
    if (!["empty", "cleaning", "maintenance"].includes(String(status))) throw new Problem(400, 'Send { "status": "empty" | "cleaning" | "maintenance" }.');
    const [before] = await tx`select status from public.tanks where brewery_id = ${b} and (id::text = ${ref} or lower(name) = lower(${ref}))`;
    const updated = await tx`update public.tanks set status = ${String(status)}
                              where brewery_id = ${b} and (id::text = ${ref} or lower(name) = lower(${ref})) returning id, name, status`;
    if (!updated.length) throw new Problem(404, `No tank "${ref}" (or it can't be changed with this key).`);
    const summary = `${updated[0].name} set to ${updated[0].status}`;
    // (what it was, and what it was set to: for undo, which refuses if it's been changed since)
    const result = { id: updated[0].id, was: { status: before?.status }, now: { status: updated[0].status } };
    if (ctx.mode === "direct") await tx`select public.log_api_action(${method}, ${pathText}, ${summary}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(result)}::jsonb)`;
    return { body: { ...updated[0], was: result.was, now: result.now }, summary };
  }

  if (is("GET", "batches", false)) {
    const all = query?.get("all") === "true";
    const rows = await tx`select s.id, s.batch_number, be.name as beer, s.brew_date::text as brew_date, s.stage, s.stage_started_on::text as stage_started_on, t.name as tank,
                                 case when s.tank_id is not null then public.tank_balance(s.id, s.tank_id) end as volume_bbl
                            from public.batch_status s join public.beers be on be.id = s.beer_id
                            left join public.tanks t on t.id = s.tank_id
                           where s.brewery_id = ${b} and (${all} or s.stage not in ('packaged', 'used'))
                           order by s.brew_date desc nulls last`;
    return { body: rows.map((r: Record<string, unknown>) => ({ ...r, volume_bbl: round(num(r.volume_bbl), 3) })) };
  }

  if (resource === "batches" && ref) {
    const [batch] = await tx`select s.id, s.batch_number, be.name as beer, s.brew_date::text as brew_date, s.stage, s.stage_started_on::text as stage_started_on, t.name as tank,
                                    case when s.tank_id is not null then public.tank_balance(s.id, s.tank_id) end as volume_bbl
                               from public.batch_status s join public.beers be on be.id = s.beer_id
                               left join public.tanks t on t.id = s.tank_id
                              where s.brewery_id = ${b} and (s.id::text = ${ref} or lower(s.batch_number) = lower(${ref.replace(/^#/, "")}))`;
    if (!batch) throw new Problem(404, `No batch "${ref}".`);

    if (method === "POST" && sub === "log") {
      const g = body?.gravity_sg != null ? Number(body.gravity_sg) : body?.gravity_plato != null ? platoToSg(Number(body.gravity_plato)) : null;
      const t = body?.temp_c != null ? Number(body.temp_c) : body?.temp_f != null ? (Number(body.temp_f) - 32) * 5 / 9 : null;
      const id = typeof body?.id === "string" ? body.id : crypto.randomUUID(); // send your own id to make retries safe
      await tx`select public.log_cellar_entry(${id}::uuid, ${b}::uuid, ${batch.id}::uuid,
                 coalesce(${(body?.occurred_on as string) ?? null}::date, current_date), ${String(body?.action ?? "")},
                 ${g}::numeric, ${body?.ph != null ? Number(body.ph) : null}::numeric, ${t}::numeric,
                 ${String(body?.cellar_change ?? "")}, ${String(body?.notes ?? "")}, ${(body?.new_stage as string) ?? null})`;
      const summary = `Logged ${String(body?.action || "an entry")} on #${batch.batch_number} (${batch.beer})`;
      if (ctx.mode === "direct") await tx`select public.log_api_action(${method}, ${pathText}, ${summary}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify({ id, batch: batch.batch_number })}::jsonb)`;
      return { status: 201, body: { id, batch: batch.batch_number, saved: true }, summary };
    }
    if (method === "GET" && (!sub || sub === "log")) {
      const log = await tx`select id, occurred_on::text as occurred_on, action, gravity_sg, ph, temp_c, cellar_change, notes
                             from public.cellar_entries where batch_id = ${batch.id} order by occurred_on, recorded_at`;
      return { body: { ...batch, volume_bbl: round(num(batch.volume_bbl), 3),
        log: log.map((e: Record<string, unknown>) => ({ id: e.id, occurred_on: e.occurred_on, action: e.action, gravity: gravity(e.gravity_sg),
          ph: num(e.ph), temperature: temperature(e.temp_c), cellar_change: e.cellar_change, notes: e.notes })) } };
    }
  }

  if (is("GET", "beers", false)) {
    const beers = await tx`select id, name, style, target_og, target_fg, menu_description, menu_abv, menu_ibu, menu_prices, menu_short, menu_srm,
                                  menu_section, menu_tags, menu_extra, menu_public from public.beers where brewery_id = ${b} order by name`;
    // The menu's lists (Settings → Menu), so a beer's menu reads by name ("16 oz", "IPAs"), not by id
    const [setup] = await tx`select menu_sizes, menu_sections, menu_tags, menu_fields from public.breweries where id = ${b}`;
    const places = await tx`select id, name from public.stock_places where brewery_id = ${b}`;
    type Item = { id: string; name: string; oz?: number | null; kind?: string };
    const byId = (list: Item[], id: unknown) => list.find((i) => i.id === id);
    const menuOf = (x: Record<string, unknown>) => {
      const extra = (x.menu_extra || {}) as Record<string, unknown>;
      return {
        short: x.menu_short, description: x.menu_description, abv: num(x.menu_abv), ibu: num(x.menu_ibu), color_srm: num(x.menu_srm),
        section: byId(setup.menu_sections, x.menu_section)?.name ?? null,
        tags: ((x.menu_tags || []) as string[]).map((id) => byId(setup.menu_tags, id)).filter(Boolean).map((t) => ({ name: t!.name, kind: t!.kind })),
        fields: Object.fromEntries((setup.menu_fields as Item[]).filter((f) => extra[f.id] != null).map((f) => [f.name, extra[f.id]])),
        prices: ((x.menu_prices || []) as { size: string; price: number; at?: Record<string, number> }[])
          .filter((p) => byId(setup.menu_sizes, p.size)).map((p) => ({
            size: byId(setup.menu_sizes, p.size)!.name, oz: byId(setup.menu_sizes, p.size)!.oz ?? null, price: num(p.price),
            at_taprooms: Object.entries(p.at || {}).map(([place, price]) => ({
              taproom: places.find((pl: Record<string, unknown>) => pl.id === place)?.name ?? null, price: num(price) })) })),
        on_public_menu: x.menu_public,
      };
    };
    // The recipe, as it's kept here: the latest batch's brew-day ingredients
    const ingredients = await tx`select distinct on (bt.beer_id, a.id) bt.beer_id, a.kind, a.name, a.amount, a.unit, a.timing
                                   from public.batch_additions a join public.batches bt on bt.id = a.batch_id
                                  where a.brewery_id = ${b} and a.brew_day
                                    and bt.id = (select x.id from public.batches x where x.beer_id = bt.beer_id
                                                   and exists (select 1 from public.batch_additions y where y.batch_id = x.id and y.brew_day)
                                                 order by x.brew_date desc nulls last limit 1)`;
    const recipes = await tx`select r.id, r.beer_id, r.name, r.batch_size_bbl, r.target_og, r.target_fg, r.ibu, l.name as location,
                                    coalesce((select json_agg(json_build_object('kind', i.kind, 'name', i.name, 'amount', i.amount, 'unit', i.unit, 'timing', i.timing)
                                                order by i.position) from public.recipe_ingredients i where i.recipe_id = r.id), '[]') as ingredients
                               from public.recipes r left join public.locations l on l.id = r.location_id where r.brewery_id = ${b}`;
    return { body: beers.map((x: Record<string, unknown>) => ({
      id: x.id, name: x.name, style: x.style, target_og: gravity(x.target_og), target_fg: gravity(x.target_fg),
      menu: menuOf(x),
      recipes: recipes.filter((r: Record<string, unknown>) => r.beer_id === x.id).map((r: Record<string, unknown>) => ({
        id: r.id, name: r.name, location: r.location ?? "any", batch_size_bbl: round(num(r.batch_size_bbl), 2), target_og: gravity(r.target_og),
        target_fg: gravity(r.target_fg), ibu: num(r.ibu), ingredients: r.ingredients })),
      ingredients: ingredients.filter((i: Record<string, unknown>) => i.beer_id === x.id)
        .map((i: Record<string, unknown>) => ({ kind: i.kind, name: i.name, amount: num(i.amount), unit: i.unit, timing: i.timing })),
    })) };
  }

  if (is("GET", "inventory", false)) {
    const rows = await tx`select be.name as beer, p.name as place, l.name as location, pt.name as package, h.count, h.count * pt.volume_bbl as bbl
                            from public.stock_on_hand h join public.beers be on be.id = h.beer_id
                            join public.stock_places p on p.id = h.place_id left join public.locations l on l.id = p.location_id
                            join public.package_types pt on pt.id = h.package_type_id
                           where h.brewery_id = ${b} and h.count > 0 order by be.name, l.name, p.name, pt.name`;
    return { body: rows.map((r: Record<string, unknown>) => ({ ...r, count: num(r.count), bbl: round(num(r.bbl), 3) })) };
  }

  throw new Problem(404, "Not an API address. See docs/api.md for what's available.");
}

// ---------- Writes ----------
// Each finds what it's about by id or by name, runs the app's own action for it, and lists itself
// in the key's activity. Anything the key's owner (or the key) may not do is refused by the
// database, as in the app. Dates are "YYYY-MM-DD" (today, in the brewery's time zone, if left out).
type Body = Record<string, unknown>;
const text = (v: unknown) => (v == null ? "" : String(v).trim());
const numberOr = (v: unknown, name: string) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Problem(400, `${name} should be a number.`);
  return n;
};
const dateOr = (v: unknown) => {
  if (v == null || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Problem(400, `Dates are written like 2026-10-07 (not "${v}").`);
  return String(v);
};
const idOr = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : crypto.randomUUID());
const STAGES = ["fermenting", "dry-hopping", "conditioning", "carbonating", "ready", "packaged"];

async function write(tx: Tx, b: string, method: string, resource?: string, ref?: string, sub?: string, body: Body = {}, pathText = "",
                     ctx: Ctx = { mode: "direct" }): Promise<Answer | null> {
  // (an approved suggestion is dated as of when it was suggested)
  const [{ today }] = ctx.today ? [{ today: ctx.today }]
    : await tx`select (now() at time zone time_zone)::date::text as today from public.breweries where id = ${b}`;
  const day = (v: unknown) => dateOr(v) ?? today;
  // Find one thing by its id or name; a name that matches none (or several) is a clear 400
  async function one(kind: string, rows: Record<string, unknown>[], what: unknown) {
    if (!rows.length) throw new Problem(404, `No ${kind} "${what}".`);
    if (rows.length > 1) throw new Problem(400, `More than one ${kind} is called "${what}": use its id.`);
    return rows[0];
  }
  const tank = async (r: unknown) => one("tank", await tx`select id, name, type, location_id from public.tanks
    where brewery_id = ${b} and (id::text = ${text(r)} or lower(name) = lower(${text(r)}))`, r);
  const beer = async (r: unknown) => one("beer", await tx`select id, name from public.beers
    where brewery_id = ${b} and (id::text = ${text(r)} or lower(name) = lower(${text(r)}))`, r);
  // A place: its id, its name if only one place has it, or "Location Name" ("Riverside Taproom")
  const place = async (r: unknown) => one("place", await tx`select p.id, p.name, l.name as location from public.stock_places p
    left join public.locations l on l.id = p.location_id
    where p.brewery_id = ${b} and p.active and (p.id::text = ${text(r)} or lower(p.name) = lower(${text(r)})
      or lower(coalesce(l.name, '') || ' ' || p.name) = lower(${text(r)}) or lower(coalesce(l.name, '') || ' / ' || p.name) = lower(${text(r)}))`, r);
  const packageType = async (r: unknown) => one("package type", await tx`select id, name from public.package_types
    where brewery_id = ${b} and (id::text = ${text(r)} or lower(name) = lower(${text(r)}))`, r);
  const batchRow = async (r: string) => one("batch", await tx`select s.id, s.batch_number, s.beer_id, s.brew_date::text as brew_date, s.size_bbl,
      s.stage, s.stage_started_on::text as stage_started_on, s.tank_id, be.name as beer
    from public.batch_status s join public.beers be on be.id = s.beer_id
    where s.brewery_id = ${b} and (s.id::text = ${r} or lower(s.batch_number) = lower(${r.replace(/^#/, "")}))`, r);
  // List the write in the key's activity, and answer
  const done = async (summary: string, result: Body, status = 201): Promise<Answer> => {
    if (ctx.mode === "direct") {
      await tx`select public.log_api_action(${method}, ${pathText}, ${summary}, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(result)}::jsonb)`;
    }
    return { status, body: { ...result, saved: true }, summary };
  };

  // POST /batches: start a batch in a tank
  if (method === "POST" && resource === "batches" && !ref) {
    const number = text(body.number);
    if (!number) throw new Problem(400, 'Send the batch number: { "number": "142", "beer": "House Hazy", "tank": "FV3" }.');
    const t = await tank(body.tank), be = await beer(body.beer);
    const stage = text(body.stage) || "fermenting";
    if (!STAGES.includes(stage) || stage === "packaged") throw new Problem(400, `A new batch's stage is one of: ${STAGES.slice(0, 5).join(", ")}.`);
    const id = idOr(body.id), brewed = day(body.brew_date);
    await tx`select public.save_batch(${id}::uuid, ${b}::uuid, ${number}, ${be.id}::uuid, ${brewed}::date, ${numberOr(body.size_bbl, "size_bbl")}::numeric,
               ${stage}, ${brewed}::date, ${t.id}::uuid, ${today}::date, ${numberOr(body.volume_bbl, "volume_bbl")}::numeric)`;
    return done(`Started #${number} (${be.name}) in ${t.name}`, { id, batch: number, beer: be.name, tank: t.name, stage });
  }

  if (resource === "batches" && ref && method === "POST" && ["stage", "package", "level", "additions"].includes(String(sub))) {
    const x = await batchRow(ref);
    // POST /batches/{n}/stage: a new stage, and/or a transfer to another tank (with the volume moved)
    if (sub === "stage") {
      const stage = text(body.stage) || x.stage;
      if (!STAGES.includes(String(stage))) throw new Problem(400, `The stage is one of: ${STAGES.join(", ")}.`);
      if (stage === "packaged") throw new Problem(400, "To package a batch, use POST /batches/{n}/package (it counts the kegs and cases).");
      const to = body.tank ? await tank(body.tank) : null;
      const tankId = to?.id ?? x.tank_id;
      if (!tankId) throw new Problem(400, "This batch isn't in a tank.");
      const on = day(body.date);
      await tx`select public.save_batch(${x.id}::uuid, ${b}::uuid, ${x.batch_number}, ${x.beer_id}::uuid, ${x.brew_date}::date, ${x.size_bbl}::numeric,
                 ${stage}, ${stage !== x.stage ? on : x.stage_started_on}::date, ${tankId}::uuid, ${on}::date, ${numberOr(body.volume_bbl, "volume_bbl")}::numeric)`;
      const [now] = await tx`select s.stage, t.name as tank from public.batch_status s left join public.tanks t on t.id = s.tank_id where s.id = ${x.id}`;
      return done(`#${x.batch_number} (${x.beer}): ${now.stage}${to ? `, moved to ${now.tank}` : ""}`, { id: x.id, batch: x.batch_number, stage: now.stage, tank: now.tank });
    }
    if (!x.tank_id || ["packaged", "used"].includes(String(x.stage))) throw new Problem(400, `#${x.batch_number} isn't in a tank.`);
    // POST /batches/{n}/package: { "counts": [{ "package": "½ bbl keg", "count": 20 }], "spent": true, "place": "Riverside Storage" }
    if (sub === "package") {
      if (!Array.isArray(body.counts)) throw new Problem(400, 'Send { "counts": [{ "package": "½ bbl keg", "count": 20 }], "spent": true }.');
      const counts = [];
      for (const c of body.counts as Body[]) counts.push({ type: (await packageType(c.package)).id, count: numberOr(c.count, "count") });
      const where = body.place ? await place(body.place) : null;
      const id = idOr(body.id);
      await tx`select public.record_packaging(${id}::uuid, ${b}::uuid, ${x.id}::uuid, ${x.tank_id}::uuid, ${day(body.date)}::date,
                 ${JSON.stringify(counts)}::jsonb, ${body.spent === true}, ${text(body.notes)}, ${where?.id ?? null}::uuid)`;
      const total = (body.counts as Body[]).map((c) => `${c.count} × ${c.package}`).join(", ");
      return done(`Packaged #${x.batch_number} (${x.beer}): ${total}${body.spent === true ? ", tank spent" : ""}`, { id, batch: x.batch_number });
    }
    // POST /batches/{n}/level: { "volume_bbl": 12.5, "reason": "served" | "loss" | "correction" }
    if (sub === "level") {
      const reading = numberOr(body.volume_bbl, "volume_bbl");
      if (reading == null) throw new Problem(400, 'Send what the sight glass shows: { "volume_bbl": 12.5 }.');
      const [t] = await tx`select type from public.tanks where id = ${x.tank_id}`;
      const reason = text(body.reason) || (t.type === "serving" ? "served" : "loss");
      if (!["served", "loss", "correction"].includes(reason)) throw new Problem(400, 'The reason for a drop is "served", "loss", or "correction".');
      const id = idOr(body.id);
      await tx`select public.record_level_check(${id}::uuid, ${b}::uuid, ${x.id}::uuid, ${x.tank_id}::uuid, ${day(body.date)}::date,
                 ${reading}::numeric, ${reason}, ${text(body.notes)})`;
      return done(`Level check on #${x.batch_number} (${x.beer}): ${reading} bbl`, { id, batch: x.batch_number, volume_bbl: reading });
    }
    // POST /batches/{n}/additions: { "name": "Citra", "amount": 22, "unit": "lb", "lot": "CIT-104", "timing": "Dry hop" }
    if (sub === "additions") {
      const name = text(body.name);
      if (!name) throw new Problem(400, 'Send at least the name: { "name": "Citra", "amount": 22, "unit": "lb" }.');
      const id = idOr(body.id);
      const [made] = await tx`insert into public.batch_additions (id, brewery_id, batch_id, added_on, kind, name, amount, unit, timing, lot, notes, brew_day, turn)
        values (${id}::uuid, ${b}::uuid, ${x.id}::uuid, ${day(body.date)}::date, ${text(body.kind) || "other"}, ${name}, ${numberOr(body.amount, "amount")}::numeric,
                ${text(body.unit) || "lb"}, ${text(body.timing)}, ${text(body.lot)}, ${text(body.notes)}, ${body.brew_day === true},
                ${numberOr(body.turn, "turn")}::int)
        on conflict (id) do nothing returning id`;
      return done(`Added ${body.amount ?? ""} ${text(body.unit) || ""} ${name} to #${x.batch_number}`.replace(/\s+/g, " "), { id, batch: x.batch_number, saved_now: !!made });
    }
  }

  // POST /tanks/{name}/acid: an acid cycle
  if (method === "POST" && resource === "tanks" && ref && sub === "acid") {
    const t = await tank(ref);
    const id = idOr(body.id);
    await tx`insert into public.tank_cleanings (id, brewery_id, tank_id, kind, cleaned_on, note)
             values (${id}::uuid, ${b}::uuid, ${t.id}::uuid, 'acid', ${day(body.date)}::date, ${text(body.note)}) on conflict (id) do nothing`;
    return done(`Acid cycle on ${t.name}`, { id, tank: t.name });
  }

  // POST /stock/moves: { "from": "Riverside Storage", "to": "Riverside Taproom", "lines": [{ "beer": "House Hazy", "package": "½ bbl keg", "count": 2 }] }
  //   or a removal: { "from": ..., "removal": "sold", "account": "Corner Tavern", "lines": [...] }
  if (method === "POST" && resource === "stock" && ref === "moves") {
    if (!Array.isArray(body.lines) || !body.lines.length) throw new Problem(400, 'Send the lines: [{ "beer": "House Hazy", "package": "½ bbl keg", "count": 2 }].');
    const from = body.from ? await place(body.from) : null, to = body.to ? await place(body.to) : null;
    const removal = text(body.removal) || null;
    if (removal && !["sold", "taproom", "transferred", "donated", "dumped"].includes(removal)) {
      throw new Problem(400, 'A removal is "sold", "taproom", "transferred", "donated", or "dumped".');
    }
    const lines = [];
    for (const l of body.lines as Body[]) lines.push({ beer: (await beer(l.beer)).id, type: (await packageType(l.package)).id, count: numberOr(l.count, "count") });
    const id = idOr(body.id);
    await tx`select public.record_stock(${id}::uuid, ${b}::uuid, ${day(body.date)}::date, ${from?.id ?? null}::uuid, ${to?.id ?? null}::uuid,
               ${removal}, ${JSON.stringify(lines)}::jsonb, ${text(body.account)}, ${text(body.notes)})`;
    const what = (body.lines as Body[]).map((l) => `${l.count} × ${l.package} ${l.beer}`).join(", ");
    return done(to && from ? `Moved ${what}: ${from.name} → ${to.name}` : from ? `Removed (${removal}) ${what} from ${from.name}` : `Returned ${what} to ${to?.name}`, { id });
  }

  // POST /stock/counts: { "place": "Riverside Taproom", "counts": [{ "beer": "House Hazy", "package": "½ bbl keg", "count": 3 }], "shortfall": "taproom" }
  if (method === "POST" && resource === "stock" && ref === "counts") {
    if (!Array.isArray(body.counts)) throw new Problem(400, 'Send the counts: [{ "beer": "House Hazy", "package": "½ bbl keg", "count": 3 }].');
    const where = await place(body.place);
    const lines = [];
    for (const l of body.counts as Body[]) lines.push({ beer: (await beer(l.beer)).id, type: (await packageType(l.package)).id, counted: numberOr(l.count, "count") });
    const shortfall = text(body.shortfall) || null;
    const id = idOr(body.id);
    await tx`select public.record_count(${id}::uuid, ${b}::uuid, ${where.id}::uuid, ${day(body.date)}::date, ${JSON.stringify(lines)}::jsonb,
               ${shortfall}, ${text(body.notes) || null})`;
    return done(`Counted ${where.name} (${lines.length} ${lines.length === 1 ? "line" : "lines"})`, { id, place: where.name });
  }

  // POST /raw/receipts: { "item": "Citra", "lot": "CIT-210", "amount": 44, "supplier": "...", "cost": 616 }
  if (method === "POST" && resource === "raw" && ref === "receipts") {
    const [item] = await tx`select id, name, unit from public.raw_items where brewery_id = ${b} and (id::text = ${text(body.item)} or lower(name) = lower(${text(body.item)}))`;
    if (!item) throw new Problem(404, `No raw material "${body.item}" (add it in Inventory → Raw materials → Items first).`);
    const amount = numberOr(body.amount, "amount");
    if (!amount || amount <= 0) throw new Problem(400, `Send the amount received, in the item's unit (${item.unit}).`);
    const id = idOr(body.id);
    await tx`insert into public.raw_receipts (id, brewery_id, item_id, received_on, lot, amount, supplier, cost, notes)
             values (${id}::uuid, ${b}::uuid, ${item.id}::uuid, ${day(body.date)}::date, ${text(body.lot)}, ${amount}::numeric, ${text(body.supplier)},
                     ${numberOr(body.cost, "cost")}::numeric, ${text(body.notes)}) on conflict (id) do nothing`;
    return done(`Received ${amount} ${item.unit} ${item.name}${body.lot ? ` (lot ${body.lot})` : ""}`, { id, item: item.name });
  }

  // POST /plan: { "kind": "brew", "date": "2026-10-14", "tank": "FV3", "beer": "House Hazy", "notes": "..." }
  if (method === "POST" && resource === "plan" && !ref) {
    const kind = text(body.kind) || "other";
    const t = body.tank ? await tank(body.tank) : null, be = body.beer ? await beer(body.beer) : null;
    const id = idOr(body.id);
    await tx`insert into public.plan_items (id, brewery_id, kind, title, planned_on, someday, tank_id, beer_id, notes)
             values (${id}::uuid, ${b}::uuid, ${kind}, ${text(body.title)}, ${dateOr(body.date)}::date, ${text(body.someday)}, ${t?.id ?? null}::uuid,
                     ${be?.id ?? null}::uuid, ${text(body.notes)}) on conflict (id) do nothing`;
    return done(`Planned ${kind.replace("_", " ")}${be ? ` of ${be.name}` : ""}${t ? ` in ${t.name}` : ""} ${body.date ?? body.someday ?? ""}`.trim(), { id });
  }

  // PATCH /beers/{name}: targets and menu details (sizes, sections, and tags by name)
  if (method === "PATCH" && resource === "beers" && ref) {
    const be = await beer(ref);
    const [setup] = await tx`select menu_sizes, menu_sections, menu_tags from public.breweries where id = ${b}`;
    type Item = { id: string; name: string };
    const byName = (list: Item[], name: unknown, what: string) => {
      const found = list.find((i) => i.name.toLowerCase() === text(name).toLowerCase());
      if (!found) throw new Problem(400, `No ${what} called "${name}" (Settings → Menu).`);
      return found.id;
    };
    const m = (body.menu ?? {}) as Body;
    const set: Record<string, unknown> = {};
    if ("style" in body) set.style = text(body.style);
    if ("target_og" in body) set.target_og = numberOr(body.target_og, "target_og");
    if ("target_fg" in body) set.target_fg = numberOr(body.target_fg, "target_fg");
    if ("short" in m) set.menu_short = text(m.short);
    if ("description" in m) set.menu_description = text(m.description);
    if ("abv" in m) set.menu_abv = numberOr(m.abv, "abv");
    if ("ibu" in m) set.menu_ibu = numberOr(m.ibu, "ibu");
    if ("color_srm" in m) set.menu_srm = numberOr(m.color_srm, "color_srm");
    if ("on_public_menu" in m) set.menu_public = m.on_public_menu !== false;
    if ("section" in m) set.menu_section = m.section ? byName(setup.menu_sections, m.section, "section") : null;
    if ("tags" in m) set.menu_tags = ((m.tags ?? []) as unknown[]).map((t) => byName(setup.menu_tags, t, "tag"));
    if ("prices" in m) set.menu_prices = ((m.prices ?? []) as Body[]).map((p) => ({ size: byName(setup.menu_sizes, p.size, "pour size"), price: numberOr(p.price, "price") }));
    if (!Object.keys(set).length) throw new Problem(400, 'Send what to change: { "style": ..., "menu": { "short": ..., "abv": ..., "prices": [{ "size": "16 oz", "price": 7 }] } }.');
    // (the changed columns before and after: for undo, which refuses if they've been changed since)
    const columns = Object.keys(set);
    const snapshot = async () => {
      const [row] = await tx`select to_jsonb(x) as row from public.beers x where id = ${be.id}`;
      return Object.fromEntries(columns.map((c) => [c, row.row[c] ?? null]));
    };
    const was = await snapshot();
    // (only what was sent changes; the database's rules check it, as for the app's form. Prices replace the beer's price list.)
    const [updated] = await tx`update public.beers set
        style = case when ${"style" in set} then ${set.style ?? null}::text else style end,
        target_og = case when ${"target_og" in set} then ${set.target_og ?? null}::numeric else target_og end,
        target_fg = case when ${"target_fg" in set} then ${set.target_fg ?? null}::numeric else target_fg end,
        menu_short = case when ${"menu_short" in set} then ${set.menu_short ?? null}::text else menu_short end,
        menu_description = case when ${"menu_description" in set} then ${set.menu_description ?? null}::text else menu_description end,
        menu_abv = case when ${"menu_abv" in set} then ${set.menu_abv ?? null}::numeric else menu_abv end,
        menu_ibu = case when ${"menu_ibu" in set} then ${set.menu_ibu ?? null}::numeric else menu_ibu end,
        menu_srm = case when ${"menu_srm" in set} then ${set.menu_srm ?? null}::numeric else menu_srm end,
        menu_public = case when ${"menu_public" in set} then ${set.menu_public ?? true}::boolean else menu_public end,
        menu_section = case when ${"menu_section" in set} then ${set.menu_section ?? null}::text else menu_section end,
        menu_tags = case when ${"menu_tags" in set} then array(select jsonb_array_elements_text(${JSON.stringify(set.menu_tags ?? [])}::jsonb)) else menu_tags end,
        menu_prices = case when ${"menu_prices" in set} then ${JSON.stringify(set.menu_prices ?? [])}::jsonb else menu_prices end
      where id = ${be.id} returning id`;
    if (!updated) throw new Problem(403, "This key can't change that beer.");
    return done(`Changed ${be.name}: ${Object.keys(set).map((k) => k.replace("menu_", "menu ")).join(", ")}`, { id: be.id, beer: be.name, was, now: await snapshot() }, 200);
  }

  // PUT /lines/{taproom}/{line}: { "beer": "House Hazy" } | { "label": "Guest cider" } | { "status": "empty" | "out" }
  if (method === "PUT" && resource === "lines" && ref && sub) {
    const where = await place(ref);
    const lineNo = Number(sub);
    if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > 200) throw new Problem(400, "Lines are numbered 1 to 200.");
    const be = body.beer ? await beer(body.beer) : null;
    const status = be ? "beer" : body.label ? "other" : text(body.status) || "empty";
    if (!["beer", "other", "empty", "out"].includes(status)) throw new Problem(400, 'Send { "beer": ... }, { "label": ... }, or { "status": "empty" | "out" }.');
    const line = async () => (await tx`select status, beer_id, label from public.draft_lines where place_id = ${where.id} and line_no = ${lineNo}`)[0] ?? null;
    const was = await line();
    await tx`insert into public.draft_lines (brewery_id, place_id, line_no, status, beer_id, label)
             values (${b}::uuid, ${where.id}::uuid, ${lineNo}, ${status}, ${be?.id ?? null}::uuid, ${status === "other" ? text(body.label) : ""})
             on conflict (place_id, line_no) do update set status = excluded.status, beer_id = excluded.beer_id, label = excluded.label`;
    return done(`${where.name} line ${lineNo}: ${be ? be.name : status === "other" ? text(body.label) : status}`,
      { place: where.name, place_id: where.id, line: lineNo, pours: be?.name ?? (text(body.label) || status), was, now: await line() }, 200);
  }
  return null;
}
