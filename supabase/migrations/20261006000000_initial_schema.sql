-- Brewery OS: first database design
--
-- How data is kept separate between breweries (multi-tenancy):
--   * Every table has a brewery_id.
--   * Row-level security (RLS) is turned on for every table. With RLS on, the database
--     refuses every read and write unless a "policy" below allows it.
--   * The policies only allow signed-in members of a brewery to see that brewery's rows.
--   The app's public key can be in the web page because of this: on its own, the key
--   can't read anything.
--
-- Roles within a brewery:
--   admin  — everything, including brewery settings and members
--   brewer — day-to-day work: tanks, beers, batches, locations
--   viewer — read-only

-- ---------- Breweries and who belongs to them ----------

create table public.breweries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  created_at  timestamptz not null default now()
);

create table public.memberships (
  brewery_id  uuid not null references public.breweries on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  role        text not null default 'brewer' check (role in ('admin', 'brewer', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (brewery_id, user_id)
);

-- ---------- Setup data: locations, tanks, beers ----------

create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  created_at  timestamptz not null default now()
);
-- No two locations with the same name in one brewery ("Downtown" and "downtown" count as the same)
create unique index locations_name_unique on public.locations (brewery_id, lower(name));
-- Lets other tables point at "this location, in this brewery" (see "same brewery" below)
alter table public.locations add unique (brewery_id, id);

create table public.tanks (
  id            uuid primary key default gen_random_uuid(),
  brewery_id    uuid not null references public.breweries on delete cascade,
  location_id   uuid,
  name          text not null check (length(trim(name)) > 0),
  type          text not null default 'fermenter' check (type in ('fermenter', 'brite', 'serving', 'lagering')),
  capacity_bbl  numeric check (capacity_bbl > 0),
  -- Set by a person. "Occupied" is never stored: it's worked out from the batch inside.
  status        text not null default 'empty' check (status in ('empty', 'cleaning', 'maintenance')),
  created_at    timestamptz not null default now(),
  unique (brewery_id, id),
  -- Same brewery: a tank can only be in one of its own brewery's locations.
  -- A location with tanks in it can't be deleted.
  foreign key (brewery_id, location_id) references public.locations (brewery_id, id)
);
create unique index tanks_name_unique on public.tanks (brewery_id, lower(name));

create table public.beers (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  code        text not null,  -- readable ID made from the name, like "house-hazy"
  name        text not null check (length(trim(name)) > 0),
  style       text not null default '',
  target_og   numeric check (target_og between 1 and 1.2),
  target_fg   numeric check (target_fg between 0.99 and 1.2),
  created_at  timestamptz not null default now(),
  check (target_fg is null or target_og is null or target_fg < target_og),
  unique (brewery_id, id)
);
create unique index beers_code_unique on public.beers (brewery_id, code);
create unique index beers_name_unique on public.beers (brewery_id, lower(name));

-- ---------- Batches and their history ----------

create table public.batches (
  id            uuid primary key default gen_random_uuid(),
  brewery_id    uuid not null references public.breweries on delete cascade,
  batch_number  text not null check (length(trim(batch_number)) > 0),  -- the brewer's number, like "1042"
  beer_id       uuid not null,
  brew_date     date not null,
  size_bbl      numeric check (size_bbl > 0),
  created_at    timestamptz not null default now(),
  unique (brewery_id, id),
  -- Same brewery: a batch can only be a brew of its own brewery's beer.
  -- A beer that has batches can't be deleted.
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id)
);
create unique index batches_number_unique on public.batches (brewery_id, lower(batch_number));

-- The batch's history. Every stage change or transfer adds a row here; nothing is overwritten.
-- Each row says: "from this date, the batch was at this stage, in this tank."
-- Where a batch is NOW is simply its most recent row (see the batch_status view below).
create table public.batch_events (
  id              uuid primary key default gen_random_uuid(),
  brewery_id      uuid not null references public.breweries on delete cascade,
  batch_id        uuid not null,
  effective_date  date not null,
  stage           text not null check (stage in ('fermenting', 'dry-hopping', 'conditioning', 'carbonating', 'ready', 'packaged')),
  tank_id         uuid,
  recorded_by     uuid default auth.uid() references auth.users on delete set null,
  recorded_at     timestamptz not null default now(),
  -- Same brewery: events only point at their own brewery's batch and tank.
  -- Deleting a batch deletes its history. A tank with history can't be deleted
  -- (TTB and traceability need to know where beer was).
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete cascade,
  foreign key (brewery_id, tank_id) references public.tanks (brewery_id, id)
);
create index batch_events_batch on public.batch_events (batch_id, effective_date desc, recorded_at desc);

