-- Permissions: levels with editable defaults, plus per-person adjustments.
--
-- Each member has a LEVEL (viewer, cellar, brewer, head_brewer, admin). Each level is a set
-- of permissions; a brewery's admins can change what a level includes (role_levels), and can
-- adjust any one person on top of their level (memberships.grants / memberships.revokes).
--
--   Admin always has every permission, and only admins manage the team and permissions
--   (otherwise anyone who could edit permissions could make themselves an admin).
--
-- Effective permissions = admin ? everything : (level's permissions + grants) - revokes
--
-- The permission list (the app shows these names; keep in step with PERMISSIONS in app.js):
--   cellar_log        log readings and cellar work
--   tank_status       set a tank's status (empty, cleaning, maintenance)
--   acid_log          log (and remove) acid cycles
--   move_beer         change a batch's stage and transfer it between tanks
--   package           package beer
--   start_batch       start batches and edit batch details (brew-day sheets)
--   manage_beers      beers (and later recipes)
--   manage_equipment  tanks and locations
--   manage_cleaning   acid rules (acid-after styles, "acid every X turns")
--   manage_settings   units and time zone
--   rename_brewery    rename the brewery
--   backups           download and load backups
--   delete_records    delete batches, beers, tanks, and locations

create function public.permission_list() returns text[]
language sql immutable as $$
  select array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'start_batch',
               'manage_beers', 'manage_equipment', 'manage_cleaning', 'manage_settings',
               'rename_brewery', 'backups', 'delete_records'];
$$;

-- What each level includes until a brewery changes it
create function public.default_permissions(level text) returns text[]
language sql immutable as $$
  select case level
    when 'cellar'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package']
    when 'brewer'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'start_batch']
    when 'head_brewer' then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'start_batch',
                                  'manage_beers', 'manage_equipment', 'manage_cleaning', 'manage_settings']
    when 'admin'       then public.permission_list()
    else array[]::text[]  -- viewer: look only
  end;
$$;

-- ---------- Levels and per-person adjustments ----------

alter table public.memberships drop constraint memberships_role_check;
alter table public.memberships
  add constraint memberships_role_check check (role in ('viewer', 'cellar', 'brewer', 'head_brewer', 'admin')),
  add column grants  text[] not null default '{}' check (grants  <@ public.permission_list()),
  add column revokes text[] not null default '{}' check (revokes <@ public.permission_list());

alter table public.invites drop constraint invites_role_check;
alter table public.invites
  add constraint invites_role_check check (role in ('viewer', 'cellar', 'brewer', 'head_brewer', 'admin'));

-- A brewery's own version of a level (only levels it has changed have a row)
create table public.role_levels (
  brewery_id  uuid not null references public.breweries on delete cascade,
  level       text not null check (level in ('viewer', 'cellar', 'brewer', 'head_brewer')),
  permissions text[] not null check (permissions <@ public.permission_list()),
  primary key (brewery_id, level)
);
alter table public.role_levels enable row level security;
create policy "members read levels" on public.role_levels
  for select to authenticated using (public.is_member(brewery_id));
create policy "admins change levels" on public.role_levels
  for all to authenticated using (public.is_admin(brewery_id)) with check (public.is_admin(brewery_id));

-- ---------- Checking a permission ----------

create function public.has_permission(b uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.memberships m
      left join public.role_levels l on l.brewery_id = m.brewery_id and l.level = m.role
     where m.brewery_id = b
       and m.user_id = auth.uid()
       and (
         m.role = 'admin'
         or ((perm = any(coalesce(l.permissions, public.default_permissions(m.role))) or perm = any(m.grants))
             and not perm = any(m.revokes))
       )
  );
$$;

-- All of your permissions in a brewery (the app uses this to show and hide things)
create function public.my_permissions(b uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(p order by p), '{}')
    from unnest(public.permission_list()) as p
   where public.has_permission(b, p);
$$;
revoke execute on function public.my_permissions(uuid) from public, anon;
grant execute on function public.my_permissions(uuid) to authenticated;

