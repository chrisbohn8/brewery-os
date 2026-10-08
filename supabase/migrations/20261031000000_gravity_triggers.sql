-- Planning calendar, step 4 (docs/calendar-design.md): gravity triggers.
--
-- A step in a beer's schedule can also say a gravity ("dry hop at 4 °P", "crash at 2.5 °P"), kept in
-- SG like every gravity: {"kind": "dry_hop", "day": 5, "gravity": 1.016}. It stays on its expected
-- day on the calendar; when a logged reading reaches it, the step is DUE NOW, on the calendar and as
-- an alert. Always a reading someone logged, never a forecast. A brewery chooses whether one reading
-- is enough or it takes two in a row (so one odd reading doesn't set it off).
--
-- Only for steps the records can tell are done (dry hop, crash, carbonate, transfer, package), so
-- "due" goes away by itself once it's done: the same rules as the calendar's late steps.

alter table public.breweries
  add column gravity_trigger_readings integer not null default 1 check (gravity_trigger_readings in (1, 2));

create or replace function public.check_brewery_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.name is distinct from old.name then
    perform public.require_permission(old.id, 'rename_brewery', 'rename the brewery');
  end if;
  if (new.temperature_unit, new.gravity_unit, new.volume_unit, new.time_zone, new.target_limits)
     is distinct from (old.temperature_unit, old.gravity_unit, old.volume_unit, old.time_zone, old.target_limits) then
    perform public.require_permission(old.id, 'manage_settings', 'change units, the time zone, or target limits');
  end if;
  if (new.sheet_fields, new.sheet_custom_fields, new.sheet_field_settings)
     is distinct from (old.sheet_fields, old.sheet_custom_fields, old.sheet_field_settings) then
    perform public.require_permission(old.id, 'manage_settings', 'choose the brew sheet''s fields');
  end if;
  if (new.stock_reasons, new.require_stock_reason) is distinct from (old.stock_reasons, old.require_stock_reason) then
    perform public.require_permission(old.id, 'manage_settings', 'change the reasons for stock changes');
  end if;
  if (new.alert_quiet_start, new.alert_quiet_end) is distinct from (old.alert_quiet_start, old.alert_quiet_end) then
    perform public.require_permission(old.id, 'manage_settings', 'change alert settings');
  end if;
  if (new.plan_lookahead_days, new.recipes_per, new.gravity_trigger_readings)
     is distinct from (old.plan_lookahead_days, old.recipes_per, old.gravity_trigger_readings) then
    perform public.require_permission(old.id, 'plan_schedule', 'change how the calendar looks ahead');
  end if;
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;

-- A gravity in the brewery's unit, for messages: "3.9 °P", "1.016 SG" (the app's own conversion)
create function public.gravity_text(p_sg numeric, p_unit text) returns text
language sql immutable as $$
  select case when p_unit = 'sg' then to_char(p_sg, 'FM0.000') || ' SG'
              else to_char(-616.868 + 1111.14 * p_sg - 630.272 * p_sg ^ 2 + 135.997 * p_sg ^ 3, 'FM990.0')
                   || case when p_unit = 'brix' then ' °Bx' else ' °P' end end;
$$;

