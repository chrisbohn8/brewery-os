-- Inventory views (the user's idea): the brewery's own "sheets" for looking at stock, like a
-- master sheet that adds up only the storage places, split by place and package size, with pars
-- and what's still in tanks (the pipeline). Each view says:
--   place_ids       which places it adds up
--   split_by_place  one column per place and size ("Downstairs ½", "Storage ½"...), or sizes combined
--   type_ids        which package sizes get columns (empty = every size in use)
--   show            which extra columns: total_bbl, total_cases, par_bbl, par_cases, pipeline
--   beers           which beers: 'stock' (with stock), 'stock_or_par', or 'all'
--   sort_mode       'az' or 'oldest'
create table public.inventory_views (
  id              uuid primary key default gen_random_uuid(),
  brewery_id      uuid not null references public.breweries on delete cascade,
  name            text not null check (length(trim(name)) > 0 and length(name) <= 60),
  place_ids       uuid[] not null default '{}',
  split_by_place  boolean not null default false,
  type_ids        uuid[] not null default '{}',
  show            text[] not null default array['total_bbl'] check (show <@ array['total_bbl', 'total_cases', 'par_bbl', 'par_cases', 'pipeline']),
  beers           text not null default 'stock' check (beers in ('stock', 'stock_or_par', 'all')),
  sort_mode       text not null default 'az' check (sort_mode in ('az', 'oldest')),
  position        integer not null default 0,
  created_at      timestamptz not null default now()
);
alter table public.inventory_views enable row level security;
create policy "members read" on public.inventory_views for select to authenticated using (public.is_member(brewery_id));
create policy "change views" on public.inventory_views for all to authenticated
  using (public.has_permission(brewery_id, 'inventory')) with check (public.has_permission(brewery_id, 'inventory'));
