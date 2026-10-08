-- Inventory, step 2: pars (docs/inventory-design.md). A par is how much of a beer a place should
-- have on hand (the front of house sets them for a taproom), in barrels and/or cases. A par with
-- no place is the brewery-wide par for that beer (all places together). What's over or under,
-- what to bring up, and what's "on deck" are all worked out in the app from these and the stock.
create table public.stock_pars (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  place_id    uuid,                                   -- empty = the whole brewery
  beer_id     uuid not null,
  par_bbl     numeric check (par_bbl >= 0),
  par_cases   numeric check (par_cases >= 0),
  updated_by  uuid default auth.uid() references auth.users on delete set null,
  updated_at  timestamptz not null default now(),
  unique nulls not distinct (brewery_id, place_id, beer_id),
  check (par_bbl is not null or par_cases is not null),
  foreign key (brewery_id, place_id) references public.stock_places (brewery_id, id) on delete cascade,
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id) on delete cascade
);

alter table public.stock_pars enable row level security;
create policy "members read" on public.stock_pars for select to authenticated using (public.is_member(brewery_id));
create policy "set pars" on public.stock_pars for all to authenticated
  using (public.has_permission(brewery_id, 'inventory')) with check (public.has_permission(brewery_id, 'inventory'));

create function public.stamp_par() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger stamp_par before update on public.stock_pars for each row execute function public.stamp_par();
