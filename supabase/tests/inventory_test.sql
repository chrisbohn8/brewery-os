-- Tests for finished-goods inventory: stock places, packaging into stock, moves, removals (oldest
-- batch first), count sheets, and opening stock.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000ea', 'viewer@example.test'),
  ('00000000-0000-0000-0000-0000000000da', 'outsider@example.test');
create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000aa');
create temp table ids as select public.create_brewery('Stock Brewery') as b;
grant all on ids to authenticated;
insert into locations (id, brewery_id, name) select 'aa000000-0000-0000-0000-0000000000c1', b, 'Main' from ids;
select is((select name || ' (' || kind || ')' from stock_places), 'Storage (storage)', 'a new location gets a storage place');
insert into stock_places (id, brewery_id, location_id, name, kind)
select 'aa000000-0000-0000-0000-0000000000f2', b, 'aa000000-0000-0000-0000-0000000000c1', 'Taproom', 'taproom' from ids;
create function pg_temp.storage() returns uuid language sql as $$ select id from stock_places where name = 'Storage' $$;
create function pg_temp.half() returns uuid language sql as $$ select id from package_types where catalog_key = 'keg_half' $$;
insert into tanks (id, brewery_id, name, location_id)
select ('aa000000-0000-0000-0000-00000000000' || n)::uuid, b, 'BT-' || n, 'aa000000-0000-0000-0000-0000000000c1' from ids, generate_series(1, 2) n;
insert into beers (id, brewery_id, code, name) select 'aa000000-0000-0000-0000-0000000000be', b, 'lager', 'Lager' from ids;
insert into beers (id, brewery_id, code, name) select 'aa000000-0000-0000-0000-0000000000bf', b, 'old', 'Old Favorite' from ids;

-- Two batches of Lager: the older one (Oct 1) and the newer one (Oct 10), each packaged into halves
create function pg_temp.batch(id uuid, number text, brewed date, tank uuid) returns void language sql as $$
  select public.save_batch(id, (select b from ids), number, 'aa000000-0000-0000-0000-0000000000be', brewed, 30, 'ready', brewed, tank, brewed);
$$;
select pg_temp.batch('aa000000-0000-0000-0000-0000000000a1', '1', '2026-10-01', 'aa000000-0000-0000-0000-000000000001');
select pg_temp.batch('aa000000-0000-0000-0000-0000000000a2', '2', '2026-10-10', 'aa000000-0000-0000-0000-000000000002');
select public.record_packaging('aa000000-0000-0000-0000-0000000000e1', (select b from ids), 'aa000000-0000-0000-0000-0000000000a1',
  'aa000000-0000-0000-0000-000000000001', '2026-10-20', jsonb_build_array(jsonb_build_object('type', pg_temp.half(), 'count', 10)), false, '');
select public.record_packaging('aa000000-0000-0000-0000-0000000000e2', (select b from ids), 'aa000000-0000-0000-0000-0000000000a2',
  'aa000000-0000-0000-0000-000000000002', '2026-10-21', jsonb_build_array(jsonb_build_object('type', pg_temp.half(), 'count', 40)), false, '');
create function pg_temp.on_hand(place uuid, batch uuid default null) returns numeric language sql as $$
  select coalesce(sum(count), 0) from stock_on_hand where place_id = place and (batch is null or batch_id = batch)
$$;
select is(pg_temp.on_hand(pg_temp.storage()), 50::numeric, 'packaging puts 50 halves in the location''s storage');

