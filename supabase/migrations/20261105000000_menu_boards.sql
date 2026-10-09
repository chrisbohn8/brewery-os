-- Menu boards, step 2: one good board per taproom (docs/menu-board-design.md).
--
-- A taproom's board is built from its draft lines and each beer's menu details: the same records as
-- the rest of the app, so it can't disagree with the lines. Shown three ways:
--   TV      a private link that fills the screen and updates on its own (no sign-in)
--   public  a link for the brewery's website and social posts: only menu details, and never the
--           beers marked "leave off the public menu"
--   print   from the app (signed in)
-- Each link can be turned off, or replaced (making a new one stops the old one at once). Unlike
-- calendar links, a board's links stay readable in the app: a TV gets set up again, a website
-- needs the link, and a board shows nothing that isn't on the menu anyway.
--
-- Who: anyone with "Count and move finished goods" (inventory) runs the boards; anyone in the
-- brewery can see them.

create table public.menu_boards (
  id                uuid primary key default gen_random_uuid(),
  brewery_id        uuid not null references public.breweries on delete cascade,
  place_id          uuid not null unique,
  title             text not null default '' check (length(title) <= 80),   -- empty = the taproom's name
  order_by          text not null default 'lines' check (order_by in ('lines', 'sections')),
  show_coming_soon  boolean not null default true,    -- kegs in storage not here yet
  show_to_go        boolean not null default false,   -- cases and singles on hand here
  tv_token          text unique,                      -- null = no TV link
  public_token      text unique,                      -- null = no public link
  created_at        timestamptz not null default now(),
  foreign key (brewery_id, place_id) references public.stock_places (brewery_id, id) on delete cascade
);
alter table public.menu_boards enable row level security;
create policy "members read" on public.menu_boards for select to authenticated using (public.is_member(brewery_id));
create policy "run boards" on public.menu_boards for insert to authenticated with check (public.has_permission(brewery_id, 'inventory'));
create policy "change boards" on public.menu_boards for update to authenticated
  using (public.has_permission(brewery_id, 'inventory')) with check (public.has_permission(brewery_id, 'inventory'));
