-- Menu boards, step 3b: the brewery's own font files and logos (docs/menu-board-design.md).
--
-- Kept in the database itself (not a separate file store), so they're in every backup, nightly and
-- downloaded, like everything else, and follow the same rules. They're small: a font up to 500 KB,
-- a logo up to 300 KB, ten of each per brewery.
--
-- Fonts: only an Admin uploads one, since a font's license is the brewery's responsibility (the app
-- says so). A board uses an uploaded font by its name, like a Google Font's: theme.head / theme.body.
-- Logos: whoever runs the boards (inventory) uploads one; a board shows it with theme.logo (its id).
-- A file can't be changed, only removed (and uploaded again), so a copy kept on a TV is never stale.

create table public.brewery_files (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  kind        text not null check (kind in ('font', 'logo')),
  name        text not null check (name ~ '^[A-Za-z0-9 ]{1,40}$'),  -- a font's name on the board; a logo's label
  mime        text not null check (
                (kind = 'font' and mime in ('font/woff2', 'font/woff', 'font/ttf', 'font/otf'))
                or (kind = 'logo' and mime in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'))),
  data        text not null check (data ~ '^[A-Za-z0-9+/]+={0,2}$'),   -- the file, in base64
  bytes       integer not null check (bytes > 0 and bytes <= case when kind = 'font' then 512000 else 307200 end),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  check (length(data) = 4 * ceil(bytes / 3.0)),                        -- the size matches the file
  unique (brewery_id, id)
);
create unique index brewery_files_font_name on public.brewery_files (brewery_id, lower(name)) where kind = 'font';
create index brewery_files_brewery on public.brewery_files (brewery_id, kind);

alter table public.brewery_files enable row level security;
create policy "members read" on public.brewery_files for select to authenticated using (public.is_member(brewery_id));
create policy "upload" on public.brewery_files for insert to authenticated with check (
  case kind when 'font' then public.is_admin(brewery_id) else public.has_permission(brewery_id, 'inventory') end);
create policy "remove" on public.brewery_files for delete to authenticated using (
  case kind when 'font' then public.is_admin(brewery_id) else public.has_permission(brewery_id, 'inventory') end);
revoke all on public.brewery_files from anon;
revoke update on public.brewery_files from authenticated;

-- At most ten of each kind per brewery
create function public.check_brewery_file() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.brewery_files where brewery_id = new.brewery_id and kind = new.kind) >= 10 then
    raise exception 'A brewery can keep up to 10 %s. Remove one first.', case new.kind when 'font' then 'fonts' else 'logos' end
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger check_brewery_file before insert on public.brewery_files
  for each row execute function public.check_brewery_file();

-- ---------- What a board's page needs ----------
-- The files a board uses (its fonts by name, its logo by id): names and types only. Their contents
-- come one at a time from menu_board_file, and a TV keeps them.
create function public.menu_board_files(bd public.menu_boards) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'name', f.name, 'mime', f.mime) order by f.kind, f.name), '[]')
    from public.brewery_files f
   where f.brewery_id = bd.brewery_id
     and ((f.kind = 'font' and lower(f.name) in (lower(bd.theme ->> 'head'), lower(bd.theme ->> 'body')))
          or (f.kind = 'logo' and f.id::text = bd.theme ->> 'logo'));
$$;
revoke execute on function public.menu_board_files(public.menu_boards) from public, anon, authenticated;

-- A board from its link, now with its files' names
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
                          'order', bd.order_by, 'board', public.menu_board_settings(bd), 'files', public.menu_board_files(bd));
end;
$$;

-- One file a board uses, from the board's link (no sign-in). Only a file that board uses.
create function public.menu_board_file(p_token text, p_file_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  bd public.menu_boards;
begin
  if p_token is null or length(p_token) < 20 then
    return null;
  end if;
  select * into bd from public.menu_boards where tv_token = p_token or public_token = p_token;
  if not found or not exists (select 1 from jsonb_array_elements(public.menu_board_files(bd)) f where f ->> 'id' = p_file_id::text) then
    return null;
  end if;
  return (select jsonb_build_object('mime', mime, 'data', data) from public.brewery_files where id = p_file_id);
end;
$$;
revoke execute on function public.menu_board_file(text, uuid) from public;
grant execute on function public.menu_board_file(text, uuid) to anon, authenticated;

-- Backups bring back the files too (before the boards that use them)
create or replace function public.backup_tables() returns text[]
language sql immutable as $$
  select array[
    'locations', 'beers', 'tanks', 'tank_cleanings', 'batches', 'batch_events', 'beer_movements',
    'stock_places', 'package_types', 'package_counts', 'raw_items', 'raw_receipts', 'raw_adjustments',
    'recipes', 'recipe_ingredients', 'inventory_views', 'draft_lines', 'stock_pars', 'stock_moves',
    'cellar_entries', 'batch_additions', 'batch_readings', 'breweries', 'plan_items', 'beer_schedules',
    'plan_shifts', 'raw_orders', 'shortfall_dismissals', 'brewery_files', 'menu_boards'];
$$;
