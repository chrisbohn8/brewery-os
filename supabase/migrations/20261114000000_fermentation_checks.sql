-- Fermentation checks (the user's, 2026-10-10): alerts from a batch's own readings, each with
-- thresholds the brewery can change (Settings → Alerts). Gravity differences are kept in SG, like the
-- "far from target" limits (0.004 SG is about 1 °P).
--   stalled         dropped less than 0.002 (0.5 °P) over 3 days, while more than 0.006 (1.5 °P) above the target FG
--   looks_finished  the latest reading within 0.0008 (0.2 °P) of one at least 2 days before it, near the target FG (a nudge)
--   finished_off    steady like that, but more than 0.004 (1 °P) from the target FG: high (stuck?) or low (wild yeast?)
--   ph              still above 4.8 after 3 days, or up more than 0.2 from its lowest; sour styles left out

alter table public.alert_rules drop constraint alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock', 'short_for_brew', 'gravity_due',
                  'stalled', 'looks_finished', 'finished_off', 'ph'));

create or replace function public.alert_params(p_kind text, p_params jsonb) returns jsonb
language sql immutable as $$
  select (case p_kind
    when 'no_gravity'     then '{"days": 3, "stages": ["fermenting", "dry-hopping"]}'
    when 'stage_too_long' then '{"days": {"fermenting": 21, "dry-hopping": 7, "conditioning": 28, "carbonating": 7, "ready": 30}}'
    when 'stalled'        then '{"drop": 0.002, "days": 3, "above_fg": 0.006}'
    when 'looks_finished' then '{"within": 0.0008, "days": 2}'
    when 'finished_off'   then '{"off": 0.004}'
    when 'ph'             then '{"max_after": 4.8, "days": 3, "rise": 0.2, "skip_styles": ["sour", "gose", "berliner", "lambic", "wild"]}'
    else '{}' end)::jsonb || coalesce(p_params, '{}');
$$;

-- A gravity difference in the brewery's unit, for messages: "0.3 °P", "0.0012 SG"
create function public.gravity_diff_text(p_diff numeric, p_unit text) returns text
language sql immutable as $$
  select case when p_diff is null then null
              when p_unit = 'sg' then trim_scale(round(p_diff, 4)) || ' SG'
              else trim_scale(round(p_diff * 250, 1)) || case when p_unit = 'brix' then ' °Bx' else ' °P' end end;
$$;

