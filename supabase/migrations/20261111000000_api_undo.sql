-- API writes, step 3: undo a key's change from the activity list (docs/api-writes-design.md).
--
-- Undo runs as the person tapping it (security invoker: their permissions apply, as in the app),
-- in one step: the change is undone and the activity list says so, or nothing happens.
--   - a record the key added that the app can also remove: removed (a cellar log entry, an addition,
--     an acid cycle, a calendar item, a raw material delivery)
--   - a change the key made to a tank's status, a beer, or a draft line: put back as it was, but only
--     if nobody has changed it since (otherwise undo would quietly erase their change)
--   - volumes and stock (batches, transfers, packaging, level checks, moves, counts): not undone here.
--     They're corrected the way the app corrects them, with a correcting record, so history is kept.

-- Which changes can be undone (the app shows Undo only on these)
create function public.api_action_undoable(p_method text, p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select (p_method = 'POST' and (p_path ~ '^batches/[^/]+/(log|additions)$' or p_path ~ '^tanks/[^/]+/acid$'
                                 or p_path in ('plan', 'raw/receipts')))
      or (p_method = 'PATCH' and p_path ~ '^(tanks|beers)/[^/]+$')
      or (p_method = 'PUT' and p_path ~ '^lines/[^/]+/[0-9]+$');
$$;
alter table public.api_actions add column undoable boolean generated always as (public.api_action_undoable(method, path)) stored;

-- Marked undone (only from undo_api_action below)
create function public.mark_api_action_undone(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('brewery_os.undoing', true), '') <> p_id::text then
    raise exception using errcode = '42501', message = 'Only undo marks a change undone.';
  end if;
  update public.api_actions set status = 'undone', decided_by = auth.uid(), decided_at = now()
   where id = p_id and status in ('done', 'approved');
end;
$$;
revoke execute on function public.mark_api_action_undone(uuid) from public, anon;
grant execute on function public.mark_api_action_undone(uuid) to authenticated;

create function public.undo_api_action(p_id uuid) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  a      public.api_actions;
  r      jsonb;
  was    jsonb;
  now_   jsonb;
  target uuid;
  gone   integer;
  row_   jsonb;
begin
  if public.api_key_permissions() is not null then
    raise exception using errcode = '42501', message = 'A key can''t undo changes; a person does, in the app.';
  end if;
  select * into a from public.api_actions where id = p_id;   -- (only people in the brewery can see it)
  if not found then
    raise exception using errcode = '42501', message = 'That change isn''t in your brewery.';
  end if;
  if a.status not in ('done', 'approved') then
    raise exception 'That change was % (there''s nothing to undo).', a.status;
  end if;
  if not a.undoable then
    raise exception 'Volumes and stock aren''t undone here: correct them the way the app does (a level check, a count, or a correcting move), so the history is kept.';
  end if;
  r := a.result;
  target := nullif(r ->> 'id', '')::uuid;

  -- Records the key added: removed (under the same rules as removing them in the app)
  if a.method = 'POST' then
    if a.path ~ '/log$' then delete from public.cellar_entries where id = target;
    elsif a.path ~ '/additions$' then delete from public.batch_additions where id = target;
    elsif a.path ~ '/acid$' then delete from public.tank_cleanings where id = target;
    elsif a.path = 'plan' then delete from public.plan_items where id = target;
    elsif a.path = 'raw/receipts' then delete from public.raw_receipts where id = target;
    end if;
    get diagnostics gone = row_count;
    if gone = 0 then
      raise exception using errcode = '42501', message = 'It''s already gone, or you can''t remove it (the same rule as in the app).';
    end if;

  -- Changes the key made: put back, unless changed since
  else
    was := r -> 'was';
    now_ := r -> 'now';
    if was is null or now_ is null then
      raise exception 'This change was made before undo existed, so what it replaced isn''t known. Change it back by hand.';
    end if;
    if a.path ~ '^tanks/' then
      if (select status from public.tanks where id = target) is distinct from now_ ->> 'status' then
        raise exception 'The tank''s status has been changed since, so undo would erase that. Change it by hand if needed.';
      end if;
      update public.tanks set status = was ->> 'status' where id = target;
    elsif a.path ~ '^beers/' then
      select to_jsonb(b) into row_ from public.beers b where id = target;
      if exists (select 1 from jsonb_object_keys(now_) k where row_ -> k is distinct from now_ -> k) then
        raise exception 'The beer has been changed since, so undo would erase that. Change it by hand if needed.';
      end if;
      update public.beers set
        style            = case when was ? 'style' then was ->> 'style' else style end,
        target_og        = case when was ? 'target_og' then (was ->> 'target_og')::numeric else target_og end,
        target_fg        = case when was ? 'target_fg' then (was ->> 'target_fg')::numeric else target_fg end,
        menu_short       = case when was ? 'menu_short' then was ->> 'menu_short' else menu_short end,
        menu_description = case when was ? 'menu_description' then was ->> 'menu_description' else menu_description end,
        menu_abv         = case when was ? 'menu_abv' then (was ->> 'menu_abv')::numeric else menu_abv end,
        menu_ibu         = case when was ? 'menu_ibu' then (was ->> 'menu_ibu')::numeric else menu_ibu end,
        menu_srm         = case when was ? 'menu_srm' then (was ->> 'menu_srm')::numeric else menu_srm end,
        menu_public      = case when was ? 'menu_public' then (was ->> 'menu_public')::boolean else menu_public end,
        menu_section     = case when was ? 'menu_section' then was ->> 'menu_section' else menu_section end,
        menu_tags        = case when was ? 'menu_tags' then array(select jsonb_array_elements_text(coalesce(was -> 'menu_tags', '[]'))) else menu_tags end,
        menu_prices      = case when was ? 'menu_prices' then coalesce(was -> 'menu_prices', '[]') else menu_prices end
       where id = target;
    elsif a.path ~ '^lines/' then
      select to_jsonb(l) into row_ from (select status, beer_id, label from public.draft_lines
                                          where place_id = (r ->> 'place_id')::uuid and line_no = (r ->> 'line')::int) l;
      if row_ is distinct from now_ then
        raise exception 'The line has been changed since, so undo would erase that. Change it by hand if needed.';
      end if;
      if was = 'null'::jsonb then
        delete from public.draft_lines where place_id = (r ->> 'place_id')::uuid and line_no = (r ->> 'line')::int;
      else
        update public.draft_lines set status = was ->> 'status', beer_id = (was ->> 'beer_id')::uuid, label = coalesce(was ->> 'label', '')
         where place_id = (r ->> 'place_id')::uuid and line_no = (r ->> 'line')::int;
      end if;
    end if;
    get diagnostics gone = row_count;
    if gone = 0 then
      raise exception using errcode = '42501', message = 'You can''t change that back (the same rule as in the app).';
    end if;
  end if;

  perform set_config('brewery_os.undoing', p_id::text, true);
  perform public.mark_api_action_undone(p_id);
  perform set_config('brewery_os.undoing', '', true);
  return a.summary;
end;
$$;
revoke execute on function public.undo_api_action(uuid) from public, anon;
grant execute on function public.undo_api_action(uuid) to authenticated;
