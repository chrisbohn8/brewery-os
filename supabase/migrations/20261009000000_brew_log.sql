-- Brew log, part 1: brewhouse settings, brew-day readings, the cellar log, and additions.
-- Design: docs/brew-log-design.md
--
-- Everything here is ADDED, never overwritten:
--   * a corrected reading is a new row; the newest row for a field is the current value,
--     and older rows are its history ("changed from 4.8 by Sam");
--   * cellar entries and additions are records of things that happened.
-- Every row's ID is made on the device, so all of it can be recorded offline and sent later
-- (sending twice is harmless).

-- ---------- Brewhouse settings belong to a location ----------
-- (Two locations of one brewery can have very different brewhouses: 15 bbl turns vs 30 bbl in one.)
alter table public.locations
  add column turn_size_bbl      numeric check (turn_size_bbl > 0),
  add column usual_turns        integer not null default 1 check (usual_turns between 1 and 6),
  add column kettle_full_bbl    numeric check (kettle_full_bbl > 0),
  add column flow_target        text not null default '',   -- as the brewery writes it, e.g. "20-22" or "6.6 - 5.5 - 6.2"
  add column water_grist_qt_lb  numeric check (water_grist_qt_lb > 0),  -- mash thickness, quarts per pound
  add column grain_absorption_gal_lb numeric check (grain_absorption_gal_lb >= 0);

-- How many turns this batch was brewed in (two 15 bbl turns into one 30 bbl fermenter, etc.)
alter table public.batches
  add column turns integer not null default 1 check (turns between 1 and 6);

-- ---------- Brew-day readings ----------
-- One row per value entered. field_key names a field on the brewery's brew sheet (the app's
-- default sheet for now; breweries will be able to edit theirs). Values are stored in standard
-- units (gravity SG, temperature °C, volume US barrels); raw keeps what was typed when it
-- isn't simply a number (e.g. a flow meter's start and end readings).
create table public.batch_readings (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  batch_id     uuid not null,
  turn         integer check (turn between 1 and 6),     -- null = once per batch
  field_key    text not null check (field_key ~ '^[a-z][a-z0-9_]{0,59}$'),
  value        numeric,
  value_text   text check (length(value_text) <= 500),
  raw          jsonb,
  recorded_by  uuid default auth.uid() references auth.users on delete set null,
  recorded_at  timestamptz not null default now(),
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete cascade,
  check (value is not null or value_text is not null)
);
create index batch_readings_batch on public.batch_readings (batch_id, field_key, turn, recorded_at desc);

-- The current value of each field (the newest entry), per batch and turn
create view public.batch_readings_current with (security_invoker = true) as
select distinct on (batch_id, coalesce(turn, 0), field_key) *
  from public.batch_readings
 order by batch_id, coalesce(turn, 0), field_key, recorded_at desc;

-- ---------- Cellar log ----------
-- The fermentation/cellar notebook: what was done (action item), the readings taken, any cellar
-- change (setpoint changes, spunding, slow crash), and notes. Entries can be corrected in place
-- (updated_at/updated_by say so) or removed by someone allowed to log cellar work.
create table public.cellar_entries (
  id             uuid primary key default gen_random_uuid(),
  brewery_id     uuid not null references public.breweries on delete cascade,
  batch_id       uuid not null,
  occurred_on    date not null,
  action         text not null default '' check (length(action) <= 60),   -- "Check", "Dry hop", "Crash", ...
  gravity_sg     numeric check (gravity_sg between 0.98 and 1.2),
  ph             numeric check (ph between 0 and 14),
  temp_c         numeric check (temp_c between -10 and 110),
  cellar_change  text not null default '' check (length(cellar_change) <= 200),
  notes          text not null default '' check (length(notes) <= 2000),
  recorded_by    uuid default auth.uid() references auth.users on delete set null,
  recorded_at    timestamptz not null default now(),
  updated_by     uuid references auth.users on delete set null,
  updated_at     timestamptz,
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete cascade
);
create index cellar_entries_batch on public.cellar_entries (batch_id, occurred_on, recorded_at);

-- ---------- Additions (dry hops, spices, fruit, ...) ----------
create table public.batch_additions (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  batch_id     uuid not null,
  added_on     date not null,
  kind         text not null default 'hop' check (kind in ('hop', 'spice', 'fruit', 'other')),
  name         text not null check (length(trim(name)) > 0 and length(name) <= 120),
  amount       numeric check (amount > 0),
  unit         text not null default 'oz' check (unit in ('oz', 'lb', 'g', 'kg', 'ml', 'l', 'gal', 'each')),
  timing       text not null default '' check (length(timing) <= 60),   -- "KO in FV", "Primary", "Regular", ...
  lot          text not null default '' check (length(lot) <= 80),
  notes        text not null default '' check (length(notes) <= 500),
  recorded_by  uuid default auth.uid() references auth.users on delete set null,
  recorded_at  timestamptz not null default now(),
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete cascade
);
create index batch_additions_batch on public.batch_additions (batch_id, added_on);

