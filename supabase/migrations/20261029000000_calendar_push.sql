-- Planning calendar, step 2 (docs/calendar-design.md): late steps and "Push the rest back".
--
-- When a batch is behind its beer's schedule (still not dry hopped on its dry hop day), its later
-- steps can be pushed back. The push is kept here, per batch, as a number of days added to its
-- schedule. Nothing about the batch itself changes: a plan is never a record.

create table public.plan_shifts (
  batch_id    uuid primary key,
  brewery_id  uuid not null references public.breweries on delete cascade,
  days        integer not null check (days between -365 and 365),
  updated_by  uuid default auth.uid() references auth.users on delete set null,
  updated_at  timestamptz not null default now(),
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete cascade
);
alter table public.plan_shifts enable row level security;
create policy "members read" on public.plan_shifts for select to authenticated using (public.is_member(brewery_id));
create policy "plan: push" on public.plan_shifts for all to authenticated
  using (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule'))
  with check (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule'));

-- ---------- Which tables a backup may load into ----------
-- One list, so a new table only needs adding here (load_into_brewery reads it)
create function public.backup_tables() returns text[]
language sql immutable as $$
  select array[
    'locations', 'beers', 'tanks', 'tank_cleanings', 'batches', 'batch_events', 'beer_movements',
    'stock_places', 'package_types', 'package_counts', 'raw_items', 'raw_receipts', 'raw_adjustments',
    'recipes', 'recipe_ingredients', 'inventory_views', 'draft_lines', 'stock_pars', 'stock_moves',
    'cellar_entries', 'batch_additions', 'batch_readings', 'breweries', 'plan_items', 'beer_schedules',
    'plan_shifts'];
$$;

create or replace function public.load_into_brewery(p_brewery_id uuid, p_steps jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  allowed constant text[] := public.backup_tables();
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
