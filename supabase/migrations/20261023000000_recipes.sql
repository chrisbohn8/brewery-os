-- Recipes (Phase 6½; decided: recipes stay simple). A beer's recipe is its targets and an
-- ingredient list, optionally for one location's brewhouse, adjusted by hand (no scaling). They
-- come in from the major brewing tools as BeerXML, or are typed. The brew-day sheet copies a
-- recipe's ingredients the same way it copies the last batch's (lot numbers left empty).
create table public.recipes (
  id              uuid primary key default gen_random_uuid(),
  brewery_id      uuid not null references public.breweries on delete cascade,
  beer_id         uuid not null,
  location_id     uuid,                                -- empty = any location
  name            text not null check (length(trim(name)) > 0 and length(name) <= 120),
  batch_size_bbl  numeric check (batch_size_bbl > 0),
  target_og       numeric check (target_og between 0.98 and 1.2),
  target_fg       numeric check (target_fg between 0.98 and 1.2),
  ibu             numeric check (ibu >= 0),
  notes           text not null default '' check (length(notes) <= 4000),
  source          text not null default '' check (length(source) <= 120),   -- "BeerXML from BeerSmith 3", "typed"
  created_at      timestamptz not null default now(),
  unique (brewery_id, id),
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id) on delete cascade,
  foreign key (brewery_id, location_id) references public.locations (brewery_id, id) on delete set null (location_id)
);
create table public.recipe_ingredients (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  recipe_id   uuid not null,
  position    integer not null default 0,
  kind        text not null default 'other' check (kind in ('malt', 'hop', 'adjunct', 'salt', 'yeast', 'finings', 'fruit', 'spice', 'other')),
  name        text not null check (length(trim(name)) > 0 and length(name) <= 120),
  amount      numeric check (amount > 0),
  unit        text not null default 'lb' check (unit in ('oz', 'lb', 'g', 'kg', 'ml', 'l', 'gal', 'each')),
  timing      text not null default '' check (length(timing) <= 60),
  foreign key (brewery_id, recipe_id) references public.recipes (brewery_id, id) on delete cascade
);
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
create policy "members read" on public.recipes for select to authenticated using (public.is_member(brewery_id));
create policy "members read" on public.recipe_ingredients for select to authenticated using (public.is_member(brewery_id));
-- Recipes are part of a beer ("Beers and recipes" permission)
create policy "manage recipes" on public.recipes for all to authenticated
  using (public.has_permission(brewery_id, 'manage_beers')) with check (public.has_permission(brewery_id, 'manage_beers'));
create policy "manage recipe ingredients" on public.recipe_ingredients for all to authenticated
  using (public.has_permission(brewery_id, 'manage_beers')) with check (public.has_permission(brewery_id, 'manage_beers'));
