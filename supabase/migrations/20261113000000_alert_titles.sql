-- Clearer alert titles (found while building the demo tour):
--   - "under par at Taproom" didn't say which location when two places share a name; now it's
--     "under par at Riverside · Taproom", the way Inventory names places
--   - numbers lose pointless zeros: "226 lb left", not "226.00 lb left"
-- (The function is otherwise the same as in ..._gravity_triggers.sql.)

create or replace function public.alert_conditions(p_brewery_id uuid)
returns table (kind text, subject text, title text, detail text)
language sql stable security definer set search_path = '' as $$
  with brewery as (
    select id, (now() at time zone time_zone)::date as today, acid_after_styles from public.breweries where id = p_brewery_id
  ),
  rule as (
    select k.kind, coalesce(r.enabled, true) as enabled, public.alert_params(k.kind, r.params) as params
      from unnest(array['no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock', 'short_for_brew', 'gravity_due']) k(kind)
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
  select * from no_gravity union all select * from too_long union all select * from acid_due
  union all select * from under_par union all select * from low_stock union all select * from short_for_brew
  union all select * from gravity_due;
$$;
