-- Planning calendar, step 1 (docs/calendar-design.md): planned items on a week view, someday
-- plans, a schedule for each beer, and two new permissions.
--
-- A plan is never a record. Nothing here changes a batch, a tank, or stock; doing the work on the
-- floor records it as usual. These tables only hold what someone intends to do, and when.

-- ---------- Two new permissions ----------
--   plan_schedule   add, change, and delete anything on the calendar, and beers' schedules
--   move_schedule   move an item to another day or tank, and tick it done
create or replace function public.permission_list() returns text[]
language sql immutable as $$
  select array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'start_batch',
               'manage_beers', 'manage_equipment', 'manage_cleaning', 'manage_settings',
               'rename_brewery', 'backups', 'delete_records', 'plan_schedule', 'move_schedule'];
$$;
create or replace function public.default_permissions(level text) returns text[]
language sql immutable as $$
  select case level
    when 'cellar'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory']
    when 'brewer'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'start_batch',
                                  'move_schedule']
    when 'head_brewer' then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'start_batch',
                                  'manage_beers', 'manage_equipment', 'manage_cleaning', 'manage_settings',
                                  'plan_schedule', 'move_schedule']
    when 'admin'       then public.permission_list()
    else array[]::text[]  -- viewer: look only
  end;
$$;
-- A brewery that changed a level: whoever starts batches can move plan items, and whoever sets up
-- beers can plan
update public.role_levels set permissions = permissions || array['move_schedule']
 where 'start_batch' = any(permissions) and not 'move_schedule' = any(permissions);
update public.role_levels set permissions = permissions || array['plan_schedule']
 where 'manage_beers' = any(permissions) and not 'plan_schedule' = any(permissions);

-- ---------- Planned items ----------
create table public.plan_items (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  kind         text not null check (kind in ('brew', 'dry_hop', 'diacetyl_rest', 'crash', 'transfer', 'carbonate',
                 'package', 'clean', 'acid', 'yeast_harvest', 'maintenance', 'delivery', 'other')),
  title        text not null default '' check (length(title) <= 80),   -- the brewery's own words, if any
  planned_on   date,                                                    -- null: a someday plan
  someday      text not null default '' check (length(someday) <= 40),  -- "Fall", "November"
  tank_id      uuid,                                                    -- null: the whole brewery
  beer_id      uuid,                                                    -- what's brewed (or moved, packaged...)
  batch_id     uuid,                                                    -- a batch already in a tank
  notes        text not null default '' check (length(notes) <= 1000),
  done_at      timestamptz,
  created_by   uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid() references auth.users on delete set null,
  updated_at   timestamptz not null default now(),
  check (planned_on is not null or someday <> ''),
  foreign key (brewery_id, tank_id) references public.tanks (brewery_id, id) on delete set null (tank_id),
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id) on delete set null (beer_id),
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete set null (batch_id)
);
create index plan_items_by_day on public.plan_items (brewery_id, planned_on);
alter table public.plan_items enable row level security;
create policy "members read" on public.plan_items for select to authenticated using (public.is_member(brewery_id));
create policy "plan: add" on public.plan_items for insert to authenticated
  with check (public.has_permission(brewery_id, 'plan_schedule'));
create policy "plan: delete" on public.plan_items for delete to authenticated
  using (public.has_permission(brewery_id, 'plan_schedule'));
create policy "plan: change or move" on public.plan_items for update to authenticated
  using (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule'))
  with check (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule'));

-- Someone who may only move items can change the day, the tank, and "done", and nothing else
create function public.check_plan_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  if auth.uid() is not null and not public.has_permission(new.brewery_id, 'plan_schedule')
     and (new.kind, new.title, new.someday, new.beer_id, new.batch_id, new.notes, new.brewery_id)
         is distinct from (old.kind, old.title, old.someday, old.beer_id, old.batch_id, old.notes, old.brewery_id) then
    raise exception 'You can move items on the calendar and tick them done, but not change what they are.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger check_plan_change before update on public.plan_items
  for each row execute function public.check_plan_change();

-- ---------- Each beer's schedule ----------
-- Its steps, in days after brewing: [{"kind": "dry_hop", "day": 5}, {"kind": "crash", "day": 10}, ...]
-- The calendar lays these out ("expected") after a planned brew and for batches in tanks.
create table public.beer_schedules (
  brewery_id  uuid not null references public.breweries on delete cascade,
  beer_id     uuid not null,
  steps       jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),
  updated_by  uuid default auth.uid() references auth.users on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (beer_id),
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id) on delete cascade
);
alter table public.beer_schedules enable row level security;
create policy "members read" on public.beer_schedules for select to authenticated using (public.is_member(brewery_id));
create policy "plan: schedules" on public.beer_schedules for all to authenticated
  using (public.has_permission(brewery_id, 'plan_schedule')) with check (public.has_permission(brewery_id, 'plan_schedule'));

