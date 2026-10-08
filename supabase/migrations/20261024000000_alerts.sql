-- Alerts (Phase 6¾, step 1: from the records the brewery already keeps; no sensors needed).
--
-- Each kind of alert has a rule per brewery: on or off, its thresholds, and WHO gets emailed
-- (specific people; push notifications once there's an app). A check (every 15 minutes, by the
-- server; see supabase/functions/alerts) works out every condition that's true right now, opens
-- an alert for each new one, and clears alerts whose condition has gone away (gravity logged,
-- the tank cleaned). Each alert is emailed once. "I've got it" acknowledges one in the app.
create table public.alert_rules (
  brewery_id  uuid not null references public.breweries on delete cascade,
  kind        text not null check (kind in ('no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock')),
  enabled     boolean not null default true,
  params      jsonb not null default '{}',
  recipients  uuid[] not null default '{}',     -- the people who get this alert by email
  primary key (brewery_id, kind)
);
alter table public.alert_rules enable row level security;
create policy "members read" on public.alert_rules for select to authenticated using (public.is_member(brewery_id));
create policy "change rules" on public.alert_rules for all to authenticated
  using (public.has_permission(brewery_id, 'manage_settings')) with check (public.has_permission(brewery_id, 'manage_settings'));

-- Quiet hours (in the brewery's time zone): emails wait until they're over. Empty = none.
alter table public.breweries
  add column alert_quiet_start integer check (alert_quiet_start between 0 and 23),
  add column alert_quiet_end   integer check (alert_quiet_end between 0 and 23);

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
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;

create table public.alerts (
  id               uuid primary key default gen_random_uuid(),
  brewery_id       uuid not null references public.breweries on delete cascade,
  kind             text not null,
  subject          text not null,                 -- what it's about (a batch, a tank, a beer at a place, an item)
  title            text not null,
  detail           text not null default '',
  opened_at        timestamptz not null default now(),
  resolved_at      timestamptz,                   -- the condition went away
  acknowledged_at  timestamptz,                   -- someone said "I've got it"
  acknowledged_by  uuid references auth.users on delete set null,
  notified_at      timestamptz                    -- emailed (or nobody to email)
);
create unique index alerts_one_open on public.alerts (brewery_id, kind, subject) where resolved_at is null;
alter table public.alerts enable row level security;
create policy "members read" on public.alerts for select to authenticated using (public.is_member(brewery_id));

-- Rule settings with defaults filled in
create function public.alert_params(p_kind text, p_params jsonb) returns jsonb
language sql immutable as $$
  select (case p_kind
    when 'no_gravity'     then '{"days": 3, "stages": ["fermenting", "dry-hopping"]}'
    when 'stage_too_long' then '{"days": {"fermenting": 21, "dry-hopping": 7, "conditioning": 28, "carbonating": 7, "ready": 30}}'
    when 'low_stock'      then '{}'
    else '{}' end)::jsonb || coalesce(p_params, '{}');
$$;

-- An amount in another unit (lb, kg, oz, g; gal, l, ml); null if they don't mix
create function public.convert_amount(p_amount numeric, p_from text, p_to text) returns numeric
language sql immutable as $$
  with f(unit, lb, gal) as (values ('lb', 1, null), ('kg', 2.20462, null), ('oz', 1.0 / 16, null), ('g', 0.00220462, null),
                                   ('gal', null, 1), ('l', null, 0.264172), ('ml', null, 0.000264172), ('each', null, null))
  select case when p_from = p_to then p_amount
              when a.lb is not null and b.lb is not null then p_amount * a.lb / b.lb
              when a.gal is not null and b.gal is not null then p_amount * a.gal / b.gal end
    from f a, f b where a.unit = p_from and b.unit = p_to;
$$;

-- Everything that deserves an alert right now, for one brewery: (kind, subject, title, detail)
create function public.alert_conditions(p_brewery_id uuid)
returns table (kind text, subject text, title text, detail text)
language sql stable security definer set search_path = '' as $$
  with brewery as (
    select id, (now() at time zone time_zone)::date as today, acid_after_styles from public.breweries where id = p_brewery_id
  ),
  rule as (
    select k.kind, coalesce(r.enabled, true) as enabled, public.alert_params(k.kind, r.params) as params
      from unnest(array['no_gravity', 'stage_too_long', 'acid_due', 'under_par', 'low_stock']) k(kind)
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
  select * from no_gravity union all select * from too_long union all select * from acid_due
  union all select * from under_par union all select * from low_stock;
$$;
revoke execute on function public.alert_conditions(uuid) from public, anon, authenticated;

-- Bring the alerts up to date: open new ones, clear the ones that have gone away. For one brewery
-- (anyone in it may ask, e.g. when the app opens) or, with no brewery, all of them (the server's
-- regular check).
create function public.check_alerts(p_brewery_id uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
  opened integer := 0;
  n integer;
begin
  if p_brewery_id is null and auth.uid() is not null then
    raise exception using errcode = '42501', message = 'Only the server checks every brewery.';
  end if;
  if p_brewery_id is not null and auth.uid() is not null and not public.is_member(p_brewery_id) then
    raise exception using errcode = '42501', message = 'You''re not part of that brewery.';
  end if;
  for b in select id from public.breweries where p_brewery_id is null or id = p_brewery_id loop
    create temp table if not exists now_true (kind text, subject text, title text, detail text) on commit drop;
    delete from now_true where true; -- ("where true": the API refuses a delete with no WHERE)
    insert into now_true select * from public.alert_conditions(b);
    -- New: open them (one open alert per thing)
    insert into public.alerts (brewery_id, kind, subject, title, detail)
    select b, c.kind, c.subject, c.title, c.detail from now_true c
    on conflict (brewery_id, kind, subject) where resolved_at is null do nothing;
    get diagnostics n = row_count;
    opened := opened + n;
    -- Still true: keep the wording current (days count up)
    update public.alerts a set title = c.title, detail = c.detail
      from now_true c where a.brewery_id = b and a.resolved_at is null and a.kind = c.kind and a.subject = c.subject
       and (a.title, a.detail) is distinct from (c.title, c.detail);
    -- Gone away: cleared
    update public.alerts a set resolved_at = now()
     where a.brewery_id = b and a.resolved_at is null
       and not exists (select 1 from now_true c where c.kind = a.kind and c.subject = a.subject);
  end loop;
  return opened;
end;
$$;
revoke execute on function public.check_alerts(uuid) from public, anon;
grant execute on function public.check_alerts(uuid) to authenticated;

-- "I've got it"
create function public.acknowledge_alert(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.alerts set acknowledged_at = now(), acknowledged_by = auth.uid()
   where id = p_id and public.is_member(brewery_id) and acknowledged_at is null;
end;
$$;
revoke execute on function public.acknowledge_alert(uuid) from public, anon;
grant execute on function public.acknowledge_alert(uuid) to authenticated;
