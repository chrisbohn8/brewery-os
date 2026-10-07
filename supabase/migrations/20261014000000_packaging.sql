-- Moving beer, step 2: packaging (docs/moving-beer-design.md).
--
-- Package types are the brewery's own (Settings → Packages): picked from the app's catalog or
-- added. A packaging run is a "package" movement out of a tank, with a count per package type;
-- its volume is the counts × each type's volume. Packaging never empties a tank by itself:
-- a person says "this tank is spent", and what's left on paper is recorded as loss.

-- ---------- Package types ----------
create table public.package_types (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  name         text not null check (length(trim(name)) > 0 and length(name) <= 60),
  volume_bbl   numeric not null check (volume_bbl > 0),          -- per package (a whole case, for cases)
  kind         text not null default 'other' check (kind in ('keg', 'cask', 'case', 'single', 'other')),
  catalog_key  text check (length(catalog_key) <= 40),            -- which catalog entry it came from (empty = the brewery's own)
  active       boolean not null default true,                     -- unticked types stay, for past packaging runs
  created_at   timestamptz not null default now(),
  unique (brewery_id, id)
);
create unique index package_types_name on public.package_types (brewery_id, lower(name));

alter table public.package_types enable row level security;
create policy "members read" on public.package_types for select to authenticated using (public.is_member(brewery_id));
create policy "change package types" on public.package_types for all to authenticated
  using (public.has_permission(brewery_id, 'manage_settings')) with check (public.has_permission(brewery_id, 'manage_settings'));

-- The usual starting set for a brewery: half, quarter, and sixth barrel kegs, and cases of 12 and 16 oz cans.
-- (Volumes in US barrels: a case of 24 × 12 oz is 2.25 gal; 24 × 16 oz is 3 gal.)
create function public.add_usual_package_types(p_brewery_id uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.package_types (brewery_id, name, volume_bbl, kind, catalog_key)
  values (p_brewery_id, '½ bbl keg', 0.5, 'keg', 'keg_half'),
         (p_brewery_id, '¼ bbl keg', 0.25, 'keg', 'keg_quarter'),
         (p_brewery_id, '⅙ bbl keg', 1.0 / 6, 'keg', 'keg_sixth'),
         (p_brewery_id, 'Case, 24 × 12 oz', 2.25 / 31, 'case', 'case_24x12'),
         (p_brewery_id, 'Case, 24 × 16 oz', 3.0 / 31, 'case', 'case_24x16')
  on conflict do nothing;
$$;
revoke execute on function public.add_usual_package_types(uuid) from public, anon, authenticated;

-- New breweries start with the usual set; existing breweries get it now
create function public.new_brewery_package_types() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.add_usual_package_types(new.id);
  return new;
end;
$$;
create trigger usual_package_types after insert on public.breweries
  for each row execute function public.new_brewery_package_types();
select public.add_usual_package_types(id) from public.breweries;

-- ---------- Packaging runs ----------
-- How many of each package type a "package" movement filled. The volume per package is copied
-- in, so renaming or changing a type later never changes a past run.
create table public.package_counts (
  id               uuid primary key default gen_random_uuid(),
  brewery_id       uuid not null references public.breweries on delete cascade,
  movement_id      uuid not null references public.beer_movements on delete cascade,
  package_type_id  uuid not null,
  count            numeric not null check (count > 0),
  unit_volume_bbl  numeric not null check (unit_volume_bbl > 0),
  foreign key (brewery_id, package_type_id) references public.package_types (brewery_id, id)
);
create index package_counts_movement on public.package_counts (movement_id);

alter table public.package_counts enable row level security;
create policy "members read" on public.package_counts for select to authenticated using (public.is_member(brewery_id));
-- Written by record_packaging() below; directly (loading a backup) needs the package permission
create policy "record package counts" on public.package_counts for insert to authenticated
  with check (public.has_permission(brewery_id, 'package'));

-- Record a packaging run, all or nothing:
--   p_counts  [{ "type": "<package type id>", "count": 40 }, ...]
--   p_spent   true = "this tank is spent": what's left on paper becomes loss, the batch is packaged,
--             and the tank goes to cleaning. false = more to package later; the batch stays.
-- Safe to repeat (an offline retry): a run that's already saved changes nothing.
create function public.record_packaging(
  p_id uuid, p_brewery_id uuid, p_batch_id uuid, p_tank_id uuid, p_occurred_on date,
  p_counts jsonb, p_spent boolean, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  current_state record;
  total         numeric;
  balance       numeric;
  item          jsonb;
  unit          numeric;
begin
  perform public.require_permission(p_brewery_id, 'package', 'package beer');
  if exists (select 1 from public.beer_movements where id = p_id) then
    return; -- already saved (sent before the connection dropped)
  end if;
  select stage, tank_id into current_state from public.batch_status where id = p_batch_id and brewery_id = p_brewery_id;
  if not found then
    raise exception using errcode = '42501', message = 'You don''t have permission to change that batch.';
  end if;
  if current_state.stage = 'packaged' or current_state.tank_id is distinct from p_tank_id then
    raise exception 'That batch isn''t in that tank any more.';
  end if;
  if jsonb_typeof(p_counts) <> 'array' or (jsonb_array_length(p_counts) = 0 and not p_spent) then
    raise exception 'Enter how many of each package were filled.';
  end if;

  -- The run: one package movement, with its counts
  insert into public.beer_movements (id, brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, notes)
  values (p_id, p_brewery_id, p_batch_id, p_occurred_on, 'package', p_tank_id, 0, coalesce(p_notes, ''));
  total := 0;
  for item in select * from jsonb_array_elements(p_counts) loop
    select volume_bbl into unit from public.package_types
     where id = (item->>'type')::uuid and brewery_id = p_brewery_id;
    if not found then
      raise exception 'That package type no longer exists.';
    end if;
    if (item->>'count')::numeric <= 0 then
      raise exception 'Counts must be more than zero.';
    end if;
    insert into public.package_counts (brewery_id, movement_id, package_type_id, count, unit_volume_bbl)
    values (p_brewery_id, p_id, (item->>'type')::uuid, (item->>'count')::numeric, unit);
    total := total + (item->>'count')::numeric * unit;
  end loop;
  update public.beer_movements set volume_bbl = total where id = p_id;

  if p_spent then
    -- What's left on paper: a loss (or, if more came out than was recorded, a correction)
    balance := public.tank_balance(p_batch_id, p_tank_id);
    if balance > 0 then
      insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, notes)
      values (p_brewery_id, p_batch_id, p_occurred_on, 'loss', p_tank_id, balance, 'tank spent');
    elsif balance < 0 then
      insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, notes)
      values (p_brewery_id, p_batch_id, p_occurred_on, 'correction', p_tank_id, -balance, 'more packaged than was recorded');
    end if;
    -- The batch is packaged, and its tank goes to cleaning
    insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id, recorded_by)
    values (p_brewery_id, p_batch_id, p_occurred_on, 'packaged', null, auth.uid());
    perform set_config('brewery_os.saving_batch', 'on', true);
    update public.tanks set status = 'cleaning' where id = p_tank_id;
    perform set_config('brewery_os.saving_batch', 'off', true);
  end if;
end;
$$;
revoke execute on function public.record_packaging(uuid, uuid, uuid, uuid, date, jsonb, boolean, text) from public, anon;
grant execute on function public.record_packaging(uuid, uuid, uuid, uuid, date, jsonb, boolean, text) to authenticated;
