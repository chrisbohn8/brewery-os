-- Loading a backup (or the sample data) as ONE all-or-nothing step.
--
-- Before, the app loaded a backup table by table, about 20 separate saves, and if one failed
-- partway it tried to delete what it had already loaded: more separate steps, which a dropped
-- signal could also interrupt, leaving half a brewery behind. Now the app sends the whole load
-- in one request, and this function does it in one transaction: everything goes in, or nothing.
--
-- It runs as the person loading (security invoker), so the usual rules and permissions apply to
-- every row exactly as when the app saved them one table at a time.
--
-- The app prepares the load as a list of steps, in order:
--   { "insert": "tanks", "rows": [ {...}, ... ] }                  add rows
--   { "match": "raw_items", "keys": ["name"], "row": {...} }       use the brewery's own row with the
--                                                                  same name (and location), or add it
--   { "update": "stock_places", "id": "...", "set": {...} }        change one row
-- Rows use the database's column names, and the app has already given every record a fresh ID.
-- When a "match" finds the brewery's own row (say the Storage place every new location gets), the
-- record's ID is swapped for that row's ID in every later step, so links between records hold.

create function public.load_into_brewery(p_brewery_id uuid, p_steps jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  allowed constant text[] := array[
    'locations', 'beers', 'tanks', 'tank_cleanings', 'batches', 'batch_events', 'beer_movements',
    'stock_places', 'package_types', 'package_counts', 'raw_items', 'raw_receipts', 'raw_adjustments',
    'recipes', 'recipe_ingredients', 'inventory_views', 'draft_lines', 'stock_pars', 'stock_moves',
    'cellar_entries', 'batch_additions', 'batch_readings', 'breweries'];
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
revoke execute on function public.load_into_brewery(uuid, jsonb) from public, anon;
grant execute on function public.load_into_brewery(uuid, jsonb) to authenticated;
