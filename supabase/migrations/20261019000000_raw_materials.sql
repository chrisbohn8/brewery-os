-- Inventory, step 3: raw materials (docs/inventory-design.md).
--
-- Items (malt, hops, salts, yeast, chemicals...) are received by lot. What's on hand is worked out:
--   received  - used on batches (brew-day ingredients and cellar additions with the item's name and lot)
--             + count corrections
-- Usage isn't stored twice: it comes straight from the batches' additions, so fixing an addition
-- fixes the stock.
create table public.raw_items (
  id             uuid primary key default gen_random_uuid(),
  brewery_id     uuid not null references public.breweries on delete cascade,
  name           text not null check (length(trim(name)) > 0 and length(name) <= 120),
  kind           text not null default 'other' check (kind in ('malt', 'adjunct', 'salt', 'hop', 'finings', 'yeast', 'chemical', 'other')),
  unit           text not null default 'lb' check (unit in ('lb', 'kg', 'oz', 'g', 'gal', 'l', 'ml', 'each')),
  pack_name      text not null default '' check (length(pack_name) <= 40),   -- "sack", "box"
  pack_size      numeric check (pack_size > 0),                              -- in the item's unit: 55 (lb)
  reorder_level  numeric check (reorder_level >= 0),                         -- in the item's unit
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (brewery_id, id)
);
create unique index raw_items_name on public.raw_items (brewery_id, lower(name));

create table public.raw_receipts (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  item_id      uuid not null,
  received_on  date not null,
  lot          text not null default '' check (length(lot) <= 80),
  amount       numeric not null check (amount > 0),                   -- in the item's unit
  supplier     text not null default '' check (length(supplier) <= 120),
  cost         numeric check (cost >= 0),                             -- for the whole receipt
  notes        text not null default '' check (length(notes) <= 500),
  recorded_by  uuid default auth.uid() references auth.users on delete set null,
  recorded_at  timestamptz not null default now(),
  foreign key (brewery_id, item_id) references public.raw_items (brewery_id, id) on delete cascade
);

-- A count that found more or less than expected (change is + or -, in the item's unit)
create table public.raw_adjustments (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  item_id      uuid not null,
  lot          text not null default '' check (length(lot) <= 80),
  adjusted_on  date not null,
  change       numeric not null check (change <> 0),
  reason       text not null default '' check (length(reason) <= 500),
  recorded_by  uuid default auth.uid() references auth.users on delete set null,
  recorded_at  timestamptz not null default now(),
  foreign key (brewery_id, item_id) references public.raw_items (brewery_id, id) on delete cascade
);

alter table public.raw_items       enable row level security;
alter table public.raw_receipts    enable row level security;
alter table public.raw_adjustments enable row level security;
create policy "members read" on public.raw_items       for select to authenticated using (public.is_member(brewery_id));
create policy "members read" on public.raw_receipts    for select to authenticated using (public.is_member(brewery_id));
create policy "members read" on public.raw_adjustments for select to authenticated using (public.is_member(brewery_id));
-- Receiving, counting, and setting up items: the inventory permission. Receipts can be corrected
-- (a typo in a lot number) and deleted with "delete records"; counts are append-only.
create policy "manage items" on public.raw_items for all to authenticated
  using (public.has_permission(brewery_id, 'inventory')) with check (public.has_permission(brewery_id, 'inventory'));
create policy "receive" on public.raw_receipts for insert to authenticated with check (public.has_permission(brewery_id, 'inventory'));
create policy "fix receipts" on public.raw_receipts for update to authenticated
  using (public.has_permission(brewery_id, 'inventory')) with check (public.has_permission(brewery_id, 'inventory'));
create policy "remove receipts" on public.raw_receipts for delete to authenticated using (public.has_permission(brewery_id, 'delete_records'));
create policy "count" on public.raw_adjustments for insert to authenticated with check (public.has_permission(brewery_id, 'inventory'));