create or replace function public.alert_conditions(p_brewery_id uuid)
returns table (kind text, subject text, title text, detail text)
language sql stable security definer set search_path = '' as $$
  with brewery as (
    select id, (now() at time zone time_zone)::date as today, acid_after_styles from public.breweries where id = p_brewery_id
  ),
  rule as (
    select k.kind, coalesce(r.enabled, true) as enabled, public.alert_params(k.kind, r.params) as params
      from unnest(array['no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock', 'short_for_brew', 'gravity_due',
                        'stalled', 'looks_finished', 'finished_off', 'ph']) k(kind)
      left join public.alert_rules r on r.brewery_id = p_brewery_id and r.kind = k.kind
  ),
  in_tank as (
    select s.*, be.name as beer, t.name as tank from public.batch_status s
      join public.beers be on be.id = s.beer_id join public.tanks t on t.id = s.tank_id
     where s.brewery_id = p_brewery_id and s.stage not in ('packaged', 'used')
  ),
  -- 1. No gravity logged lately (counting from the brew date if there's none yet)
  no_gravity as (
    select 'no_gravity', b.id::text, format('No gravity on %s #%s in %s days', b.beer, b.batch_number, (br.today - last.on_date)),
           format('%s, %s. Last gravity: %s.', b.tank, b.stage, coalesce(to_char(last.logged, 'Mon DD'), 'none yet'))
      from in_tank b cross join brewery br cross join rule r
      cross join lateral (select max(c.occurred_on) as logged, coalesce(max(c.occurred_on), b.brew_date, b.stage_started_on) as on_date
                            from public.cellar_entries c where c.batch_id = b.id and c.gravity_sg is not null) last
     where r.kind = 'no_gravity' and r.enabled and b.stage in (select jsonb_array_elements_text(r.params -> 'stages'))
       and br.today - last.on_date >= (r.params ->> 'days')::int
  ),
  -- 2. In a stage longer than its limit
  too_long as (
    select 'stage_too_long', b.id::text || ':' || b.stage, format('%s #%s: %s days in %s', b.beer, b.batch_number, br.today - b.stage_started_on, b.stage),
           format('%s. The limit for %s is %s days.', b.tank, b.stage, r.params -> 'days' ->> b.stage)
      from in_tank b cross join brewery br cross join rule r
     where r.kind = 'stage_too_long' and r.enabled and (r.params -> 'days' ->> b.stage) is not null
       and br.today - b.stage_started_on > (r.params -> 'days' ->> b.stage)::int
  ),
  -- 3. Acid due on an empty tank (the same rule as the tank board: batches that left since the last
  --    acid cycle, an acid-after style among them, or the tank's "every X turns" reached)
  moves as (
    select e.batch_id, e.tank_id, lead(e.tank_id) over w as next_tank, lead(e.effective_date) over w as next_date
      from public.batch_events e where e.brewery_id = p_brewery_id
    window w as (partition by e.batch_id order by e.effective_date, e.recorded_at)
  ),
  departures as (
    select m.tank_id, m.batch_id, max(m.next_date) as left_on from moves m
     where m.next_date is not null and m.next_tank is distinct from m.tank_id group by m.tank_id, m.batch_id
  ),
  acid as (
    select t.id, t.name, t.acid_every_turns,
           (select max(c.cleaned_on) from public.tank_cleanings c where c.tank_id = t.id and c.kind = 'acid') as last_acid
      from public.tanks t where t.brewery_id = p_brewery_id
       and not exists (select 1 from in_tank b where b.tank_id = t.id)
  ),
  acid_since as (
    select a.id, a.name, a.acid_every_turns, count(d.batch_id) as turns,
           min(be.style) filter (where lower(trim(be.style)) = any (select lower(x) from unnest((select acid_after_styles from brewery)) x)) as style
      from acid a left join departures d on d.tank_id = a.id and (a.last_acid is null or d.left_on > a.last_acid)
      left join public.batches bt on bt.id = d.batch_id left join public.beers be on be.id = bt.beer_id
     group by a.id, a.name, a.acid_every_turns
  ),
  acid_due as (
    select 'acid_due', s.id::text, format('Acid due on %s', s.name),
           case when s.style is not null then format('After %s.', s.style) else format('%s of %s turns since the last acid cycle.', s.turns, s.acid_every_turns) end
      from acid_since s cross join rule r
     where r.kind = 'acid_due' and r.enabled and (s.style is not null or (s.acid_every_turns is not null and s.turns >= s.acid_every_turns))
  ),
  -- 4. Under par (a place's par, or the brewery-wide par across every place)
  stock as (
    select h.place_id, h.beer_id, sum(h.count * pt.volume_bbl) as bbl, sum(h.count) filter (where pt.kind = 'case') as cases
      from public.stock_on_hand h join public.package_types pt on pt.id = h.package_type_id
     where h.brewery_id = p_brewery_id and h.count > 0 group by grouping sets ((h.place_id, h.beer_id), (h.beer_id))
  ),
  under_par as (
    select 'under_par', p.beer_id::text || ':' || coalesce(p.place_id::text, 'all'),
           format('%s under par%s', be.name, coalesce(' at ' || coalesce(pll.name || ' · ', '') || pl.name, '')),
           concat_ws(' · ', case when p.par_bbl is not null then format('%s of %s bbl', trim_scale(round(coalesce(s.bbl, 0), 2)), trim_scale(round(p.par_bbl, 2))) end,
                            case when p.par_cases is not null then format('%s of %s cases', coalesce(s.cases, 0), p.par_cases) end)
      from public.stock_pars p join public.beers be on be.id = p.beer_id
      left join public.stock_places pl on pl.id = p.place_id
      left join public.locations pll on pll.id = pl.location_id
      left join stock s on s.beer_id = p.beer_id and s.place_id is not distinct from p.place_id
      cross join rule r
     where p.brewery_id = p_brewery_id and r.kind = 'under_par' and r.enabled
       and (coalesce(s.bbl, 0) < p.par_bbl - 0.000001 or coalesce(s.cases, 0) < p.par_cases - 0.000001)
  ),
  -- 5. A raw material below its reorder level (received - used on batches + counts)
  on_hand as (
    select i.id, i.name, i.unit, i.reorder_level, i.pack_size, i.pack_name,
           coalesce((select sum(amount) from public.raw_receipts x where x.item_id = i.id), 0)
         + coalesce((select sum(change) from public.raw_adjustments x where x.item_id = i.id), 0)
         - coalesce((select sum(public.convert_amount(a.amount, a.unit, i.unit)) from public.batch_additions a
                      where a.brewery_id = p_brewery_id and lower(trim(a.name)) = lower(trim(i.name))), 0) as amount
      from public.raw_items i where i.brewery_id = p_brewery_id and i.active and i.reorder_level is not null
  ),
  low_stock as (
    select 'low_stock', o.id::text, format('Low on %s', o.name),
           format('%s %s left; reorder below %s %s.', trim_scale(round(o.amount, 2)), o.unit, trim_scale(round(o.reorder_level, 2)), o.unit)
      from on_hand o cross join rule r
     where r.kind = 'low_stock' and r.enabled and o.amount < o.reorder_level
  )
  ,
  -- 6. Short of a raw material for a brew planned soon (see plan_shortfalls), unless dismissed
  short_for_brew as (
    select 'short_for_brew', s.plan_id::text || ':' || s.item_id::text,
           format('Short of %s for %s on %s', s.item_name, s.beer_name, to_char(s.planned_on, 'Mon DD')),
           format('Needs %s %s; there''ll be %s %s by then: %s %s short.', round(s.needed, 2), s.unit,
                  round(greatest(s.available, 0), 2), s.unit, round(s.short, 2), s.unit)
      from public.plan_shortfalls(p_brewery_id) s cross join rule r
     where r.kind = 'short_for_brew' and r.enabled and not s.dismissed and s.in_window
  )
  ,
  -- 7. A batch's gravity reached a step in its beer's schedule ("dry hop at 4 °P"): see gravity_due
  gravity_due as (
    select 'gravity_due', g.batch_id::text || ':' || g.kind, format('%s: %s due', g.tank_name, g.kind_label),
           format('%s #%s is at %s (the schedule says %s at %s).', g.beer_name, g.batch_number,
                  public.gravity_text(g.latest_sg, g.unit), lower(g.kind_label), public.gravity_text(g.trigger_sg, g.unit))
      from public.gravity_due(p_brewery_id) g cross join rule r
     where r.kind = 'gravity_due' and r.enabled
  )
  ,
  -- 8. Fermentation, from the batch's own gravity readings (fermenting, dry hopping, or conditioning in a tank).
  --    For each: the latest reading, and the latest one at least N days before it.
  readings as (
    select b.id, b.beer, b.batch_number, b.tank, b.stage, b.brew_date, be.target_fg, be.style, br.gravity_unit as unit, br_t.today,
           last.sg as last_sg, last.on_date as last_on
      from in_tank b join public.beers be on be.id = b.beer_id join public.breweries br on br.id = p_brewery_id
      cross join brewery br_t
      cross join lateral (select c.gravity_sg as sg, c.occurred_on as on_date from public.cellar_entries c
                           where c.batch_id = b.id and c.gravity_sg is not null order by c.occurred_on desc, c.recorded_at desc limit 1) last
     where b.stage in ('fermenting', 'dry-hopping', 'conditioning')
  ),
  -- Stalled: dropped less than this over these days, while still well above the target FG
  stalled as (
    select 'stalled' as kind, g.id::text as subject, format('%s #%s looks stalled at %s', g.beer, g.batch_number, public.gravity_text(g.last_sg, g.unit)),
           format('%s: down %s in %s days; target FG %s.', g.tank, public.gravity_diff_text(ref.sg - g.last_sg, g.unit),
                  g.last_on - ref.on_date, public.gravity_text(g.target_fg, g.unit))
      from readings g cross join rule r
      cross join lateral (select c.gravity_sg as sg, c.occurred_on as on_date from public.cellar_entries c
                           where c.batch_id = g.id and c.gravity_sg is not null and c.occurred_on <= g.last_on - (r.params ->> 'days')::int
                           order by c.occurred_on desc, c.recorded_at desc limit 1) ref
     where r.kind = 'stalled' and r.enabled and g.stage in ('fermenting', 'dry-hopping') and g.target_fg is not null
       and g.last_sg > g.target_fg + (r.params ->> 'above_fg')::numeric
       and ref.sg - g.last_sg < (r.params ->> 'drop')::numeric
  ),
  -- Steady: the latest reading within this of the latest one at least this many days before it
  steady as (
    select g.*, ref.sg as ref_sg, ref.on_date as ref_on
      from readings g cross join rule r
      cross join lateral (select c.gravity_sg as sg, c.occurred_on as on_date from public.cellar_entries c
                           where c.batch_id = g.id and c.gravity_sg is not null and c.occurred_on <= g.last_on - (r.params ->> 'days')::int
                           order by c.occurred_on desc, c.recorded_at desc limit 1) ref
     where r.kind = 'looks_finished' and abs(ref.sg - g.last_sg) <= (r.params ->> 'within')::numeric
  ),
  -- Looks finished (a nudge): steady, at (or near) its target FG, and still fermenting or dry hopping
  looks_finished as (
    select 'looks_finished', s.id::text, format('%s #%s looks finished at %s', s.beer, s.batch_number, public.gravity_text(s.last_sg, s.unit)),
           format('%s: steady since %s (target FG %s). Time to crash or dry hop?', s.tank, to_char(s.ref_on, 'Mon DD'),
                  coalesce(public.gravity_text(s.target_fg, s.unit), 'not set'))
      from steady s cross join rule r cross join rule off
     where r.kind = 'looks_finished' and r.enabled and off.kind = 'finished_off' and s.stage in ('fermenting', 'dry-hopping')
       and (s.target_fg is null or abs(s.last_sg - s.target_fg) <= (off.params ->> 'off')::numeric)
  ),
  -- Finished high or low: steady, but this far from the target FG. "High" only once it's out of fermenting
  -- (still fermenting, steady and high is a stall, and "stalled" says so); "low" at any stage.
  finished_off as (
    select 'finished_off', s.id::text, format('%s #%s finished %s: %s', s.beer, s.batch_number,
             case when s.last_sg > s.target_fg then 'high' else 'low' end, public.gravity_text(s.last_sg, s.unit)),
           format('%s: steady at %s, target FG %s. %s', s.tank, public.gravity_text(s.last_sg, s.unit), public.gravity_text(s.target_fg, s.unit),
             case when s.last_sg > s.target_fg then 'It may be stuck (yeast, temperature, or the mash).'
                  else 'Fermented further than expected: worth checking for a wild yeast or diastaticus before packaging.' end)
      from steady s cross join rule r
     where r.kind = 'finished_off' and r.enabled and s.target_fg is not null
       and abs(s.last_sg - s.target_fg) > (r.params ->> 'off')::numeric
       and (s.last_sg < s.target_fg or s.stage <> 'fermenting')
       and not exists (select 1 from stalled x where x.subject = s.id::text)
  ),
  -- pH: a slow start (still above this after these days) or a rise after it dropped (a common sign of
  -- infection). Sour styles are left out (their names, in the rule).
  ph_readings as (
    select b.id, b.beer, b.batch_number, b.tank, b.brew_date, br.today,
           (select c.ph from public.cellar_entries c where c.batch_id = b.id and c.ph is not null order by c.occurred_on desc, c.recorded_at desc limit 1) as last_ph,
           (select min(c.ph) from public.cellar_entries c where c.batch_id = b.id and c.ph is not null) as low_ph
      from in_tank b join public.beers be on be.id = b.beer_id cross join brewery br cross join rule r
     where r.kind = 'ph' and b.stage in ('fermenting', 'dry-hopping', 'conditioning')
       and not exists (select 1 from jsonb_array_elements_text(r.params -> 'skip_styles') x
                        where trim(x) <> '' and lower(coalesce(be.style, '') || ' ' || be.name) like '%' || lower(trim(x)) || '%')
  ),
  ph as (
    select 'ph', p.id::text || ':slow', format('%s #%s: pH still %s after %s days', p.beer, p.batch_number, p.last_ph, p.today - p.brew_date),
           format('%s. pH usually drops below %s in the first days of fermentation; a slow drop can mean a slow start.', p.tank, r.params ->> 'max_after')
      from ph_readings p cross join rule r
     where r.kind = 'ph' and r.enabled and p.last_ph is not null and p.today - p.brew_date >= (r.params ->> 'days')::int
       and p.last_ph > (r.params ->> 'max_after')::numeric
    union all
    select 'ph', p.id::text || ':rising', format('%s #%s: pH rising (%s, from %s)', p.beer, p.batch_number, p.last_ph, p.low_ph),
           format('%s. pH went back up after it dropped, a common early sign of an infection.', p.tank)
      from ph_readings p cross join rule r
     where r.kind = 'ph' and r.enabled and p.last_ph - p.low_ph > (r.params ->> 'rise')::numeric
  )
  select * from no_gravity union all select * from too_long union all select * from acid_due
  union all select * from under_par union all select * from low_stock union all select * from short_for_brew
  union all select * from gravity_due union all select * from stalled union all select * from looks_finished
  union all select * from finished_off union all select * from ph;
$$;