-- 1. Move 3 halves up to the taproom
select public.record_stock('aa000000-0000-0000-0000-000000000101', (select b from ids), '2026-10-22', pg_temp.storage(),
  'aa000000-0000-0000-0000-0000000000f2', null,
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000be', 'type', pg_temp.half(), 'count', 3)), '', '');
select is(pg_temp.on_hand('aa000000-0000-0000-0000-0000000000f2'), 3::numeric, 'the taproom has 3');
select is(pg_temp.on_hand('aa000000-0000-0000-0000-0000000000f2', 'aa000000-0000-0000-0000-0000000000a1'), 3::numeric, 'from the oldest batch');

-- 2. Sell 12 from storage: the 7 left of the older batch go first, then 5 of the newer one
select public.record_stock('aa000000-0000-0000-0000-000000000102', (select b from ids), '2026-10-23', pg_temp.storage(), null, 'sold',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000be', 'type', pg_temp.half(), 'count', 12)), 'Corner Bar', '');
select is(pg_temp.on_hand(pg_temp.storage(), 'aa000000-0000-0000-0000-0000000000a1'), 0::numeric, 'the older batch is gone first');
select is(pg_temp.on_hand(pg_temp.storage(), 'aa000000-0000-0000-0000-0000000000a2'), 35::numeric, 'then the newer one');
select is((select account from stock_moves where removal_kind = 'sold' limit 1), 'Corner Bar', 'the account name is kept');

-- 3. Repeating it (an offline retry) changes nothing
select public.record_stock('aa000000-0000-0000-0000-000000000102', (select b from ids), '2026-10-23', pg_temp.storage(), null, 'sold',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000be', 'type', pg_temp.half(), 'count', 12)), 'Corner Bar', '');
select is(pg_temp.on_hand(pg_temp.storage()), 35::numeric, 'repeating a removal changes nothing');

-- 4. A count sheet: the taproom has 1 left (2 poured); storage has 36 (one more than expected)
select public.record_count('aa000000-0000-0000-0000-000000000103', (select b from ids), 'aa000000-0000-0000-0000-0000000000f2', '2026-10-24',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000be', 'type', pg_temp.half(), 'counted', 1)), 'taproom', '');
select is((select sum(count) from stock_moves where removal_kind = 'taproom'), 2::numeric, 'a taproom count that''s 2 short records 2 poured');
select public.record_count('aa000000-0000-0000-0000-000000000104', (select b from ids), pg_temp.storage(), '2026-10-24',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000be', 'type', pg_temp.half(), 'counted', 36)), 'unknown', '');
select is(pg_temp.on_hand(pg_temp.storage()), 36::numeric, 'a count that finds more adds it');
select is((select batch_id from stock_moves where kind = 'counted'), 'aa000000-0000-0000-0000-0000000000a2'::uuid, 'to the newest batch');

-- 5. Opening stock: a beer never packaged in the app
select public.record_count('aa000000-0000-0000-0000-000000000105', (select b from ids), pg_temp.storage(), '2026-10-24',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000bf', 'type', pg_temp.half(), 'counted', 4)), 'unknown', '');
select is((select count || ' with batch ' || coalesce(batch_id::text, 'none') from stock_on_hand where beer_id = 'aa000000-0000-0000-0000-0000000000bf'),
  '4 with batch none', 'an opening count of a beer from before the app has no batch');

-- 5b. Pars: one per beer per place, plus one brewery-wide
insert into stock_pars (brewery_id, place_id, beer_id, par_bbl) select b, 'aa000000-0000-0000-0000-0000000000f2', 'aa000000-0000-0000-0000-0000000000be', 1.5 from ids;
insert into stock_pars (brewery_id, place_id, beer_id, par_bbl, par_cases) select b, null, 'aa000000-0000-0000-0000-0000000000be', 24, 10 from ids;
select is((select count(*) from stock_pars)::int, 2, 'a taproom par and a brewery-wide par');
select throws_ok($$ insert into stock_pars (brewery_id, place_id, beer_id, par_bbl) select b, null, 'aa000000-0000-0000-0000-0000000000be', 30 from ids $$,
  '23505', null, 'one brewery-wide par per beer');
select throws_ok($$ insert into stock_pars (brewery_id, place_id, beer_id) select b, null, 'aa000000-0000-0000-0000-0000000000bf' from ids $$,
  '23514', null, 'a par needs barrels or cases');

-- 5c. Raw materials: an item, a receipt by lot, and a count correction
insert into raw_items (id, brewery_id, name, kind, unit, pack_name, pack_size, reorder_level)
select 'aa000000-0000-0000-0000-0000000000d1', b, 'Pilsner malt', 'malt', 'lb', 'sack', 55, 550 from ids;
insert into raw_receipts (brewery_id, item_id, received_on, lot, amount, supplier, cost)
select b, 'aa000000-0000-0000-0000-0000000000d1', '2026-10-01', 'PM-778', 2200, 'Maltster', 1100 from ids;
insert into raw_adjustments (brewery_id, item_id, lot, adjusted_on, change, reason)
select b, 'aa000000-0000-0000-0000-0000000000d1', 'PM-778', '2026-10-20', -55, 'torn sack' from ids;
select is((select sum(amount) from raw_receipts) + (select sum(change) from raw_adjustments), 2145::numeric, 'received 40 sacks, one torn');
select throws_ok($$ insert into raw_items (brewery_id, name) select b, 'PILSNER MALT' from ids $$, '23505', null, 'item names are unique (any capitals)');
update raw_adjustments set change = 1;
select is((select change from raw_adjustments), -55::numeric, 'counts can''t be edited');

-- 5d. Draft lines and the order a place lists its beers
select is((select sort_mode from stock_places where id = 'aa000000-0000-0000-0000-0000000000f2'), 'lines', 'a taproom lists its beers in draft line order');
insert into draft_lines (brewery_id, place_id, line_no, status, beer_id) select b, 'aa000000-0000-0000-0000-0000000000f2', 1, 'beer', 'aa000000-0000-0000-0000-0000000000be' from ids;
insert into draft_lines (brewery_id, place_id, line_no, status, label) select b, 'aa000000-0000-0000-0000-0000000000f2', 2, 'other', 'Wine' from ids;
select throws_ok($$ insert into draft_lines (brewery_id, place_id, line_no, status) select b, 'aa000000-0000-0000-0000-0000000000f2', 1, 'empty' from ids $$,
  '23505', null, 'one beer per line number');
select throws_ok($$ insert into draft_lines (brewery_id, place_id, line_no, status) select b, 'aa000000-0000-0000-0000-0000000000f2', 3, 'beer' from ids $$,
  '23514', null, 'a line pouring beer names the beer');
insert into beers (id, brewery_id, code, name) select 'aa000000-0000-0000-0000-0000000000b9', b, 'gone', 'Gone Beer' from ids;
insert into draft_lines (brewery_id, place_id, line_no, status, beer_id) select b, 'aa000000-0000-0000-0000-0000000000f2', 3, 'beer', 'aa000000-0000-0000-0000-0000000000b9' from ids;
delete from beers where id = 'aa000000-0000-0000-0000-0000000000b9';
select is((select status from draft_lines where line_no = 3), 'empty', 'deleting a beer that''s on a line leaves the line empty');
select public.set_place_order(pg_temp.storage(), 'custom', array['aa000000-0000-0000-0000-0000000000bf', 'aa000000-0000-0000-0000-0000000000be']::uuid[]);
select is((select sort_mode || ':' || array_length(beer_order, 1) from stock_places where id = pg_temp.storage()), 'custom:2', 'a place can have its own order');

-- 5e. Inventory views
insert into inventory_views (brewery_id, name, place_ids, split_by_place, show, beers)
select b, 'Master', array[pg_temp.storage()], true, array['total_bbl', 'total_cases', 'par_bbl', 'pipeline'], 'stock_or_par' from ids;
select is((select name || ':' || array_length(show, 1) from inventory_views), 'Master:4', 'a brewery can save its own inventory view');
select throws_ok($$ insert into inventory_views (brewery_id, name, show) select b, 'Odd', array['colour'] from ids $$, '23514', null,
  'only known columns');

-- 6. A brewery that asks for a reason on every stock change
update breweries set require_stock_reason = true, stock_reasons = array['Stocked the taproom', 'Dock sale'];
select throws_ok($$ select public.record_stock('aa000000-0000-0000-0000-000000000108', (select b from ids), '2026-10-25', pg_temp.storage(), null, 'sold',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000be', 'type', pg_temp.half(), 'count', 1)), '', '') $$,
  'P0001', 'This brewery asks for a reason on every stock change.', 'with reasons required, a removal without one is refused');
select public.record_stock('aa000000-0000-0000-0000-000000000108', (select b from ids), '2026-10-25', pg_temp.storage(), null, 'sold',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000be', 'type', pg_temp.half(), 'count', 1)), '', 'Dock sale');
select is((select notes from stock_moves where group_id = 'aa000000-0000-0000-0000-000000000108'), 'Dock sale', 'with one, it''s saved with the reason');
update breweries set require_stock_reason = false;

-- 6. Guardrails
select throws_ok($$ select public.record_stock('aa000000-0000-0000-0000-000000000106', (select b from ids), '2026-10-25', pg_temp.storage(), null, 'sold',
  jsonb_build_array(jsonb_build_object('beer', 'aa000000-0000-0000-0000-0000000000bf', 'type', pg_temp.half(), 'count', 5)), '', '') $$,
  'P0001', null, 'can''t take out more than is there');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ea');
set local role postgres;
insert into memberships (brewery_id, user_id, role) select b, '00000000-0000-0000-0000-0000000000ea', 'viewer' from ids;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ea');
select throws_ok($$ select public.record_count('aa000000-0000-0000-0000-000000000107', (select b from ids), pg_temp.storage(), '2026-10-25', '[]'::jsonb, 'unknown', '') $$,
  '42501', null, 'a viewer can''t count or move stock');
select is(pg_temp.on_hand(pg_temp.storage()), 39::numeric, 'but can see it (36 + 4 - 1)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000da');
select is((select count(*) from stock_moves)::int, 0, 'another brewery sees none of it');

select * from finish();
rollback;