-- Raise the standard "no permission" error with a readable message
create function public.require_permission(b uuid, perm text, what text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission(b, perm) then
    raise exception using errcode = '42501', message = format('You don''t have permission to %s.', what);
  end if;
end;
$$;

-- "Can do anything at all" (used where a trigger then checks the exact change)
create function public.can_change_anything(b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(array_length(public.my_permissions(b), 1), 0) > 0;
$$;

-- The old "admin or brewer" check is replaced by permissions
drop policy "editors write" on public.locations;
drop policy "editors write" on public.tanks;
drop policy "editors write" on public.beers;
drop policy "editors write" on public.batches;
drop policy "editors write" on public.batch_events;
drop policy "editors write" on public.tank_cleanings;
drop policy "admins can update their brewery" on public.breweries;

-- ---------- Locations, beers: one permission each (plus delete_records to delete) ----------

create policy "add locations" on public.locations for insert to authenticated
  with check (public.has_permission(brewery_id, 'manage_equipment'));
create policy "change locations" on public.locations for update to authenticated
  using (public.has_permission(brewery_id, 'manage_equipment'))
  with check (public.has_permission(brewery_id, 'manage_equipment'));
create policy "delete locations" on public.locations for delete to authenticated
  using (public.has_permission(brewery_id, 'manage_equipment') and public.has_permission(brewery_id, 'delete_records'));

create policy "add beers" on public.beers for insert to authenticated
  with check (public.has_permission(brewery_id, 'manage_beers'));
create policy "change beers" on public.beers for update to authenticated
  using (public.has_permission(brewery_id, 'manage_beers'))
  with check (public.has_permission(brewery_id, 'manage_beers'));
create policy "delete beers" on public.beers for delete to authenticated
  using (public.has_permission(brewery_id, 'manage_beers') and public.has_permission(brewery_id, 'delete_records'));

-- ---------- Tanks: which permission depends on WHAT changes ----------
-- Status (empty/cleaning/maintenance) is floor work; name, type, capacity, and location are
-- equipment; "acid every X turns" is a cleaning rule. The row rule lets anyone with some
-- permission try, and this trigger checks each changed field.

create policy "add tanks" on public.tanks for insert to authenticated
  with check (public.has_permission(brewery_id, 'manage_equipment'));
create policy "change tanks" on public.tanks for update to authenticated
  using (public.can_change_anything(brewery_id)) with check (public.can_change_anything(brewery_id));
create policy "delete tanks" on public.tanks for delete to authenticated
  using (public.has_permission(brewery_id, 'manage_equipment') and public.has_permission(brewery_id, 'delete_records'));

create function public.check_tank_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- Database maintenance (no signed-in person) and save_batch's own tank updates are trusted
  if auth.uid() is null or current_setting('brewery_os.saving_batch', true) = 'on' then
    return new;
  end if;
  if new.brewery_id <> old.brewery_id then
    raise exception 'A tank can''t move to another brewery.';
  end if;
  if (new.name, new.type, new.capacity_bbl, new.location_id)
     is distinct from (old.name, old.type, old.capacity_bbl, old.location_id) then
    perform public.require_permission(old.brewery_id, 'manage_equipment', 'change tank details');
  end if;
  if new.acid_every_turns is distinct from old.acid_every_turns then
    perform public.require_permission(old.brewery_id, 'manage_cleaning', 'change acid rules');
  end if;
  if new.status is distinct from old.status then
    perform public.require_permission(old.brewery_id, 'tank_status', 'change a tank''s status');
  end if;
  return new;
end;
$$;
create trigger check_tank_change before update on public.tanks
  for each row execute function public.check_tank_change();

-- ---------- The brewery itself: name, units, acid styles ----------

create policy "change brewery" on public.breweries for update to authenticated
  using (public.can_change_anything(id)) with check (public.can_change_anything(id));

create function public.check_brewery_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.name is distinct from old.name then
    perform public.require_permission(old.id, 'rename_brewery', 'rename the brewery');
  end if;
  if (new.temperature_unit, new.gravity_unit, new.volume_unit, new.time_zone)
     is distinct from (old.temperature_unit, old.gravity_unit, old.volume_unit, old.time_zone) then
    perform public.require_permission(old.id, 'manage_settings', 'change units or the time zone');
  end if;
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;
create trigger check_brewery_change before update on public.breweries
  for each row execute function public.check_brewery_change();

-- ---------- Acid cycles ----------

create policy "log acid" on public.tank_cleanings for insert to authenticated
  with check (public.has_permission(brewery_id, 'acid_log'));
create policy "fix acid log" on public.tank_cleanings for update to authenticated
  using (public.has_permission(brewery_id, 'acid_log')) with check (public.has_permission(brewery_id, 'acid_log'));
create policy "remove acid log" on public.tank_cleanings for delete to authenticated
  using (public.has_permission(brewery_id, 'acid_log'));

-- ---------- Batches and their history ----------
-- Day-to-day changes go through save_batch() (below), which checks the exact kind of change.
-- Writing the tables directly (loading a backup) needs start_batch; deleting needs delete_records.

create policy "add batches" on public.batches for insert to authenticated
  with check (public.has_permission(brewery_id, 'start_batch'));
create policy "change batches" on public.batches for update to authenticated
  using (public.has_permission(brewery_id, 'start_batch')) with check (public.has_permission(brewery_id, 'start_batch'));
create policy "delete batches" on public.batches for delete to authenticated
  using (public.has_permission(brewery_id, 'delete_records'));

create policy "add batch history" on public.batch_events for insert to authenticated
  with check (public.has_permission(brewery_id, 'start_batch'));
create policy "change batch history" on public.batch_events for update to authenticated
  using (public.has_permission(brewery_id, 'start_batch')) with check (public.has_permission(brewery_id, 'start_batch'));
create policy "delete batch history" on public.batch_events for delete to authenticated
  using (public.has_permission(brewery_id, 'delete_records'));

-- save_batch now runs with the database's rights and checks permissions itself, so a cellar
-- person can transfer or package a batch without being allowed to rename it.
--   new batch, or batch number / beer / brew date / size changed  -> start_batch
--   moved to "packaged"                                            -> package
--   any other stage change, transfer, or stage-date correction     -> move_beer
create or replace function public.save_batch(
  p_id uuid, p_brewery_id uuid, p_batch_number text, p_beer_id uuid, p_brew_date date,
  p_size_bbl numeric, p_stage text, p_stage_started_on date, p_tank_id uuid, p_action_date date
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  existing        record;
  current_state   record;
  start_event_id  uuid;
  in_tank         boolean := p_stage <> 'packaged';
  new_tank        uuid := case when p_stage <> 'packaged' then p_tank_id end;
  occupant        record;
  stage_changed   boolean;
  tank_changed    boolean;
begin
  if not public.is_member(p_brewery_id) then
    raise exception using errcode = '42501', message = 'You don''t have permission to change batches.';
  end if;

  select * into existing from public.batches where id = p_id;
  if found and existing.brewery_id <> p_brewery_id then
    raise exception using errcode = '42501', message = 'You don''t have permission to change batches.';
  end if;
  select stage, tank_id, stage_started_on into current_state from public.batch_status where id = p_id;

  stage_changed := current_state.stage is distinct from p_stage;
  tank_changed  := in_tank and current_state.tank_id is distinct from new_tank;

  -- What kind of change is this, and is this person allowed to make it?
  if existing.id is null
     or (existing.batch_number, existing.beer_id, existing.brew_date, existing.size_bbl)
        is distinct from (trim(p_batch_number), p_beer_id, p_brew_date, p_size_bbl) then
    perform public.require_permission(p_brewery_id, 'start_batch', 'start batches or change batch details');
  end if;
  if (stage_changed or tank_changed) and p_stage = 'packaged' then
    perform public.require_permission(p_brewery_id, 'package', 'package beer');
  elsif stage_changed or tank_changed
        or current_state.stage_started_on is distinct from p_stage_started_on then
    perform public.require_permission(p_brewery_id, 'move_beer', 'change stages or transfer beer');
  end if;

  if in_tank and p_tank_id is null then
    raise exception 'Choose a tank for this batch.';
  end if;

  if in_tank then
    -- Lock the tank (it must belong to this brewery), so two people can't fill it at once
    perform 1 from public.tanks where id = new_tank and brewery_id = p_brewery_id for update;
    if not found then
      raise exception 'That tank no longer exists.';
    end if;
    select s.batch_number, b.name as beer_name, t.name as tank_name
      into occupant
      from public.batch_status s
      join public.beers b on b.id = s.beer_id
      join public.tanks t on t.id = s.tank_id
     where s.tank_id = new_tank and s.stage <> 'packaged' and s.id <> p_id
     limit 1;
    if found then
      raise exception '% already has % in it. Move or package that batch first.', occupant.tank_name, occupant.beer_name;
    end if;
  end if;

  insert into public.batches (id, brewery_id, batch_number, beer_id, brew_date, size_bbl)
  values (p_id, p_brewery_id, trim(p_batch_number), p_beer_id, p_brew_date, p_size_bbl)
  on conflict (id) do update
    set batch_number = excluded.batch_number,
        beer_id      = excluded.beer_id,
        brew_date    = excluded.brew_date,
        size_bbl     = excluded.size_bbl;

  if stage_changed or tank_changed then
    insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id, recorded_by)
    values (p_brewery_id, p_id,
            case when stage_changed then p_stage_started_on else p_action_date end,
            p_stage, new_tank, auth.uid());
  elsif current_state.stage_started_on is distinct from p_stage_started_on then
    select e.id into start_event_id
      from public.batch_events e
     where e.batch_id = p_id and e.stage = p_stage and e.effective_date = current_state.stage_started_on
     order by e.recorded_at
     limit 1;
    update public.batch_events set effective_date = p_stage_started_on where id = start_event_id;
  end if;

  -- Tank statuses that follow from the move (trusted: tell the tank trigger it's save_batch)
  perform set_config('brewery_os.saving_batch', 'on', true);
  if current_state.tank_id is not null and current_state.stage <> 'packaged'
     and (not in_tank or current_state.tank_id <> new_tank) then
    update public.tanks set status = 'cleaning' where id = current_state.tank_id;
  end if;
  if tank_changed or (in_tank and current_state.stage = 'packaged') then
    update public.tanks set status = 'empty' where id = new_tank;
  end if;
  perform set_config('brewery_os.saving_batch', 'off', true);
end;
$$;

-- can_edit() is no longer used
drop function public.can_edit(uuid);
