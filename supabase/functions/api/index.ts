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
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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
  const key = header.startsWith("Bearer bos_") ? header.slice(7) : req.headers.get("X-Api-Key");
  if (!key?.startsWith("bos_")) return reply(401, { error: "Send an API key: Authorization: Bearer bos_..." });
  const path = new URL(req.url).pathname.split("/").filter(Boolean);
  const at = path.indexOf("api");
  const [resource, ref, sub] = path.slice(at + 1).map(decodeURIComponent);
  const body = ["POST", "PATCH"].includes(req.method) ? await req.json().catch(() => null) : null;

  try {
    const result = await inTransaction(async (tx) => {
      // The key: known, not revoked
      const [k] = await tx`select id, brewery_id, user_id, permissions, revoked_at, last_used_at
                             from public.api_keys where key_hash = ${await sha256(key)}`;
      if (!k || k.revoked_at) throw new Problem(401, "That API key isn't valid (or was revoked).");
      if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60_000) {
        await tx`update public.api_keys set last_used_at = now() where id = ${k.id}`;
      }
      const [owner] = await tx`select email from auth.users where id = ${k.user_id}`; // (before switching: people can't read the user list)
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
      return await route(tx, k.brewery_id, owner?.email, req.method, resource, ref, sub, body, new URL(req.url).searchParams);
    });
    return reply(result.status ?? 200, result.body);
  } catch (e) {
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
});

// deno-lint-ignore no-explicit-any
type Tx = any;
async function route(tx: Tx, b: string, email: string, method: string, resource?: string, ref?: string, sub?: string,
                     body?: Record<string, unknown> | null, query?: URLSearchParams): Promise<{ status?: number; body: unknown }> {
  const is = (m: string, r: string, hasRef: boolean, s?: string) => method === m && resource === r && !!ref === hasRef && sub === s;

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
    const updated = await tx`update public.tanks set status = ${String(status)}
                              where brewery_id = ${b} and (id::text = ${ref} or lower(name) = lower(${ref})) returning id, name, status`;
    if (!updated.length) throw new Problem(404, `No tank "${ref}" (or it can't be changed with this key).`);
    return { body: updated[0] };
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
      return { status: 201, body: { id, batch: batch.batch_number, saved: true } };
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