-- Each batch with its current stage and tank, and the date it entered that stage.
-- "security_invoker" means the view follows the same RLS rules as the tables underneath.
create view public.batch_status with (security_invoker = true) as
with ranked as (
  select e.*,
         row_number() over (partition by e.batch_id order by e.effective_date desc, e.recorded_at desc) as newest
  from public.batch_events e
),
latest as (
  select * from ranked where newest = 1
)
select
  b.*,
  l.stage,
  l.tank_id,
  -- When did the current stage start? The first event of the current run of that stage.
  -- (A transfer without a stage change doesn't reset the "days in stage" counter.)
  (
    select min(e.effective_date)
    from public.batch_events e
    where e.batch_id = b.id
      and e.stage = l.stage
      and e.effective_date >= coalesce(
        (select max(x.effective_date) from public.batch_events x
          where x.batch_id = b.id and x.stage <> l.stage),
        '-infinity'::date)
  ) as stage_started_on
from public.batches b
left join latest l on l.batch_id = b.id;

-- ---------- Helper checks used by the security policies ----------
-- "security definer" lets these look up memberships without being blocked by RLS themselves.

create function public.is_member(b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.brewery_id = b and m.user_id = auth.uid()
  );
$$;

create function public.can_edit(b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.brewery_id = b and m.user_id = auth.uid() and m.role in ('admin', 'brewer')
  );
$$;

create function public.is_admin(b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.brewery_id = b and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

-- ---------- Creating a brewery ----------
-- A new user belongs to no brewery yet, so they couldn't insert one under the rules above.
-- This function creates the brewery AND makes the person who created it its admin, in one step.

create function public.create_brewery(brewery_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You need to be signed in to create a brewery';
  end if;
  insert into public.breweries (name) values (trim(brewery_name)) returning id into new_id;
  insert into public.memberships (brewery_id, user_id, role) values (new_id, auth.uid(), 'admin');
  return new_id;
end;
$$;

-- Only signed-in people can call it
revoke execute on function public.create_brewery(text) from public, anon;
grant execute on function public.create_brewery(text) to authenticated;

-- ---------- Turn on row-level security everywhere ----------

alter table public.breweries    enable row level security;
alter table public.memberships  enable row level security;
alter table public.locations    enable row level security;
alter table public.tanks        enable row level security;
alter table public.beers        enable row level security;
alter table public.batches      enable row level security;
alter table public.batch_events enable row level security;

-- ---------- Policies: who can do what ----------

-- Breweries: members see their brewery; only admins rename it. (Creating goes through create_brewery.)
create policy "members can view their brewery" on public.breweries
  for select to authenticated using (public.is_member(id));
create policy "admins can update their brewery" on public.breweries
  for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));

-- Memberships: you see the members of your breweries; only admins add, change, or remove them.
create policy "members can view memberships" on public.memberships
  for select to authenticated using (public.is_member(brewery_id));
create policy "admins manage memberships" on public.memberships
  for all to authenticated using (public.is_admin(brewery_id)) with check (public.is_admin(brewery_id));

-- Everything else: members can read; admins and brewers can add, change, and delete.
create policy "members read" on public.locations    for select to authenticated using (public.is_member(brewery_id));
create policy "editors write" on public.locations   for all    to authenticated using (public.can_edit(brewery_id)) with check (public.can_edit(brewery_id));

create policy "members read" on public.tanks        for select to authenticated using (public.is_member(brewery_id));
create policy "editors write" on public.tanks       for all    to authenticated using (public.can_edit(brewery_id)) with check (public.can_edit(brewery_id));

create policy "members read" on public.beers        for select to authenticated using (public.is_member(brewery_id));
create policy "editors write" on public.beers       for all    to authenticated using (public.can_edit(brewery_id)) with check (public.can_edit(brewery_id));

create policy "members read" on public.batches      for select to authenticated using (public.is_member(brewery_id));
create policy "editors write" on public.batches     for all    to authenticated using (public.can_edit(brewery_id)) with check (public.can_edit(brewery_id));

create policy "members read" on public.batch_events  for select to authenticated using (public.is_member(brewery_id));
create policy "editors write" on public.batch_events for all    to authenticated using (public.can_edit(brewery_id)) with check (public.can_edit(brewery_id));
