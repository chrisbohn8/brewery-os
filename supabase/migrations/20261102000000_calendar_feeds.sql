-- Planning calendar, step 5 (part): the calendar in Google or Apple Calendar.
--
-- Each person can make a private calendar link (all of the plan, or only what they're on) and
-- subscribe to it in their phone's calendar. It's read-only and one-way. Like an API key, the link
-- holds a secret that's shown once; only a scrambled copy (SHA-256) is stored. It stops working
-- when it's turned off, or when its owner is no longer in the brewery.
--
-- The calendar app fetches the link on its own (no sign-in), through supabase/functions/calendar,
-- which asks calendar_feed() below for the items; nothing else can call that.

-- ---------- Has a batch done a step of its schedule? (one rule, for the calendar and the alerts) ----------
-- Told from its records: dry hopped (the stage, or a dry hop addition), crashed (conditioning or
-- later), carbonating, moved out of its first tank, packaged. Null where the records can't tell.
-- (The app's stepReached() follows the same rules.)
create function public.step_done(p_batch_id uuid, p_stage text, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select case p_kind
    when 'dry_hop' then p_stage in ('dry-hopping', 'conditioning', 'carbonating', 'ready', 'packaged', 'used')
                        or exists (select 1 from public.batch_additions a where a.batch_id = p_batch_id and a.timing ilike 'dry hop%')
    when 'crash' then p_stage in ('conditioning', 'carbonating', 'ready', 'packaged', 'used')
    when 'carbonate' then p_stage in ('carbonating', 'ready', 'packaged', 'used')
    when 'transfer' then (select count(distinct e.tank_id) from public.batch_events e where e.batch_id = p_batch_id and e.tank_id is not null) > 1
    when 'package' then p_stage in ('packaged', 'used')
  end;
$$;

-- gravity_due, now with that one rule
create or replace function public.gravity_due(p_brewery_id uuid)
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
    select * from steps x where not coalesce(public.step_done(x.batch_id, x.stage, x.kind), false)
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

-- ---------- The links ----------
create table public.calendar_feeds (
  id            uuid primary key default gen_random_uuid(),
  brewery_id    uuid not null references public.breweries on delete cascade,
  user_id       uuid not null references auth.users on delete cascade,
  mine_only     boolean not null default false,   -- only items the person is on
  prefix        text not null,                     -- the link's first characters, to recognize it
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
alter table public.calendar_feeds enable row level security;
create policy "own links" on public.calendar_feeds for select to authenticated using (user_id = auth.uid());
revoke select on public.calendar_feeds from authenticated, anon;
grant select (id, brewery_id, user_id, mine_only, prefix, created_at, last_used_at, revoked_at) on public.calendar_feeds to authenticated;

-- Make a link: returns its secret ONCE
create function public.create_calendar_feed(p_brewery_id uuid, p_mine_only boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  token text;
begin
  if not public.is_member(p_brewery_id) then
    raise exception using errcode = '42501', message = 'You''re not part of that brewery.';
  end if;
  if public.api_key_permissions() is not null then
    raise exception using errcode = '42501', message = 'An API key can''t make calendar links.';
  end if;
  token := 'cal_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.calendar_feeds (brewery_id, user_id, mine_only, prefix, token_hash)
  values (p_brewery_id, auth.uid(), coalesce(p_mine_only, false), left(token, 10), encode(extensions.digest(token, 'sha256'), 'hex'));
  return token;
end;
$$;
revoke execute on function public.create_calendar_feed(uuid, boolean) from public, anon;
grant execute on function public.create_calendar_feed(uuid, boolean) to authenticated;

-- Turn a link off (your own): it stops working at once
create function public.revoke_calendar_feed(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.calendar_feeds set revoked_at = now() where id = p_id and user_id = auth.uid() and revoked_at is null;
$$;
revoke execute on function public.revoke_calendar_feed(uuid) from public, anon;
grant execute on function public.revoke_calendar_feed(uuid) to authenticated;

-- What a link shows: planned items (all, or the owner's), and expected steps from beers' schedules,
-- from two weeks ago to six months ahead. Only the calendar function calls this (with the link).
create function public.calendar_feed(p_token text)
returns table (brewery_name text, day date, title text, detail text, uid text)
language plpgsql security definer set search_path = '' as $$
declare
  f public.calendar_feeds;
  today date;
begin
  select * into f from public.calendar_feeds
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and revoked_at is null;
  if f.id is null or not exists (select 1 from public.memberships m where m.brewery_id = f.brewery_id and m.user_id = f.user_id) then
    return;  -- no such link, turned off, or its owner left the brewery: nothing
  end if;
  update public.calendar_feeds set last_used_at = now() where id = f.id;
  select (now() at time zone b.time_zone)::date into today from public.breweries b where b.id = f.brewery_id;

  return query
  with brewery as (select name from public.breweries where id = f.brewery_id),
  label(kind, text) as (values ('brew', 'Brew day'), ('dry_hop', 'Dry hop'), ('diacetyl_rest', 'Diacetyl rest'), ('crash', 'Crash'),
    ('transfer', 'Transfer'), ('carbonate', 'Carbonate'), ('package', 'Package'), ('clean', 'Clean'), ('acid', 'Acid cycle'),
    ('yeast_harvest', 'Yeast harvest'), ('maintenance', 'Maintenance'), ('delivery', 'Delivery'), ('other', 'Other')),
  planned as (
    select p.planned_on as day,
           concat_ws(': ', t.name, coalesce(nullif(p.title, ''), l.text), case when nullif(p.title, '') is null then be.name end)
             || case when p.done_at is not null then ' (done)' else '' end
             || coalesce(' · ' || split_part(u.email, '@', 1), '') as title,
           p.notes as detail, 'plan-' || p.id::text as uid
      from public.plan_items p join label l on l.kind = p.kind
      left join public.tanks t on t.id = p.tank_id left join public.beers be on be.id = p.beer_id
      left join auth.users u on u.id = p.assigned_to
     where p.brewery_id = f.brewery_id and p.planned_on between today - 14 and today + 183
       and (not f.mine_only or p.assigned_to = f.user_id)
  ),
  batch_steps as (
    select s.brew_date + (st ->> 'day')::int + coalesce(sh.days, 0) as day,
           concat_ws(': ', t.name, l.text, be.name) || ' (expected)' as title,
           format('#%s, from %s''s schedule. A plan, not a record.', s.batch_number, be.name) as detail,
           'step-' || s.id::text || '-' || (st ->> 'kind') as uid
      from public.batch_status s join public.tanks t on t.id = s.tank_id join public.beers be on be.id = s.beer_id
      join public.beer_schedules sc on sc.beer_id = s.beer_id cross join lateral jsonb_array_elements(sc.steps) st
      join label l on l.kind = st ->> 'kind'
      left join public.plan_shifts sh on sh.batch_id = s.id
     where s.brewery_id = f.brewery_id and s.stage not in ('packaged', 'used') and s.brew_date is not null and not f.mine_only
       and not coalesce(public.step_done(s.id, s.stage, st ->> 'kind'), false)
       and s.brew_date + (st ->> 'day')::int + coalesce(sh.days, 0) >= today  -- (a late step is the app's to show)
  ),
  brew_steps as (
    select p.planned_on + (st ->> 'day')::int as day,
           concat_ws(': ', t.name, l.text, be.name) || ' (expected)' as title,
           format('After the brew planned for %s.', to_char(p.planned_on, 'Mon DD')) as detail,
           'brewstep-' || p.id::text || '-' || (st ->> 'kind') as uid
      from public.plan_items p join public.beers be on be.id = p.beer_id left join public.tanks t on t.id = p.tank_id
      join public.beer_schedules sc on sc.beer_id = p.beer_id cross join lateral jsonb_array_elements(sc.steps) st
      join label l on l.kind = st ->> 'kind'
     where p.brewery_id = f.brewery_id and p.kind = 'brew' and p.planned_on is not null and p.done_at is null and not f.mine_only
       and p.planned_on + (st ->> 'day')::int >= today
       -- brewed already: the batch's own steps (above) take over
       and not exists (select 1 from public.batch_status b2 where b2.beer_id = p.beer_id and b2.brew_date between p.planned_on - 3 and p.planned_on + 3
                          and (p.tank_id is null or b2.tank_id = p.tank_id
                               or exists (select 1 from public.batch_events e where e.batch_id = b2.id and e.tank_id = p.tank_id)))
  )
  select (select name from brewery), x.day, x.title, x.detail, x.uid
    from (select * from planned union all select * from batch_steps union all select * from brew_steps) x
   where x.day between today - 14 and today + 183
   order by x.day, x.title;
end;
$$;
revoke execute on function public.calendar_feed(text) from public, anon, authenticated;
