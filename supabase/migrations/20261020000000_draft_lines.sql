-- Draft lines and the order beers are listed in (the user's idea, from their taproom sheets, which
-- are really tap lists in line order).
--
-- A taproom's draft lines: numbered, each pouring a beer, or something else (wine, cider, a guest
-- beer: just a label), or empty, or out of order. This is the current state of the bar (edited in
-- place), not a ledger.
create table public.draft_lines (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  place_id    uuid not null,
  line_no     integer not null check (line_no between 1 and 200),
  status      text not null default 'empty' check (status in ('beer', 'other', 'empty', 'out')),
  beer_id     uuid,
  label       text not null default '' check (length(label) <= 60),
  updated_by  uuid default auth.uid() references auth.users on delete set null,
  updated_at  timestamptz not null default now(),
  unique (place_id, line_no),
  check ((status = 'beer') = (beer_id is not null)),
  foreign key (brewery_id, place_id) references public.stock_places (brewery_id, id) on delete cascade,
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id) on delete set null (beer_id)
);
alter table public.draft_lines enable row level security;
create policy "members read" on public.draft_lines for select to authenticated using (public.is_member(brewery_id));
create policy "change lines" on public.draft_lines for all to authenticated
  using (public.has_permission(brewery_id, 'inventory')) with check (public.has_permission(brewery_id, 'inventory'));
create trigger stamp_line before update on public.draft_lines for each row execute function public.stamp_par();

-- How each place lists its beers: A-Z, oldest batch first, the place's own order, or its draft lines
alter table public.stock_places
  add column sort_mode text not null default 'az' check (sort_mode in ('az', 'oldest', 'custom', 'lines')),
  add column beer_order uuid[] not null default '{}';
update public.stock_places set sort_mode = 'lines' where kind = 'taproom';

-- Changing the order is part of keeping stock (the inventory permission), not of setting up
-- equipment, so it has its own small function rather than the places' setup rules.
create function public.set_place_order(p_place_id uuid, p_sort_mode text, p_beer_order uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
begin
  select brewery_id into b from public.stock_places where id = p_place_id;
  if b is null then
    raise exception using errcode = '42501', message = 'That place isn''t in this brewery.';
  end if;
  perform public.require_permission(b, 'inventory', 'change how a place lists its beers');
  update public.stock_places set sort_mode = coalesce(p_sort_mode, sort_mode), beer_order = coalesce(p_beer_order, beer_order)
   where id = p_place_id;
end;
$$;
revoke execute on function public.set_place_order(uuid, text, uuid[]) from public, anon;
grant execute on function public.set_place_order(uuid, text, uuid[]) to authenticated;

-- New taproom places list their beers by draft line, unless told otherwise
create function public.taproom_sort_default() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.kind = 'taproom' and new.sort_mode = 'az' then
    new.sort_mode := 'lines';
  end if;
  return new;
end;
$$;
create trigger taproom_sort_default before insert on public.stock_places
  for each row execute function public.taproom_sort_default();
