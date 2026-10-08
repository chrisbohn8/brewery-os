-- Inventory, step 1: finished goods (docs/inventory-design.md).
--
-- Stock sits in PLACES (a location's storage cooler, its taproom...). Like beer in tanks, stock is
-- never typed in as a number: it's worked out from a ledger of stock moves:
--   packaged  into a place, from a packaging run
--   moved     from one place to another (up to the taproom, to the other location)
--   removed   out of stock: sold, taproom (poured), transferred, donated, dumped
--   returned  back into stock
--   counted   a count sheet found more than expected (a count that finds less records a removal)
-- Every move names the beer, the package type, and (when known) the batch. Stock from before the
-- app (an opening count) has a beer but no batch. Taking stock out uses the oldest batch first.

-- ---------- A new permission: count and move finished goods ----------
create or replace function public.permission_list() returns text[]
language sql immutable as $$
  select array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'start_batch',
               'manage_beers', 'manage_equipment', 'manage_cleaning', 'manage_settings',
               'rename_brewery', 'backups', 'delete_records'];
$$;
create or replace function public.default_permissions(level text) returns text[]
language sql immutable as $$
  select case level
    when 'cellar'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory']
    when 'brewer'      then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'start_batch']
    when 'head_brewer' then array['cellar_log', 'tank_status', 'acid_log', 'move_beer', 'package', 'inventory', 'start_batch',
                                  'manage_beers', 'manage_equipment', 'manage_cleaning', 'manage_settings']
    when 'admin'       then public.permission_list()
    else array[]::text[]  -- viewer: look only
  end;
$$;
-- A brewery that changed a level: whoever could package can now also count and move what they package
update public.role_levels set permissions = permissions || array['inventory']
 where 'package' = any(permissions) and not 'inventory' = any(permissions);

