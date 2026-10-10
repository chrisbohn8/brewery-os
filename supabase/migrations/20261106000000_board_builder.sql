-- Menu boards, step 3a: the board builder (docs/menu-board-design.md).
--
-- A taproom can have several boards ("TV 1: drafts", "TV 2: cans to go", "The website menu"),
-- each with its own links, layout, what each beer shows (and in what order), section order,
-- colors, and fonts. The look is kept as settings, and board.js draws it: nothing is free-form,
-- so every combination still reads well.
--
--   name           what the brewery calls this board ("" = "Menu board")
--   layout         list | columns | cards | compact
--   parts          what each beer shows, in order: ["number", "color", "name", "style", "abv", "ibu",
--                  "tags", "words", "fields", "prices"] (any left out are hidden; the name is always shown)
--   section_order  the sections' ids in this board's order ([] = the brewery's order)
--   theme          {"scheme": "auto" | "dark" | "light" | "chalkboard" | ... | "custom",
--                   "bg", "text", "accent": "#rrggbb" (custom only), "head", "body": a font name ("" = the usual)}
--   show_on_tap    the draft lines (off for a board that's only "To go")

alter table public.menu_boards drop constraint menu_boards_place_id_key;
create index menu_boards_place on public.menu_boards (place_id);

alter table public.menu_boards
  add column name text not null default '' check (length(name) <= 60),
  add column layout text not null default 'list' check (layout in ('list', 'columns', 'cards', 'compact')),
  add column parts jsonb not null default '["number", "color", "name", "style", "abv", "ibu", "tags", "words", "fields", "prices"]'
    check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) <= 20),
  add column section_order jsonb not null default '[]' check (jsonb_typeof(section_order) = 'array' and jsonb_array_length(section_order) <= 100),
  add column theme jsonb not null default '{"scheme": "auto"}' check (jsonb_typeof(theme) = 'object' and length(theme::text) <= 1000),
  add column show_on_tap boolean not null default true;

-- The app saves a board's settings (the links stay with set_menu_board_link_for below)
grant insert (id, name, layout, parts, section_order, theme, show_on_tap) on public.menu_boards to authenticated;
grant update (name, layout, parts, section_order, theme, show_on_tap) on public.menu_boards to authenticated;
create policy "remove boards" on public.menu_boards for delete to authenticated using (public.has_permission(brewery_id, 'inventory'));
grant delete on public.menu_boards to authenticated;

-- Make (or replace) one board's TV or public link, or turn it off. Returns the new link's secret.
create function public.set_menu_board_link_for(p_board_id uuid, p_kind text, p_on boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  b     uuid;
  token text;
begin
  select brewery_id into b from public.menu_boards where id = p_board_id;
  if b is null then
    raise exception using errcode = '42501', message = 'That board isn''t in this brewery.';
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
  if p_kind = 'tv' then
    update public.menu_boards set tv_token = token where id = p_board_id;
  else
    update public.menu_boards set public_token = token where id = p_board_id;
  end if;
  return token;
end;
$$;
revoke execute on function public.set_menu_board_link_for(uuid, text, boolean) from public, anon;
grant execute on function public.set_menu_board_link_for(uuid, text, boolean) to authenticated;

-- The step-2 way (one board per taproom) still works for an app that hasn't updated yet: it acts
-- on the taproom's first board, making one if there's none.
create or replace function public.set_menu_board_link(p_place_id uuid, p_kind text, p_on boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  b     uuid;
  board uuid;
begin
  select brewery_id into b from public.stock_places where id = p_place_id and kind = 'taproom';
  if b is null then
    raise exception using errcode = '42501', message = 'That isn''t a taproom in this brewery.';
  end if;
  perform public.require_permission(b, 'inventory', 'make or turn off menu board links');
  select id into board from public.menu_boards where place_id = p_place_id order by created_at, id limit 1;
  if board is null then
    insert into public.menu_boards (brewery_id, place_id) values (b, p_place_id) returning id into board;
  end if;
  return public.set_menu_board_link_for(board, p_kind, p_on);
end;
$$;

-- ---------- What a board shows ----------
-- The menu itself (lines, coming soon, to go) is worked out as before, for one taproom; a board
-- adds its own settings. Coming soon and to go are worked out only when the board shows them
-- (the preview asks for both, so the builder can switch them on and off without asking again).
create function public.menu_board_content(p_place_id uuid, p_public boolean, p_soon boolean, p_to_go boolean) returns jsonb
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

-- A board's own settings, as board.js reads them
create function public.menu_board_settings(bd public.menu_boards) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('name', bd.name, 'layout', bd.layout, 'parts', bd.parts, 'section_order', bd.section_order,
           'theme', bd.theme, 'show_on_tap', bd.show_on_tap, 'show_coming_soon', bd.show_coming_soon, 'show_to_go', bd.show_to_go);
$$;
revoke execute on function public.menu_board_settings(public.menu_boards) from public, anon, authenticated;

-- One board, everything board.js draws (step 2's menu_board_json, now for a board)
create or replace function public.menu_board_json(p_place_id uuid, p_public boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  bd public.menu_boards;
begin
  select * into bd from public.menu_boards where place_id = p_place_id order by created_at, id limit 1;
  return public.menu_board_content(p_place_id, p_public, coalesce(bd.show_coming_soon, true), coalesce(bd.show_to_go, false))
    || jsonb_build_object('title', coalesce(nullif(trim(bd.title), ''), (select name from public.stock_places where id = p_place_id)),
                          'order', coalesce(bd.order_by, 'lines'),
                          'board', case when bd.id is null then null else public.menu_board_settings(bd) end);
end;
$$;

-- A board from its link (TV and public pages, no sign-in). A link turned off or replaced returns nothing.
create or replace function public.menu_board_data(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  bd public.menu_boards;
  pub boolean;
begin
  if p_token is null or length(p_token) < 20 then
    return null;
  end if;
  select * into bd from public.menu_boards where tv_token = p_token or public_token = p_token;
  if not found then
    return null;
  end if;
  pub := coalesce(bd.public_token = p_token, false);
  return public.menu_board_content(bd.place_id, pub, bd.show_coming_soon, bd.show_to_go)
    || jsonb_build_object('title', coalesce(nullif(trim(bd.title), ''), (select name from public.stock_places where id = bd.place_id)),
                          'order', bd.order_by, 'board', public.menu_board_settings(bd));
end;
$$;

-- The builder's preview and print (signed in): the taproom's menu with coming soon and to go
-- both worked out, so switching them on and off needs no new request. The app adds the board's
-- settings as they're being edited.
create function public.menu_board_preview_content(p_place_id uuid, p_public boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_member((select brewery_id from public.stock_places where id = p_place_id)) then
    raise exception using errcode = '42501', message = 'You''re not part of that brewery.';
  end if;
  return public.menu_board_content(p_place_id, coalesce(p_public, false), true, true);
end;
$$;
revoke execute on function public.menu_board_preview_content(uuid, boolean) from public, anon;
grant execute on function public.menu_board_preview_content(uuid, boolean) to authenticated;