-- The links are only made and turned off by set_menu_board_link below
revoke all on public.menu_boards from anon;
revoke insert, update on public.menu_boards from authenticated;
grant insert (brewery_id, place_id, title, order_by, show_coming_soon, show_to_go) on public.menu_boards to authenticated;
-- (brewery and place too, so the app can save a board's settings in one step, "add or update";
-- the rules above still check the brewery's inventory permission, and a board stays with its taproom)
grant update (brewery_id, place_id, title, order_by, show_coming_soon, show_to_go) on public.menu_boards to authenticated;

-- Make (or replace) a board's TV or public link, or turn it off (p_on = false). Returns the new link's secret.
create function public.set_menu_board_link(p_place_id uuid, p_kind text, p_on boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  b     uuid;
  token text;
begin
  select brewery_id into b from public.stock_places where id = p_place_id and kind = 'taproom';
  if b is null then
    raise exception using errcode = '42501', message = 'That isn''t a taproom in this brewery.';
  end if;
  perform public.require_permission(b, 'inventory', 'make or turn off menu board links');
  if public.api_key_permissions() is not null then
    raise exception using errcode = '42501', message = 'An API key can''t make menu board links.';
  end if;
  if p_kind not in ('tv', 'public') then
    raise exception 'A board''s link is "tv" or "public".';
  end if;
  if p_on then
    token := p_kind || '_' || encode(extensions.gen_random_bytes(18), 'hex');
  end if;
  insert into public.menu_boards (brewery_id, place_id) values (b, p_place_id) on conflict (place_id) do nothing;
  if p_kind = 'tv' then
    update public.menu_boards set tv_token = token where place_id = p_place_id;
  else
    update public.menu_boards set public_token = token where place_id = p_place_id;
  end if;
  return token;
end;
$$;
revoke execute on function public.set_menu_board_link(uuid, text, boolean) from public, anon;
grant execute on function public.set_menu_board_link(uuid, text, boolean) to authenticated;

-- ---------- What a board shows ----------
-- One taproom's menu, everything a board draws (board.js), with each price already the one for
-- this taproom. p_public leaves off the beers marked "leave off the public menu". Not callable on
-- its own: menu_board_data (a link) and menu_board_preview (signed in) call it.
create function public.menu_board_json(p_place_id uuid, p_public boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pl     public.stock_places;
  br     public.breweries;
  bd     public.menu_boards;
  lines  jsonb;
  soon   jsonb := '[]';
  to_go  jsonb := '[]';
begin
  select * into pl from public.stock_places where id = p_place_id and kind = 'taproom';
  if not found then
    return null;
  end if;
  select * into br from public.breweries where id = pl.brewery_id;
  select * into bd from public.menu_boards where place_id = p_place_id;

  -- Lines pouring a beer or something else, in line order (empty and out-of-order lines aren't on a menu)
  select coalesce(jsonb_agg(jsonb_build_object(
           'no', d.line_no, 'kind', d.status, 'label', d.label,
           'beer', case when d.status = 'beer' then jsonb_build_object(
             'name', be.name, 'style', be.style, 'abv', be.menu_abv, 'ibu', be.menu_ibu, 'srm', be.menu_srm,
             'short', be.menu_short, 'description', be.menu_description, 'section', be.menu_section,
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
  if coalesce(bd.show_coming_soon, true) then
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
  if coalesce(bd.show_to_go, false) then
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
    'brewery', br.name, 'taproom', pl.name, 'title', coalesce(nullif(trim(bd.title), ''), pl.name),
    'order', coalesce(bd.order_by, 'lines'), 'public', p_public,
    'sizes', (select coalesce(jsonb_agg(jsonb_build_object('id', s ->> 'id', 'name', s ->> 'name') order by o), '[]')
                from jsonb_array_elements(br.menu_sizes) with ordinality x(s, o)),
    'sections', (select coalesce(jsonb_agg(jsonb_build_object('id', s ->> 'id', 'name', s ->> 'name') order by o), '[]')
                   from jsonb_array_elements(br.menu_sections) with ordinality x(s, o)),
    'lines', lines, 'coming_soon', soon, 'to_go', to_go, 'at', now());
end;
$$;
revoke execute on function public.menu_board_json(uuid, boolean) from public, anon, authenticated;

-- A board from its link: the TV page and the public page call this without signing in. A link
-- that's been turned off or replaced returns nothing.
create function public.menu_board_data(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  bd public.menu_boards;
begin
  if p_token is null or length(p_token) < 20 then
    return null;
  end if;
  select * into bd from public.menu_boards where tv_token = p_token or public_token = p_token;
  if not found then
    return null;
  end if;
  return public.menu_board_json(bd.place_id, coalesce(bd.public_token = p_token, false)); -- (no public link: the TV's)
end;
$$;
revoke execute on function public.menu_board_data(text) from public;
grant execute on function public.menu_board_data(text) to anon, authenticated;

-- A board as the app shows it (preview and print), for anyone in the brewery
create function public.menu_board_preview(p_place_id uuid, p_public boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_member((select brewery_id from public.stock_places where id = p_place_id)) then
    raise exception using errcode = '42501', message = 'You''re not part of that brewery.';
  end if;
  return public.menu_board_json(p_place_id, coalesce(p_public, false));
end;
$$;
revoke execute on function public.menu_board_preview(uuid, boolean) from public, anon;
grant execute on function public.menu_board_preview(uuid, boolean) to authenticated;

-- Backups bring back each board's settings (not its links: those are made again)
create or replace function public.backup_tables() returns text[]
language sql immutable as $$
  select array[
    'locations', 'beers', 'tanks', 'tank_cleanings', 'batches', 'batch_events', 'beer_movements',
    'stock_places', 'package_types', 'package_counts', 'raw_items', 'raw_receipts', 'raw_adjustments',
    'recipes', 'recipe_ingredients', 'inventory_views', 'draft_lines', 'stock_pars', 'stock_moves',
    'cellar_entries', 'batch_additions', 'batch_readings', 'breweries', 'plan_items', 'beer_schedules',
    'plan_shifts', 'raw_orders', 'shortfall_dismissals', 'menu_boards'];
$$;