-- ---------- Places ----------
create table public.stock_places (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  location_id  uuid,
  name         text not null check (length(trim(name)) > 0 and length(name) <= 60),
  kind         text not null default 'storage' check (kind in ('storage', 'taproom')),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (brewery_id, id),
  foreign key (brewery_id, location_id) references public.locations (brewery_id, id) on delete set null (location_id)
);
create unique index stock_places_name on public.stock_places (brewery_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

alter table public.stock_places enable row level security;
create policy "members read" on public.stock_places for select to authenticated using (public.is_member(brewery_id));
create policy "change places" on public.stock_places for all to authenticated
  using (public.has_permission(brewery_id, 'manage_equipment')) with check (public.has_permission(brewery_id, 'manage_equipment'));

-- Every location starts with a storage place (existing ones now, new ones as they're added)
create function public.new_location_place() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_places (brewery_id, location_id, name, kind) values (new.brewery_id, new.id, 'Storage', 'storage')
  on conflict do nothing;
  return new;
end;
$$;
create trigger storage_place after insert on public.locations
  for each row execute function public.new_location_place();
insert into public.stock_places (brewery_id, location_id, name, kind)
select brewery_id, id, 'Storage', 'storage' from public.locations on conflict do nothing;

-- Where packages go by default: the location's storage place, else any storage place, else a new one
create function public.default_stock_place(p_brewery_id uuid, p_location_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  place uuid;
begin
  select id into place from public.stock_places
   where brewery_id = p_brewery_id and active and kind = 'storage'
   order by (location_id is not distinct from p_location_id) desc, created_at limit 1;
  if place is null then
    insert into public.stock_places (brewery_id, location_id, name, kind) values (p_brewery_id, p_location_id, 'Storage', 'storage')
    returning id into place;
  end if;
  return place;
end;
$$;
revoke execute on function public.default_stock_place(uuid, uuid) from public, anon, authenticated;

-- ---------- The stock ledger ----------
create table public.stock_moves (
  id                  uuid primary key default gen_random_uuid(),
  brewery_id          uuid not null references public.breweries on delete cascade,
  group_id            uuid,                       -- the action it belongs to (one count sheet, one move)
  occurred_on         date not null,
  kind                text not null check (kind in ('packaged', 'moved', 'removed', 'returned', 'counted')),
  removal_kind        text check (removal_kind in ('sold', 'taproom', 'transferred', 'donated', 'dumped', 'unknown')),
  beer_id             uuid not null,
  batch_id            uuid,                       -- empty: stock from before the app (an opening count)
  package_type_id     uuid not null,
  count               numeric not null check (count > 0),
  from_place_id       uuid,
  to_place_id         uuid,
  source_movement_id  uuid references public.beer_movements on delete cascade,  -- the packaging run it came from
  account             text not null default '' check (length(account) <= 120),
  notes               text not null default '' check (length(notes) <= 500),
  recorded_by         uuid default auth.uid() references auth.users on delete set null,
  recorded_at         timestamptz not null default now(),
  check (from_place_id is not null or to_place_id is not null),
  foreign key (brewery_id, beer_id) references public.beers (brewery_id, id),
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete cascade,
  foreign key (brewery_id, package_type_id) references public.package_types (brewery_id, id),
  foreign key (brewery_id, from_place_id) references public.stock_places (brewery_id, id),
  foreign key (brewery_id, to_place_id) references public.stock_places (brewery_id, id)
);
create index stock_moves_brewery on public.stock_moves (brewery_id, occurred_on);
create index stock_moves_group on public.stock_moves (group_id);

alter table public.stock_moves enable row level security;
create policy "members read" on public.stock_moves for select to authenticated using (public.is_member(brewery_id));
-- Day to day, stock is changed by the functions below; writing directly (loading a backup) needs
-- the inventory permission. No editing: a mistake is fixed by another move or a count.
create policy "record stock" on public.stock_moves for insert to authenticated
  with check (public.has_permission(brewery_id, 'inventory'));

-- What's on hand: per place, beer, batch, and package type (worked out, never stored)
create view public.stock_on_hand with (security_invoker = true) as
select brewery_id, place_id, beer_id, batch_id, package_type_id, sum(delta) as count
  from (select brewery_id, to_place_id as place_id, beer_id, batch_id, package_type_id, count as delta
          from public.stock_moves where to_place_id is not null
        union all
        select brewery_id, from_place_id, beer_id, batch_id, package_type_id, -count
          from public.stock_moves where from_place_id is not null) moves
 group by brewery_id, place_id, beer_id, batch_id, package_type_id
having sum(delta) <> 0;

-- Take stock out of a place for one beer and package type, oldest batch first (stock from
-- before the app, with no batch, counts as oldest). Returns nothing; inserts the moves.
create function public.take_stock(
  p_brewery_id uuid, p_group uuid, p_date date, p_kind text, p_removal text, p_beer uuid, p_batch uuid,
  p_type uuid, p_count numeric, p_from uuid, p_to uuid, p_account text, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  lot      record;
  left_to  numeric := p_count;
  take     numeric;
begin
  for lot in
    select h.batch_id, h.count from public.stock_on_hand h left join public.batches b on b.id = h.batch_id
     where h.brewery_id = p_brewery_id and h.place_id = p_from and h.beer_id = p_beer and h.package_type_id = p_type
       and h.count > 0 and (p_batch is null or h.batch_id = p_batch)
     order by b.brew_date nulls first, h.batch_id
  loop
    exit when left_to <= 0;
    take := least(lot.count, left_to);
    insert into public.stock_moves (brewery_id, group_id, occurred_on, kind, removal_kind, beer_id, batch_id, package_type_id,
                                    count, from_place_id, to_place_id, account, notes, recorded_at)
    values (p_brewery_id, p_group, p_date, p_kind, p_removal, p_beer, lot.batch_id, p_type, take, p_from, p_to,
            coalesce(p_account, ''), coalesce(p_notes, ''), clock_timestamp());
    left_to := left_to - take;
  end loop;
  if left_to > 0 then
    raise exception 'There isn''t that much in stock there (% short). Count the place first if the numbers are off.', left_to;
  end if;
end;
$$;
revoke execute on function public.take_stock(uuid, uuid, date, text, text, uuid, uuid, uuid, numeric, uuid, uuid, text, text) from public, anon, authenticated;

-- Move, remove, or return stock, all or nothing:
--   p_lines  [{ "beer": id, "type": id, "count": 3, "batch": id or null }, ...]
--   from + to = moved; from only = removed (p_removal says how); to only = returned
-- Safe to repeat (an offline retry).
create function public.record_stock(
  p_id uuid, p_brewery_id uuid, p_date date, p_from uuid, p_to uuid, p_removal text,
  p_lines jsonb, p_account text, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  line jsonb;
begin
  perform public.require_permission(p_brewery_id, 'inventory', 'count and move finished goods');
  if exists (select 1 from public.stock_moves where group_id = p_id) then
    return; -- already saved
  end if;
  if p_from is null and p_to is null then
    raise exception 'Choose where the stock is coming from or going to.';
  end if;
  if p_from = p_to then
    raise exception 'Moving stock needs two different places.';
  end if;
  if exists (select 1 from unnest(array[p_from, p_to]) x(id) where id is not null
              and not exists (select 1 from public.stock_places where id = x.id and brewery_id = p_brewery_id)) then
    raise exception using errcode = '42501', message = 'That place isn''t in this brewery.';
  end if;
  if p_from is not null and p_to is null and p_removal is null then
    raise exception 'Say what kind of removal it was.';
  end if;
  for line in select * from jsonb_array_elements(p_lines) loop
    if (line->>'count')::numeric <= 0 then continue; end if;
    if p_from is not null then
      perform public.take_stock(p_brewery_id, p_id, p_date, case when p_to is null then 'removed' else 'moved' end,
                                case when p_to is null then p_removal end, (line->>'beer')::uuid, (line->>'batch')::uuid,
                                (line->>'type')::uuid, (line->>'count')::numeric, p_from, p_to, p_account, p_notes);
    else
      -- Returned into stock: to the batch given, or the beer's newest batch
      insert into public.stock_moves (brewery_id, group_id, occurred_on, kind, beer_id, batch_id, package_type_id, count,
                                      to_place_id, account, notes)
      values (p_brewery_id, p_id, p_date, 'returned', (line->>'beer')::uuid,
              coalesce((line->>'batch')::uuid, (select id from public.batches where beer_id = (line->>'beer')::uuid
                                                 and brewery_id = p_brewery_id order by brew_date desc nulls last limit 1)),
              (line->>'type')::uuid, (line->>'count')::numeric, p_to, coalesce(p_account, ''), coalesce(p_notes, ''));
    end if;
  end loop;
end;
$$;
revoke execute on function public.record_stock(uuid, uuid, date, uuid, uuid, text, jsonb, text, text) from public, anon;
grant execute on function public.record_stock(uuid, uuid, date, uuid, uuid, text, jsonb, text, text) to authenticated;

-- A count sheet for one place, all or nothing:
--   p_lines  [{ "beer": id, "type": id, "counted": 12 }, ...]  (what's actually there)
-- Less than expected: recorded as removed (p_drop: 'taproom' for poured, 'sold', 'unknown'...),
-- oldest batch first. More than expected: recorded as counted, into the beer's newest batch (or,
-- for a beer never packaged in the app, as opening stock with no batch). Safe to repeat.
create function public.record_count(
  p_id uuid, p_brewery_id uuid, p_place_id uuid, p_date date, p_lines jsonb, p_drop text, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  line      jsonb;
  expected  numeric;
  counted   numeric;
begin
  perform public.require_permission(p_brewery_id, 'inventory', 'count finished goods');
  if exists (select 1 from public.stock_moves where group_id = p_id) then
    return; -- already saved
  end if;
  if not exists (select 1 from public.stock_places where id = p_place_id and brewery_id = p_brewery_id) then
    raise exception using errcode = '42501', message = 'That place isn''t in this brewery.';
  end if;
  for line in select * from jsonb_array_elements(p_lines) loop
    counted := (line->>'counted')::numeric;
    if counted is null or counted < 0 then continue; end if;
    select coalesce(sum(count), 0) into expected from public.stock_on_hand
     where brewery_id = p_brewery_id and place_id = p_place_id
       and beer_id = (line->>'beer')::uuid and package_type_id = (line->>'type')::uuid;
    if counted < expected then
      perform public.take_stock(p_brewery_id, p_id, p_date, 'removed', coalesce(p_drop, 'unknown'), (line->>'beer')::uuid, null,
                                (line->>'type')::uuid, expected - counted, p_place_id, null, '', coalesce(p_notes, 'count'));
    elsif counted > expected then
      insert into public.stock_moves (brewery_id, group_id, occurred_on, kind, beer_id, batch_id, package_type_id, count,
                                      to_place_id, notes, recorded_at)
      values (p_brewery_id, p_id, p_date, 'counted', (line->>'beer')::uuid,
              (select id from public.batches where beer_id = (line->>'beer')::uuid and brewery_id = p_brewery_id
                order by brew_date desc nulls last limit 1),
              (line->>'type')::uuid, counted - expected, p_place_id, coalesce(p_notes, 'count'), clock_timestamp());
    end if;
  end loop;
end;
$$;
revoke execute on function public.record_count(uuid, uuid, uuid, date, jsonb, text, text) from public, anon;
grant execute on function public.record_count(uuid, uuid, uuid, date, jsonb, text, text) to authenticated;

-- ---------- Packaging puts the packages into stock ----------
-- record_packaging() gains one optional value: which place the packages go to (default: the
-- tank location's storage). A new parameter makes a new function, so the old one is replaced.
drop function public.record_packaging(uuid, uuid, uuid, uuid, date, jsonb, boolean, text);

create function public.record_packaging(
  p_id uuid, p_brewery_id uuid, p_batch_id uuid, p_tank_id uuid, p_occurred_on date,
  p_counts jsonb, p_spent boolean, p_notes text, p_place_id uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  current_state record;
  total         numeric;
  balance       numeric;
  item          jsonb;
  unit          numeric;
  place         uuid;
  beer          uuid;
begin
  perform public.require_permission(p_brewery_id, 'package', 'package beer');
  if exists (select 1 from public.beer_movements where id = p_id) then
    return; -- already saved (sent before the connection dropped)
  end if;
  select stage, tank_id into current_state from public.batch_status where id = p_batch_id and brewery_id = p_brewery_id;
  if not found then
    raise exception using errcode = '42501', message = 'You don''t have permission to change that batch.';
  end if;
  if current_state.stage = 'packaged' or current_state.tank_id is distinct from p_tank_id then
    raise exception 'That batch isn''t in that tank any more.';
  end if;
  -- Where the packages go: the chosen stock place, or the tank location's storage
  place := coalesce(
    (select id from public.stock_places where id = p_place_id and brewery_id = p_brewery_id),
    public.default_stock_place(p_brewery_id, (select location_id from public.tanks where id = p_tank_id)));
  select beer_id into beer from public.batches where id = p_batch_id;
  if jsonb_typeof(p_counts) <> 'array' or (jsonb_array_length(p_counts) = 0 and not p_spent) then
    raise exception 'Enter how many of each package were filled.';
  end if;

  -- The run: one package movement, with its counts
  insert into public.beer_movements (id, brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, notes)
  values (p_id, p_brewery_id, p_batch_id, p_occurred_on, 'package', p_tank_id, 0, coalesce(p_notes, ''));
  total := 0;
  for item in select * from jsonb_array_elements(p_counts) loop
    select volume_bbl into unit from public.package_types
     where id = (item->>'type')::uuid and brewery_id = p_brewery_id;
    if not found then
      raise exception 'That package type no longer exists.';
    end if;
    if (item->>'count')::numeric <= 0 then
      raise exception 'Counts must be more than zero.';
    end if;
    insert into public.package_counts (brewery_id, movement_id, package_type_id, count, unit_volume_bbl)
    values (p_brewery_id, p_id, (item->>'type')::uuid, (item->>'count')::numeric, unit);
    total := total + (item->>'count')::numeric * unit;
    -- ...and into stock
    insert into public.stock_moves (brewery_id, occurred_on, kind, beer_id, batch_id, package_type_id, count, to_place_id, source_movement_id)
    values (p_brewery_id, p_occurred_on, 'packaged', beer, p_batch_id, (item->>'type')::uuid, (item->>'count')::numeric, place, p_id);
  end loop;
  update public.beer_movements set volume_bbl = total where id = p_id;

  if p_spent then
    -- What's left on paper: a loss (or, if more came out than was recorded, a correction)
    balance := public.tank_balance(p_batch_id, p_tank_id);
    if balance > 0 then
      insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, notes)
      values (p_brewery_id, p_batch_id, p_occurred_on, 'loss', p_tank_id, balance, 'tank spent');
    elsif balance < 0 then
      insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, notes)
      values (p_brewery_id, p_batch_id, p_occurred_on, 'correction', p_tank_id, -balance, 'more packaged than was recorded');
    end if;
    -- The batch is packaged, and its tank goes to cleaning
    insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id, recorded_by)
    values (p_brewery_id, p_batch_id, p_occurred_on, 'packaged', null, auth.uid());
    perform set_config('brewery_os.saving_batch', 'on', true);
    update public.tanks set status = 'cleaning' where id = p_tank_id;
    perform set_config('brewery_os.saving_batch', 'off', true);
  end if;
end;
$$;
revoke execute on function public.record_packaging(uuid, uuid, uuid, uuid, date, jsonb, boolean, text, uuid) from public, anon;
grant execute on function public.record_packaging(uuid, uuid, uuid, uuid, date, jsonb, boolean, text, uuid) to authenticated;

-- Packaging runs recorded before inventory existed: their packages go into stock too, in the
-- tank location's storage place, so what's on hand starts from what was packaged
insert into public.stock_moves (brewery_id, occurred_on, kind, beer_id, batch_id, package_type_id, count, to_place_id, source_movement_id, notes)
select m.brewery_id, m.occurred_on, 'packaged', b.beer_id, m.batch_id, c.package_type_id, c.count,
       public.default_stock_place(m.brewery_id, t.location_id), m.id, 'packaged before inventory existed'
  from public.package_counts c
  join public.beer_movements m on m.id = c.movement_id
  join public.batches b on b.id = m.batch_id
  left join public.tanks t on t.id = m.from_tank_id;
