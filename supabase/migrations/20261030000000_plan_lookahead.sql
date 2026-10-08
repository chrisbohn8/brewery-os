-- Planning calendar, step 3 (docs/calendar-design.md): will there be enough malt and hops?
--
-- What a planned brew needs is its beer's recipe (written for one turn, times the location's turns;
-- or for the whole batch, a brewery setting), or, with no recipe, what the last batch of the beer used.
-- Going through the planned brews in date order: on hand now, plus deliveries on order that arrive
-- by then, minus every earlier brew's needs. A brew that comes up short shows on the calendar and,
-- for brews within the look-ahead window (or an item's lead time), as an alert. Plain arithmetic
-- that can be checked by hand; recipe ingredients match raw materials by name, never by guessing.

alter table public.breweries
  add column plan_lookahead_days integer not null default 14 check (plan_lookahead_days between 1 and 90),
  add column recipes_per text not null default 'turn' check (recipes_per in ('turn', 'batch'));
alter table public.raw_items
  add column lead_days integer check (lead_days between 0 and 180);   -- how long an order takes to arrive

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
  if (new.plan_lookahead_days, new.recipes_per) is distinct from (old.plan_lookahead_days, old.recipes_per) then
    perform public.require_permission(old.id, 'plan_schedule', 'change how the calendar looks ahead');
  end if;
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;

-- ---------- Deliveries on order ----------
create table public.raw_orders (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  item_id      uuid not null,
  amount       numeric not null check (amount > 0),            -- in the item's unit
  expected_on  date not null,
  supplier     text not null default '' check (length(supplier) <= 120),
  notes        text not null default '' check (length(notes) <= 500),
  received_at  timestamptz,                                    -- arrived (and received as a delivery)
  created_by   uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (brewery_id, item_id) references public.raw_items (brewery_id, id) on delete cascade
);
alter table public.raw_orders enable row level security;
create policy "members read" on public.raw_orders for select to authenticated using (public.is_member(brewery_id));
create policy "orders" on public.raw_orders for all to authenticated
  using (public.has_permission(brewery_id, 'inventory')) with check (public.has_permission(brewery_id, 'inventory'));

-- ---------- Shortfalls someone has dealt with ----------
-- "Borrowing 2 sacks from next door": stops the alert, until the shortfall gets bigger than this
create table public.shortfall_dismissals (
  brewery_id    uuid not null references public.breweries on delete cascade,
  plan_id       uuid not null references public.plan_items on delete cascade,
  item_id       uuid not null,
  short_amount  numeric not null,
  note          text not null default '' check (length(note) <= 300),
  dismissed_by  uuid default auth.uid() references auth.users on delete set null,
  dismissed_at  timestamptz not null default now(),
  primary key (plan_id, item_id),
  foreign key (brewery_id, item_id) references public.raw_items (brewery_id, id) on delete cascade
);
alter table public.shortfall_dismissals enable row level security;
create policy "members read" on public.shortfall_dismissals for select to authenticated using (public.is_member(brewery_id));
create policy "dismiss" on public.shortfall_dismissals for all to authenticated
  using (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule') or public.has_permission(brewery_id, 'inventory'))
  with check (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule') or public.has_permission(brewery_id, 'inventory'));

-- ---------- The arithmetic ----------
-- Every planned brew (not yet brewed or done, today or later) and each raw material it needs.
-- needed/available/short in the item's unit; available = what there'll be when that brew starts.
create function public.plan_needs(p_brewery_id uuid)
returns table (plan_id uuid, planned_on date, beer_id uuid, beer_name text, ingredient text, item_id uuid, needed numeric, unit text)
language sql stable security definer set search_path = '' as $$
  with brewery as (
    select (now() at time zone time_zone)::date as today, recipes_per from public.breweries
     where id = p_brewery_id and (auth.uid() is null or public.is_member(p_brewery_id))  -- (no one outside the brewery)
  ),
  brews as (
    select p.id, p.planned_on, p.created_at, p.beer_id, p.tank_id, be.name as beer_name,
           coalesce(l.usual_turns, 1) as turns, t.location_id
      from public.plan_items p join public.beers be on be.id = p.beer_id
      left join public.tanks t on t.id = p.tank_id left join public.locations l on l.id = t.location_id
      cross join brewery br
     where p.brewery_id = p_brewery_id and p.kind = 'brew' and p.planned_on >= br.today and p.done_at is null
       -- brewed already (a batch of the beer started in that tank within a few days): its use is on the batch
       and not exists (select 1 from public.batch_status s where s.beer_id = p.beer_id and s.brew_date between p.planned_on - 3 and p.planned_on + 3
                          and (p.tank_id is null or s.tank_id = p.tank_id
                               or exists (select 1 from public.batch_events e where e.batch_id = s.id and e.tank_id = p.tank_id)))
  ),
  -- The beer's recipe: the one for the tank's location, else one for any location; the newest
  recipe as (
    select distinct on (b.id) b.id as plan_id, r.id as recipe_id
      from brews b join public.recipes r on r.beer_id = b.beer_id
     where r.location_id is null or r.location_id = b.location_id
     order by b.id, (r.location_id is not null) desc, r.created_at desc
  ),
  from_recipe as (
    select b.id as plan_id, i.name, i.amount * case when (select recipes_per from brewery) = 'turn' then b.turns else 1 end as amount, i.unit
      from brews b join recipe rc on rc.plan_id = b.id join public.recipe_ingredients i on i.recipe_id = rc.recipe_id
     where i.amount is not null
  ),
  -- No recipe: what the last batch of the beer used (its ingredients and additions)
  last_batch as (
    select distinct on (b.id) b.id as plan_id, x.id as batch_id
      from brews b join public.batches x on x.beer_id = b.beer_id
     where not exists (select 1 from recipe rc where rc.plan_id = b.id)
       and exists (select 1 from public.batch_additions a where a.batch_id = x.id)
     order by b.id, x.brew_date desc nulls last, x.created_at desc
  ),
  from_batch as (
    select lb.plan_id, a.name, a.amount, a.unit
      from last_batch lb join public.batch_additions a on a.batch_id = lb.batch_id where a.amount is not null
  ),
  needs as (select * from from_recipe union all select * from from_batch)
  select b.id, b.planned_on, b.beer_id, b.beer_name, n.name, i.id,
         sum(public.convert_amount(n.amount, lower(n.unit), i.unit)), coalesce(i.unit, lower(min(n.unit)))
    from needs n join brews b on b.id = n.plan_id
    left join public.raw_items i on i.brewery_id = p_brewery_id and i.active and lower(trim(i.name)) = lower(trim(n.name))
   group by b.id, b.planned_on, b.created_at, b.beer_id, b.beer_name, n.name, i.id, i.unit
   order by b.planned_on, b.created_at;
$$;

create function public.plan_shortfalls(p_brewery_id uuid)
returns table (plan_id uuid, planned_on date, beer_name text, item_id uuid, item_name text, unit text,
               needed numeric, available numeric, short numeric, pack_size numeric, pack_name text,
               lead_days integer, in_window boolean, dismissed boolean, dismissed_note text)
language sql stable security definer set search_path = '' as $$
  with brewery as (
    select (now() at time zone time_zone)::date as today, plan_lookahead_days as days from public.breweries
     where id = p_brewery_id and (auth.uid() is null or public.is_member(p_brewery_id))  -- (no one outside the brewery)
  ),
  need as (
    select n.plan_id, n.planned_on, n.beer_name, n.item_id, sum(n.needed) as needed
      from public.plan_needs(p_brewery_id) n where n.item_id is not null and n.needed is not null
     group by n.plan_id, n.planned_on, n.beer_name, n.item_id
  ),
  on_hand as (
    select i.id, i.name, i.unit, i.pack_size, i.pack_name, i.lead_days,
           coalesce((select sum(amount) from public.raw_receipts x where x.item_id = i.id), 0)
         + coalesce((select sum(change) from public.raw_adjustments x where x.item_id = i.id), 0)
         - coalesce((select sum(public.convert_amount(a.amount, lower(a.unit), i.unit)) from public.batch_additions a
                      where a.brewery_id = p_brewery_id and lower(trim(a.name)) = lower(trim(i.name))), 0) as amount
      from public.raw_items i where i.brewery_id = p_brewery_id
  ),
  running as (
    select n.*, o.name as item_name, o.unit, o.pack_size, o.pack_name, o.lead_days,
           o.amount + coalesce((select sum(r.amount) from public.raw_orders r
                                 where r.item_id = n.item_id and r.received_at is null and r.expected_on <= n.planned_on), 0) as supply,
           sum(n.needed) over (partition by n.item_id order by n.planned_on, n.plan_id rows unbounded preceding) as used_by_then
      from need n join on_hand o on o.id = n.item_id
  )
  select r.plan_id, r.planned_on, r.beer_name, r.item_id, r.item_name, r.unit, r.needed,
         r.supply - (r.used_by_then - r.needed) as available,
         least(r.needed, r.used_by_then - r.supply) as short,
         r.pack_size, r.pack_name, r.lead_days,
         r.planned_on <= br.today + greatest(br.days, coalesce(r.lead_days, 0)) as in_window,
         coalesce(d.short_amount >= least(r.needed, r.used_by_then - r.supply) - 0.000001, false) as dismissed,
         coalesce(d.note, '') as dismissed_note
    from running r cross join brewery br
    left join public.shortfall_dismissals d on d.plan_id = r.plan_id and d.item_id = r.item_id
   where r.used_by_then - r.supply > 0.000001
   order by r.planned_on, r.item_name;
$$;
-- Anyone in the brewery may see them (the app shows them on the calendar); nobody outside it
revoke execute on function public.plan_needs(uuid) from public, anon;
revoke execute on function public.plan_shortfalls(uuid) from public, anon;
grant execute on function public.plan_needs(uuid) to authenticated;
grant execute on function public.plan_shortfalls(uuid) to authenticated;

-- ---------- The alert ----------
alter table public.alert_rules drop constraint alert_rules_kind_check;
alter table public.alert_rules add constraint alert_rules_kind_check
  check (kind in ('no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock', 'short_for_brew'));

create or replace function public.alert_params(p_kind text, p_params jsonb) returns jsonb
language sql immutable as $$
  select (case p_kind
    when 'no_gravity'     then '{"days": 3, "stages": ["fermenting", "dry-hopping"]}'
    when 'stage_too_long' then '{"days": {"fermenting": 21, "dry-hopping": 7, "conditioning": 28, "carbonating": 7, "ready": 30}}'
    when 'low_stock'      then '{}'
    when 'short_for_brew' then '{}'
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
      from unnest(array['no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock', 'short_for_brew']) k(kind)
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
  select * from no_gravity union all select * from too_long union all select * from acid_due
  union all select * from under_par union all select * from low_stock union all select * from short_for_brew;
$$;
revoke execute on function public.alert_conditions(uuid) from public, anon, authenticated;

-- Backups bring deliveries on order back too (dismissals belong to one moment's plan, so they aren't backed up)
create or replace function public.backup_tables() returns text[]
language sql immutable as $$
  select array[
    'locations', 'beers', 'tanks', 'tank_cleanings', 'batches', 'batch_events', 'beer_movements',
    'stock_places', 'package_types', 'package_counts', 'raw_items', 'raw_receipts', 'raw_adjustments',
    'recipes', 'recipe_ingredients', 'inventory_views', 'draft_lines', 'stock_pars', 'stock_moves',
    'cellar_entries', 'batch_additions', 'batch_readings', 'breweries', 'plan_items', 'beer_schedules',
    'plan_shifts', 'raw_orders', 'shortfall_dismissals'];
$$;
