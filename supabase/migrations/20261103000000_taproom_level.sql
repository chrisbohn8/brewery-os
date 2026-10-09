-- A Taproom level (the user's idea, 2026-10-08), and menu details on beers.
--
-- A taproom manager keeps the taproom side: finished goods (counts, moves, pars, draft lines) and
-- the beer menu (descriptions, ABV and IBU, prices), but nothing on the brewhouse side: batches,
-- tanks, recipes, brew sheets, or raw materials. For that, two permissions split off:
--   raw_materials  receive, count, and order raw materials; set up raw material items
--                  (was part of "inventory", which is now finished goods only)
--   menu           a beer's menu details (and only those; "Beers and recipes" covers the rest)
-- Every level that could keep inventory keeps raw materials too, so nobody loses anything.

create or replace function public.permission_list() returns text[]
language sql immutable as $$
  select array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'raw_materials', 'start_batch',
               'manage_beers', 'menu', 'manage_equipment', 'manage_cleaning', 'manage_settings',
               'rename_brewery', 'backups', 'delete_records', 'plan_schedule', 'move_schedule'];
$$;
create or replace function public.default_permissions(level text) returns text[]
language sql immutable as $$
  select case level
    when 'taproom'     then array['inventory', 'menu']
    when 'cellar'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'raw_materials']
    when 'brewer'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'raw_materials',
                                  'start_batch', 'move_schedule']
    when 'head_brewer' then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'raw_materials',
                                  'start_batch', 'manage_beers', 'menu', 'manage_equipment', 'manage_cleaning', 'manage_settings',
                                  'plan_schedule', 'move_schedule']
    when 'admin'       then public.permission_list()
    else array[]::text[]  -- viewer: look only
  end;
$$;
-- A brewery that changed a level: whoever kept inventory keeps raw materials; whoever sets up beers sets their menu
update public.role_levels set permissions = permissions || array['raw_materials']
 where 'inventory' = any(permissions) and not 'raw_materials' = any(permissions);
update public.role_levels set permissions = permissions || array['menu']
 where 'manage_beers' = any(permissions) and not 'menu' = any(permissions);
-- ...and the same for one person's own adjustments
update public.memberships set grants = grants || array['raw_materials'] where 'inventory' = any(grants) and not 'raw_materials' = any(grants);
update public.memberships set revokes = revokes || array['raw_materials'] where 'inventory' = any(revokes) and not 'raw_materials' = any(revokes);
-- ...and API keys (a key keeps what it could do)
update public.api_keys set permissions = permissions || array['raw_materials'] where 'inventory' = any(permissions) and not 'raw_materials' = any(permissions);
update public.api_keys set permissions = permissions || array['menu'] where 'manage_beers' = any(permissions) and not 'menu' = any(permissions);

-- The new level
alter table public.memberships drop constraint memberships_role_check;
alter table public.memberships add constraint memberships_role_check check (role in ('viewer', 'taproom', 'cellar', 'brewer', 'head_brewer', 'admin'));
alter table public.invites drop constraint invites_role_check;
alter table public.invites add constraint invites_role_check check (role in ('viewer', 'taproom', 'cellar', 'brewer', 'head_brewer', 'admin'));
alter table public.role_levels drop constraint role_levels_level_check;
alter table public.role_levels add constraint role_levels_level_check check (level in ('viewer', 'taproom', 'cellar', 'brewer', 'head_brewer'));

-- ---------- Raw materials: their own permission ----------
drop policy "manage items" on public.raw_items;
create policy "manage items" on public.raw_items for all to authenticated
  using (public.has_permission(brewery_id, 'raw_materials')) with check (public.has_permission(brewery_id, 'raw_materials'));
drop policy "receive" on public.raw_receipts;
create policy "receive" on public.raw_receipts for insert to authenticated with check (public.has_permission(brewery_id, 'raw_materials'));
drop policy "fix receipts" on public.raw_receipts;
create policy "fix receipts" on public.raw_receipts for update to authenticated
  using (public.has_permission(brewery_id, 'raw_materials')) with check (public.has_permission(brewery_id, 'raw_materials'));
drop policy "count" on public.raw_adjustments;
create policy "count" on public.raw_adjustments for insert to authenticated with check (public.has_permission(brewery_id, 'raw_materials'));
drop policy "orders" on public.raw_orders;
create policy "orders" on public.raw_orders for all to authenticated
  using (public.has_permission(brewery_id, 'raw_materials')) with check (public.has_permission(brewery_id, 'raw_materials'));
drop policy "dismiss" on public.shortfall_dismissals;
create policy "dismiss" on public.shortfall_dismissals for all to authenticated
  using (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule') or public.has_permission(brewery_id, 'raw_materials'))
  with check (public.has_permission(brewery_id, 'plan_schedule') or public.has_permission(brewery_id, 'move_schedule') or public.has_permission(brewery_id, 'raw_materials'));

-- ---------- Menu details on beers ----------
-- What the taproom's menu shows. ABV and IBU are the menu's, typed (or filled in from the latest
-- batch and the recipe, for a person to confirm), never worked out behind anyone's back.
-- Prices: [{"size": "16 oz", "price": 7}, {"size": "Flight", "price": 12}]
alter table public.beers
  add column menu_description text not null default '' check (length(menu_description) <= 600),
  add column menu_abv numeric check (menu_abv between 0 and 25),
  add column menu_ibu numeric check (menu_ibu between 0 and 200),
  add column menu_prices jsonb not null default '[]' check (jsonb_typeof(menu_prices) = 'array');

create policy "menu details" on public.beers for update to authenticated
  using (public.has_permission(brewery_id, 'menu')) with check (public.has_permission(brewery_id, 'menu'));

-- Someone who can only set menu details can change those, and nothing else about a beer; and the
-- other way around: the menu details need their own permission
-- (everything but the menu columns must stay the same, so a column added later is covered too)
create function public.check_beer_change() returns trigger
language plpgsql set search_path = '' as $$
declare
  menu constant text[] := array['menu_description', 'menu_abv', 'menu_ibu', 'menu_prices'];
begin
  if auth.uid() is not null and not public.has_permission(old.brewery_id, 'manage_beers')
     and (to_jsonb(new) - menu) is distinct from (to_jsonb(old) - menu) then
    raise exception 'You can change a beer''s menu details, but not the beer itself.' using errcode = '42501';
  end if;
  if auth.uid() is not null and not public.has_permission(old.brewery_id, 'menu')
     and (new.menu_description, new.menu_abv, new.menu_ibu, new.menu_prices)
         is distinct from (old.menu_description, old.menu_abv, old.menu_ibu, old.menu_prices) then
    raise exception 'You can change the beer, but not its menu details.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger check_beer_change before update on public.beers
  for each row execute function public.check_beer_change();