-- ---------- Who may do what ----------
alter table public.batch_readings  enable row level security;
alter table public.cellar_entries  enable row level security;
alter table public.batch_additions enable row level security;

create policy "members read" on public.batch_readings  for select to authenticated using (public.is_member(brewery_id));
create policy "members read" on public.cellar_entries  for select to authenticated using (public.is_member(brewery_id));
create policy "members read" on public.batch_additions for select to authenticated using (public.is_member(brewery_id));

-- Brew-day readings are part of the brew-day sheet: start_batch ("start batches and edit batch details")
create policy "record readings" on public.batch_readings for insert to authenticated
  with check (public.has_permission(brewery_id, 'start_batch'));
-- (No update policy: a correction is a new reading. Deleting goes with the batch.)

-- Cellar work and additions: cellar_log
create policy "log cellar work" on public.cellar_entries for insert to authenticated
  with check (public.has_permission(brewery_id, 'cellar_log'));
create policy "fix cellar log" on public.cellar_entries for update to authenticated
  using (public.has_permission(brewery_id, 'cellar_log')) with check (public.has_permission(brewery_id, 'cellar_log'));
create policy "remove cellar log" on public.cellar_entries for delete to authenticated
  using (public.has_permission(brewery_id, 'cellar_log'));

create policy "log additions" on public.batch_additions for insert to authenticated
  with check (public.has_permission(brewery_id, 'cellar_log'));
create policy "fix additions" on public.batch_additions for update to authenticated
  using (public.has_permission(brewery_id, 'cellar_log')) with check (public.has_permission(brewery_id, 'cellar_log'));
create policy "remove additions" on public.batch_additions for delete to authenticated
  using (public.has_permission(brewery_id, 'cellar_log'));

-- A correction stamps who changed a cellar entry and when
create function public.stamp_cellar_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  new.recorded_by := old.recorded_by;   -- who first logged it never changes
  new.recorded_at := old.recorded_at;
  return new;
end;
$$;
create trigger stamp_cellar_change before update on public.cellar_entries
  for each row execute function public.stamp_cellar_change();

-- Brewhouse settings are equipment
-- (locations' existing rules already require manage_equipment to change them)

-- ---------- Log a cellar entry, optionally moving the batch to a new stage, all or nothing ----------
-- e.g. "Dry hop" moves the batch to Dry hopping; "Crash" to Conditioning. Packaging isn't done here.
-- Safe to repeat (the entry's ID comes from the device; a repeat changes nothing).
create function public.log_cellar_entry(
  p_id uuid, p_brewery_id uuid, p_batch_id uuid, p_occurred_on date, p_action text,
  p_gravity_sg numeric, p_ph numeric, p_temp_c numeric, p_cellar_change text, p_notes text,
  p_new_stage text   -- null = no stage change
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  current_state record;
begin
  perform public.require_permission(p_brewery_id, 'cellar_log', 'log cellar work');
  if not exists (select 1 from public.batches where id = p_batch_id and brewery_id = p_brewery_id) then
    raise exception using errcode = '42501', message = 'You don''t have permission to change that batch.';
  end if;
  if exists (select 1 from public.cellar_entries where id = p_id) then
    return; -- already saved (a repeat after a dropped connection)
  end if;

  insert into public.cellar_entries (id, brewery_id, batch_id, occurred_on, action, gravity_sg, ph, temp_c, cellar_change, notes)
  values (p_id, p_brewery_id, p_batch_id, p_occurred_on, coalesce(trim(p_action), ''), p_gravity_sg, p_ph, p_temp_c,
          coalesce(trim(p_cellar_change), ''), coalesce(trim(p_notes), ''));

  if p_new_stage is not null then
    if p_new_stage not in ('fermenting', 'dry-hopping', 'conditioning', 'carbonating', 'ready') then
      raise exception 'A cellar entry can''t move a batch to "%".', p_new_stage;
    end if;
    select stage, tank_id into current_state from public.batch_status where id = p_batch_id;
    if current_state.stage = 'packaged' then
      raise exception 'That batch has already been packaged.';
    end if;
    if current_state.stage is distinct from p_new_stage then
      perform public.require_permission(p_brewery_id, 'move_beer', 'change stages');
      insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id, recorded_by)
      values (p_brewery_id, p_batch_id, p_occurred_on, p_new_stage, current_state.tank_id, auth.uid());
    end if;
  end if;
end;
$$;
revoke execute on function public.log_cellar_entry(uuid, uuid, uuid, date, text, numeric, numeric, numeric, text, text, text) from public, anon;
grant execute on function public.log_cellar_entry(uuid, uuid, uuid, date, text, numeric, numeric, numeric, text, text, text) to authenticated;