-- ---------- Backups bring the plan back too ----------
-- (load_into_brewery, from ..._load_backup.sql, with plan_items and beer_schedules on its list)
create or replace function public.load_into_brewery(p_brewery_id uuid, p_steps jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  allowed constant text[] := array[
    'locations', 'beers', 'tanks', 'tank_cleanings', 'batches', 'batch_events', 'beer_movements',
    'stock_places', 'package_types', 'package_counts', 'raw_items', 'raw_receipts', 'raw_adjustments',
    'recipes', 'recipe_ingredients', 'inventory_views', 'draft_lines', 'stock_pars', 'stock_moves',
    'cellar_entries', 'batch_additions', 'batch_readings', 'breweries', 'plan_items', 'beer_schedules'];
  swaps  jsonb := '{}';  -- the app's ID -> the brewery's own row's ID (from "match" steps)
  step   jsonb;
  tbl    text;
  grp    record;
  cols   text;
  found  uuid;
  k      text;
begin
  if not public.is_member(p_brewery_id) then
    raise exception 'You''re not in that brewery.' using errcode = '42501';
  end if;
  if exists (select 1 from public.locations where brewery_id = p_brewery_id)
     or exists (select 1 from public.tanks where brewery_id = p_brewery_id)
     or exists (select 1 from public.beers where brewery_id = p_brewery_id)
     or exists (select 1 from public.batches where brewery_id = p_brewery_id) then
    raise exception 'Data can only be loaded into an empty brewery, so nothing gets mixed up or duplicated.';
  end if;

  for step in select value from jsonb_array_elements(p_steps) loop
    -- Swap in the brewery's own IDs found so far (IDs are random, so a plain text swap is exact)
    if swaps <> '{}' then
      declare t text := step::text; begin
        for k in select jsonb_object_keys(swaps) loop
          t := replace(t, k, swaps ->> k);
        end loop;
        step := t::jsonb;
      end;
    end if;
    tbl := coalesce(step ->> 'insert', step ->> 'match', step ->> 'update');
    if tbl is null or not (tbl = any (allowed)) or (tbl = 'breweries' and step ? 'insert') then
      raise exception 'A backup can''t load into "%".', coalesce(tbl, '?');
    end if;

    if step ? 'insert' then
      -- Every row belongs to this brewery. Rows with the same columns go in together.
      for grp in
        select x.cols, jsonb_agg(x.r || jsonb_build_object('brewery_id', p_brewery_id)) as rows
          from (select r, (select string_agg(quote_ident(c), ', ' order by c)
                             from jsonb_object_keys(r || jsonb_build_object('brewery_id', p_brewery_id)) c) as cols
                  from jsonb_array_elements(step -> 'rows') r) x
         group by x.cols
      loop
        execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)',
                       tbl, grp.cols, grp.cols, tbl) using grp.rows;
      end loop;

    elsif step ? 'match' then
      execute format('select id from public.%I where brewery_id = $1 and lower(trim(name)) = lower(trim($2 ->> ''name''))%s limit 1', tbl,
                     case when step -> 'keys' ? 'location_id' then ' and location_id is not distinct from ($2 ->> ''location_id'')::uuid' else '' end)
        into found using p_brewery_id, step -> 'row';
      if found is not null then
        swaps := swaps || jsonb_build_object(step -> 'row' ->> 'id', found::text);
      else
        select string_agg(quote_ident(c), ', ') into cols
          from jsonb_object_keys((step -> 'row') || jsonb_build_object('brewery_id', p_brewery_id)) c;
        execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', tbl, cols, cols, tbl)
          using (step -> 'row') || jsonb_build_object('brewery_id', p_brewery_id);
      end if;

    else
      if tbl = 'breweries' and (step ->> 'id')::uuid <> p_brewery_id then
        raise exception 'A backup can only change the brewery it''s loaded into.';
      end if;
      select string_agg(quote_ident(c), ', ') into cols from jsonb_object_keys(step -> 'set') c;
      execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where id = $2 and %s',
                     tbl, cols, cols, tbl, case when tbl = 'breweries' then 'true' else 'brewery_id = $3' end)
        using step -> 'set', (step ->> 'id')::uuid, p_brewery_id;
    end if;
  end loop;
end;
$$;
