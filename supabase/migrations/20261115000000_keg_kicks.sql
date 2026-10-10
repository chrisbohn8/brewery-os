-- Kicked kegs and "Almost gone" (docs/keg-design.md, step 1).
--
-- A kicked keg is logged from its draft line: which taproom and line, the beer (or what else was
-- pouring), the keg's size, and the day. It's a log, like the brewery's monthly kicked-keg sheet:
-- it doesn't change stock (counts do that), so the two can never fight. A month's kicks add up per
-- beer and size.
--
-- "Almost gone" on a menu board (the user's rule): a beer on tap is almost gone when no storage
-- place has a keg of it left, however many are still in the taproom. Beers never kept in storage
-- in kegs (so the app can't know) are never marked.

create table public.keg_kicks (
  id               uuid primary key default gen_random_uuid(),
  brewery_id       uuid not null references public.breweries on delete cascade,
  place_id         uuid not null,
  line_no          integer check (line_no between 1 and 200),
  beer_id          uuid,
  label            text not null default '' check (length(label) <= 60),   -- what else was pouring (a guest beer, cider)
  package_type_id  uuid,
  kicked_on        date not null,
  recorded_by      uuid default auth.uid() references auth.users on delete set null,
  recorded_at      timestamptz not null default now(),
  via_key          uuid references public.api_keys on delete set null,
  check (beer_id is not null or length(trim(label)) > 0),
  foreign key (brewery_id, place_id) references public.stock_places (brewery_id, id) on delete cascade,
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id) on delete cascade,
  foreign key (brewery_id, package_type_id) references public.package_types (brewery_id, id)
);
create index keg_kicks_brewery on public.keg_kicks (brewery_id, kicked_on);
alter table public.keg_kicks enable row level security;
create policy "members read" on public.keg_kicks for select to authenticated using (public.is_member(brewery_id));
-- Logged with kick_keg below; written directly only when loading a backup. A mistake is removed.
create policy "log kicks" on public.keg_kicks for insert to authenticated with check (public.has_permission(brewery_id, 'inventory'));
create policy "remove kicks" on public.keg_kicks for delete to authenticated using (public.has_permission(brewery_id, 'inventory'));
create trigger stamp_via_key before insert on public.keg_kicks for each row execute function public.stamp_via_key();

-- A keg kicked on a line. Then the line pours the next keg of the same thing ('same'), or is empty
-- ('empty'). (Something new on the line is the line's own change, after this.) Safe to repeat.
create function public.kick_keg(p_id uuid, p_line_id uuid, p_date date, p_type uuid, p_then text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  l public.draft_lines;
begin
  select * into l from public.draft_lines where id = p_line_id;
  if not found then
    raise exception using errcode = '42501', message = 'That line isn''t in your brewery.';
  end if;
  perform public.require_permission(l.brewery_id, 'inventory', 'log a kicked keg');
  if exists (select 1 from public.keg_kicks where id = p_id) then
    return; -- already saved
  end if;
  if l.status not in ('beer', 'other') then
    raise exception 'Nothing is pouring on line % (it''s %).', l.line_no, l.status;
  end if;
  if p_type is not null and not exists (select 1 from public.package_types where id = p_type and brewery_id = l.brewery_id) then
    raise exception using errcode = '42501', message = 'That keg size isn''t in this brewery.';
  end if;
  if coalesce(p_then, 'same') not in ('same', 'empty') then
    raise exception 'After a kick, the line pours the next keg (same) or is empty.';
  end if;
  insert into public.keg_kicks (id, brewery_id, place_id, line_no, beer_id, label, package_type_id, kicked_on)
  values (p_id, l.brewery_id, l.place_id, l.line_no, l.beer_id, case when l.status = 'other' then l.label else '' end, p_type,
          coalesce(p_date, (now() at time zone (select time_zone from public.breweries where id = l.brewery_id))::date));
  if p_then = 'empty' then
    update public.draft_lines set status = 'empty', beer_id = null, label = '' where id = p_line_id;
  end if;
end;
$$;
revoke execute on function public.kick_keg(uuid, uuid, date, uuid, text) from public, anon;
grant execute on function public.kick_keg(uuid, uuid, date, uuid, text) to authenticated;

-- Almost gone: kegs of it have been in storage, and none are left in any storage place
create function public.beer_almost_gone(p_beer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stock_moves m join public.stock_places sp on sp.id = m.to_place_id
                   join public.package_types pt on pt.id = m.package_type_id
                  where m.beer_id = p_beer and sp.kind = 'storage' and pt.kind in ('keg', 'cask'))
     and not exists (select 1 from public.stock_on_hand h join public.stock_places sp on sp.id = h.place_id
                       join public.package_types pt on pt.id = h.package_type_id
                      where h.beer_id = p_beer and h.count > 0 and sp.kind = 'storage' and sp.active and pt.kind in ('keg', 'cask'));
$$;
revoke execute on function public.beer_almost_gone(uuid) from public, anon, authenticated;

-- What a board shows: each beer now says whether it's almost gone (board.js shows it when the board's
-- parts include "almost"; new boards do)
alter table public.menu_boards alter column parts
  set default '["number", "color", "name", "almost", "style", "abv", "ibu", "tags", "words", "fields", "prices"]';

create or replace function public.menu_board_content(p_place_id uuid, p_public boolean, p_soon boolean, p_to_go boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pl     public.stock_places;
  br     public.breweries;
  lines  jsonb;
  soon   jsonb := '[]';
  to_go  jsonb := '[]';
begin
  select * into pl from public.stock_places where id = p_place_id and kind = 'taproom';
  if not found then
    return null;
  end if;
  select * into br from public.breweries where id = pl.brewery_id;

  -- Lines pouring a beer or something else (each beer says whether it's almost gone), in line order (empty and out-of-order lines aren't on a menu)
  select coalesce(jsonb_agg(jsonb_build_object(
           'no', d.line_no, 'kind', d.status, 'label', d.label,
           'beer', case when d.status = 'beer' then jsonb_build_object(
             'name', be.name, 'style', be.style, 'abv', be.menu_abv, 'ibu', be.menu_ibu, 'srm', be.menu_srm,
             'short', be.menu_short, 'description', be.menu_description, 'section', be.menu_section,
             'almost_gone', public.beer_almost_gone(be.id),
             'tags', (select coalesce(jsonb_agg(jsonb_build_object('name', t ->> 'name', 'kind', coalesce(t ->> 'kind', 'badge')) order by o), '[]')
                        from jsonb_array_elements(br.menu_tags) with ordinality x(t, o) where t ->> 'id' = any (be.menu_tags)),
             'fields', (select coalesce(jsonb_agg(jsonb_build_object('name', f ->> 'name',
                                'value', case when be.menu_extra -> (f ->> 'id') = 'true'::jsonb then '"Yes"'::jsonb else be.menu_extra -> (f ->> 'id') end) order by o), '[]')
                          from jsonb_array_elements(br.menu_fields) with ordinality x(f, o) where be.menu_extra ? (f ->> 'id')),
             -- Each pour size's price: this taproom's own, or else the usual one
             'prices', (select coalesce(jsonb_agg(jsonb_build_object('size', s ->> 'id',
                                'price', coalesce((p -> 'at' ->> p_place_id::text)::numeric, (p ->> 'price')::numeric)) order by o), '[]')
                          from jsonb_array_elements(br.menu_sizes) with ordinality x(s, o)
                          join jsonb_array_elements(be.menu_prices) p on p ->> 'size' = s ->> 'id')
           ) end) order by d.line_no), '[]')
    into lines
    from public.draft_lines d left join public.beers be on be.id = d.beer_id
   where d.place_id = p_place_id and d.status in ('beer', 'other')
     and (d.status = 'other' or be.id is not null)
     and not (p_public and d.status = 'beer' and not be.menu_public);

  -- Coming soon: beers in kegs in storage that aren't here yet (not on hand, not on a line)
  if p_soon then
    select coalesce(jsonb_agg(jsonb_build_object('name', be.name, 'style', be.style, 'abv', be.menu_abv, 'short', be.menu_short)
                              order by be.name), '[]')
      into soon
      from public.beers be
     where be.brewery_id = pl.brewery_id
       and (not p_public or be.menu_public)
       and exists (select 1 from public.stock_on_hand h join public.stock_places sp on sp.id = h.place_id
                     join public.package_types pt on pt.id = h.package_type_id
                    where h.beer_id = be.id and h.count > 0 and sp.kind = 'storage' and sp.active and pt.kind in ('keg', 'cask'))
       and not exists (select 1 from public.stock_on_hand h where h.beer_id = be.id and h.place_id = p_place_id and h.count > 0)
       and not exists (select 1 from public.draft_lines d where d.place_id = p_place_id and d.beer_id = be.id);
  end if;

  -- To go: cases and singles (cans, bottles) on hand at this taproom
  if p_to_go then
    select coalesce(jsonb_agg(x order by x ->> 'name'), '[]')
      into to_go
      from (select jsonb_build_object('name', be.name, 'style', be.style, 'abv', be.menu_abv,
                                      'packages', jsonb_agg(distinct pt.name)) as x
              from public.stock_on_hand h join public.package_types pt on pt.id = h.package_type_id
              join public.beers be on be.id = h.beer_id
             where h.place_id = p_place_id and h.count > 0 and pt.kind in ('case', 'single')
               and (not p_public or be.menu_public)
             group by be.id, be.name, be.style, be.menu_abv) y;
  end if;

  return jsonb_build_object(
    'brewery', br.name, 'taproom', pl.name, 'public', p_public,
    'sizes', (select coalesce(jsonb_agg(jsonb_build_object('id', s ->> 'id', 'name', s ->> 'name') order by o), '[]')
                from jsonb_array_elements(br.menu_sizes) with ordinality x(s, o)),
    'sections', (select coalesce(jsonb_agg(jsonb_build_object('id', s ->> 'id', 'name', s ->> 'name') order by o), '[]')
                   from jsonb_array_elements(br.menu_sections) with ordinality x(s, o)),
    'lines', lines, 'coming_soon', soon, 'to_go', to_go, 'at', now());
end;
$$;
revoke execute on function public.menu_board_content(uuid, boolean, boolean, boolean) from public, anon, authenticated;

-- API: POST /kicks logs a kicked keg (and can be undone: the kick is removed)
alter table public.api_actions drop column undoable;
create or replace function public.api_action_undoable(p_method text, p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select (p_method = 'POST' and (p_path ~ '^batches/[^/]+/(log|additions)$' or p_path ~ '^tanks/[^/]+/acid$'
                                 or p_path in ('plan', 'raw/receipts', 'raw/orders', 'recipes', 'kicks')))
      or (p_method = 'PATCH' and p_path ~ '^(tanks|beers)/[^/]+$')
      or (p_method = 'PUT' and p_path ~ '^lines/[^/]+/[0-9]+$');
$$;
alter table public.api_actions add column undoable boolean generated always as (public.api_action_undoable(method, path)) stored;

-- Undo: the kick is removed
create or replace function public.undo_api_action(p_id uuid) returns text
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
    raise exception 'Volumes, stock, brew-day sheet values, and raw material counts aren''t undone here: correct them the way the app does (a level check, a count, a correcting move, or a new value), so the history is kept.';
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
    elsif a.path = 'raw/orders' then delete from public.raw_orders where id = target;
    elsif a.path = 'recipes' then delete from public.recipes where id = target;   -- (its ingredients go with it)
    elsif a.path = 'kicks' then delete from public.keg_kicks where id = target;
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

-- Backups bring kicked kegs back too
create or replace function public.backup_tables() returns text[]
language sql immutable as $$
  select array[
    'locations', 'beers', 'tanks', 'tank_cleanings', 'batches', 'batch_events', 'beer_movements',
    'stock_places', 'package_types', 'package_counts', 'raw_items', 'raw_receipts', 'raw_adjustments',
    'recipes', 'recipe_ingredients', 'inventory_views', 'draft_lines', 'stock_pars', 'stock_moves',
    'cellar_entries', 'batch_additions', 'batch_readings', 'breweries', 'plan_items', 'beer_schedules',
    'plan_shifts', 'raw_orders', 'shortfall_dismissals', 'brewery_files', 'menu_boards', 'keg_kicks'];
$$;