-- Batches in tanks whose latest gravity (or two latest, by the brewery's setting) reached a step in
-- their beer's schedule that isn't done yet
create function public.gravity_due(p_brewery_id uuid)
returns table (batch_id uuid, beer_name text, batch_number text, tank_name text, kind text, kind_label text,
               trigger_sg numeric, latest_sg numeric, unit text)
language sql stable security definer set search_path = '' as $$
  with brewery as (
    select gravity_trigger_readings as readings, gravity_unit as unit from public.breweries
     where id = p_brewery_id and (auth.uid() is null or public.is_member(p_brewery_id))
  ),
  steps as (
    select s.id as batch_id, s.stage, be.name as beer_name, s.batch_number, t.name as tank_name,
           st ->> 'kind' as kind, (st ->> 'gravity')::numeric as trigger_sg
      from public.batch_status s
      join public.beers be on be.id = s.beer_id join public.tanks t on t.id = s.tank_id
      join public.beer_schedules sc on sc.beer_id = s.beer_id
      cross join lateral jsonb_array_elements(sc.steps) st
     where s.brewery_id = p_brewery_id and s.stage not in ('packaged', 'used')
       and st ->> 'gravity' is not null and st ->> 'kind' in ('dry_hop', 'crash', 'carbonate', 'transfer', 'package')
  ),
  not_done as (
    select * from steps x where not case x.kind
      when 'dry_hop' then x.stage in ('dry-hopping', 'conditioning', 'carbonating', 'ready')
                          or exists (select 1 from public.batch_additions a where a.batch_id = x.batch_id and a.timing ilike 'dry hop%')
      when 'crash' then x.stage in ('conditioning', 'carbonating', 'ready')
      when 'carbonate' then x.stage in ('carbonating', 'ready')
      when 'transfer' then (select count(distinct e.tank_id) from public.batch_events e where e.batch_id = x.batch_id and e.tank_id is not null) > 1
      else false end
  ),
  latest as (
    select n.*, r.readings_needed, r.got, r.highest, r.newest
      from not_done n cross join lateral (
        select (select readings from brewery) as readings_needed, count(*) as got, max(g.gravity_sg) as highest,
               (array_agg(g.gravity_sg order by g.occurred_on desc, g.recorded_at desc))[1] as newest
          from (select c.gravity_sg, c.occurred_on, c.recorded_at from public.cellar_entries c
                 where c.batch_id = n.batch_id and c.gravity_sg is not null
                 order by c.occurred_on desc, c.recorded_at desc limit (select readings from brewery)) g) r
  )
  select l.batch_id, l.beer_name, l.batch_number, l.tank_name, l.kind,
         case l.kind when 'dry_hop' then 'Dry hop' when 'crash' then 'Crash' when 'carbonate' then 'Carbonate'
                     when 'transfer' then 'Transfer' else 'Package' end,
         l.trigger_sg, l.newest, (select unit from brewery)
    from latest l
   where l.got >= l.readings_needed and l.highest <= l.trigger_sg + 0.0000001;
$$;
revoke execute on function public.gravity_due(uuid) from public, anon;
grant execute on function public.gravity_due(uuid) to authenticated;

-- ---------- The alert ----------
alter table public.alert_rules drop constraint alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock', 'short_for_brew', 'gravity_due'));

create or replace function public.alert_params(p_kind text, p_params jsonb) returns jsonb
language sql immutable as $$
  select (case p_kind
    when 'no_gravity'     then '{"days": 3, "stages": ["fermenting", "dry-hopping"]}'
    when 'stage_too_long' then '{"days": {"fermenting": 21, "dry-hopping": 7, "conditioning": 28, "carbonating": 7, "ready": 30}}'
    when 'low_stock'      then '{}'
    when 'short_for_brew' then '{}'
    when 'gravity_due'    then '{}'
    else '{}' end)::jsonb || coalesce(p_params, '{}');
$$;

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
           format('%s under par%s', be.name, coalesce(' at ' || pl.name, '')),
           concat_ws(' · ', case when p.par_bbl is not null then format('%s of %s bbl', round(coalesce(s.bbl, 0), 2), round(p.par_bbl, 2)) end,
                            case when p.par_cases is not null then format('%s of %s cases', coalesce(s.cases, 0), p.par_cases) end)
      from public.stock_pars p join public.beers be on be.id = p.beer_id
      left join public.stock_places pl on pl.id = p.place_id
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
           format('%s %s left; reorder below %s %s.', round(o.amount, 2), o.unit, round(o.reorder_level, 2), o.unit)
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
revoke execute on function public.alert_conditions(uuid) from public, anon, authenticated;
