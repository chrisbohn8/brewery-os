-- Tests for loading a backup in one all-or-nothing step (load_into_brewery).
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin of an empty brewery
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');    -- not in it

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Empty Brewing') as brewery_id;
grant all on ids to authenticated, anon;

-- A small backup: a location (which gets its own Storage place), its tanks, a beer, a batch, a
-- stock place named like the automatic one, and a raw material
create temp table backup as select jsonb_build_array(
  jsonb_build_object('insert', 'locations', 'rows', jsonb_build_array(jsonb_build_object('id', '11111111-0000-0000-0000-000000000001', 'name', 'Main'))),
  jsonb_build_object('insert', 'tanks', 'rows', jsonb_build_array(
    jsonb_build_object('id', '11111111-0000-0000-0000-000000000002', 'name', 'FV1', 'location_id', '11111111-0000-0000-0000-000000000001'),
    jsonb_build_object('id', '11111111-0000-0000-0000-000000000003', 'name', 'FV2', 'location_id', '11111111-0000-0000-0000-000000000001', 'capacity_bbl', 30))),
  jsonb_build_object('insert', 'beers', 'rows', jsonb_build_array(jsonb_build_object('id', '11111111-0000-0000-0000-000000000004', 'code', 'pale', 'name', 'Pale'))),
  jsonb_build_object('insert', 'batches', 'rows', jsonb_build_array(jsonb_build_object('id', '11111111-0000-0000-0000-000000000005',
    'batch_number', '101', 'beer_id', '11111111-0000-0000-0000-000000000004', 'brew_date', '2026-10-01'))),
  jsonb_build_object('match', 'stock_places', 'keys', jsonb_build_array('name', 'location_id'), 'row', jsonb_build_object(
    'id', '11111111-0000-0000-0000-000000000006', 'name', 'storage', 'location_id', '11111111-0000-0000-0000-000000000001', 'kind', 'storage', 'active', true)),
  jsonb_build_object('update', 'stock_places', 'id', '11111111-0000-0000-0000-000000000006', 'set', jsonb_build_object('sort_mode', 'oldest')),
  jsonb_build_object('match', 'raw_items', 'keys', jsonb_build_array('name'), 'row', jsonb_build_object(
    'id', '11111111-0000-0000-0000-000000000007', 'name', 'Pilsner malt', 'kind', 'malt', 'unit', 'lb', 'active', true))
) as steps;
grant all on backup to authenticated, anon;

-- Someone outside the brewery can't load into it
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');
select throws_like($$ select public.load_into_brewery((select brewery_id from ids), (select steps from backup)) $$,
  'You''re not in that brewery%', 'someone outside the brewery can''t load into it');

-- A load that fails at its last step leaves nothing behind
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select throws_ok($$ select public.load_into_brewery((select brewery_id from ids), (select steps from backup) || jsonb_build_array(
    jsonb_build_object('insert', 'batch_events', 'rows', jsonb_build_array(jsonb_build_object(
      'batch_id', '99999999-0000-0000-0000-000000000000', 'effective_date', '2026-10-01', 'stage', 'fermenting'))))) $$,
  '23503', null, 'a backup with a broken link is refused');
select is((select count(*) from tanks)::int + (select count(*) from locations)::int + (select count(*) from raw_items)::int, 0,
  'and nothing from it was loaded');
select throws_like($$ select public.load_into_brewery((select brewery_id from ids), '[{"insert": "memberships", "rows": [{}]}]') $$,
  'A backup can''t load into "memberships"%', 'only brewery records can be loaded (not who''s in the brewery)');

-- The whole backup loads
select lives_ok($$ select public.load_into_brewery((select brewery_id from ids), (select steps from backup)) $$, 'the backup loads');
select is((select count(*) from tanks where brewery_id = (select brewery_id from ids))::int, 2, 'every tank is there');
select is((select capacity_bbl from tanks where name = 'FV2')::numeric, 30::numeric, 'with its details (rows with different columns load too)');
select is((select count(*) from stock_places where brewery_id = (select brewery_id from ids))::int, 1,
  'the backup''s Storage place is the location''s own one (matched by name), not a second one');
select is((select sort_mode from stock_places where brewery_id = (select brewery_id from ids)), 'oldest',
  'and later steps reach it under its own ID');

-- Only into an empty brewery
select throws_like($$ select public.load_into_brewery((select brewery_id from ids), (select steps from backup)) $$,
  'Data can only be loaded into an empty brewery%', 'a second load into a brewery with data is refused');

select * from finish();
rollback;
