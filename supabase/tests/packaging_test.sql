-- Tests for packaging: package types, packaging runs (counts × volumes), and "this tank is spent".
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(15);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a8', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000c8', 'cellar@example.test'),
  ('00000000-0000-0000-0000-0000000000e8', 'viewer@example.test');

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a8');
create temp table ids as select public.create_brewery('Packaging Brewery') as b;
grant all on ids to authenticated;

select is((select count(*) from package_types)::int, 5, 'a new brewery starts with the usual package types');
select is((select round(volume_bbl * 31, 2) from package_types where catalog_key = 'case_24x16'), 3.00::numeric,
  'a case of 24 × 16 oz is 3 gallons');

insert into tanks (id, brewery_id, name) select 'a8000000-0000-0000-0000-000000000001', b, 'BT-1' from ids;
insert into beers (id, brewery_id, code, name) select 'a8000000-0000-0000-0000-0000000000be', b, 'pils', 'Pils' from ids;
select public.save_batch('a8000000-0000-0000-0000-0000000000ba', (select b from ids), '800', 'a8000000-0000-0000-0000-0000000000be',
                         '2026-10-01', 30, 'ready', '2026-10-20', 'a8000000-0000-0000-0000-000000000001', '2026-10-20');
insert into memberships (brewery_id, user_id, role)
select b, '00000000-0000-0000-0000-0000000000c8'::uuid, 'cellar' from ids union all
select b, '00000000-0000-0000-0000-0000000000e8', 'viewer' from ids;

create function pg_temp.package(run uuid, counts jsonb, spent boolean, tank uuid default 'a8000000-0000-0000-0000-000000000001')
returns void language sql as $$
  select public.record_packaging(run, (select b from ids), 'a8000000-0000-0000-0000-0000000000ba', tank, '2026-10-21', counts, spent, '');
$$;
create function pg_temp.type_id(key text) returns text language sql as $$
  select id::text from package_types where catalog_key = key;
$$;
create function pg_temp.left_in_tank() returns numeric language sql as $$
  select public.tank_balance('a8000000-0000-0000-0000-0000000000ba', 'a8000000-0000-0000-0000-000000000001');
$$;

-- 1. A run that leaves beer in the tank (a cellar person can package)
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c8');
select pg_temp.package('a8000000-0000-0000-0000-0000000000f1',
  jsonb_build_array(jsonb_build_object('type', pg_temp.type_id('keg_half'), 'count', 40)), false);
select is((select volume_bbl from beer_movements where id = 'a8000000-0000-0000-0000-0000000000f1'), 20::numeric,
  '40 half barrel kegs = 20 bbl');
select is(pg_temp.left_in_tank(), 10::numeric, 'and 10 bbl are still in the tank');
select is((select stage from batch_status where id = 'a8000000-0000-0000-0000-0000000000ba'), 'ready',
  'packaging alone never empties the tank: the batch is still in it');

-- 2. Repeating it (an offline retry) changes nothing
select pg_temp.package('a8000000-0000-0000-0000-0000000000f1',
  jsonb_build_array(jsonb_build_object('type', pg_temp.type_id('keg_half'), 'count', 40)), false);
select is((select count(*) from package_counts)::int, 1, 'repeating a run adds nothing');

-- 3. The last run, and "this tank is spent"
select pg_temp.package('a8000000-0000-0000-0000-0000000000f2',
  jsonb_build_array(jsonb_build_object('type', pg_temp.type_id('keg_sixth'), 'count', 12),
                    jsonb_build_object('type', pg_temp.type_id('case_24x16'), 'count', 62)), true);
select is((select round(volume_bbl, 3) from beer_movements where id = 'a8000000-0000-0000-0000-0000000000f2'),
  round(2 + 62 * 3.0 / 31, 3), '12 sixtels and 62 cases');
select is((select round(volume_bbl, 3) from beer_movements where kind = 'loss'), round(10 - 2 - 62 * 3.0 / 31, 3),
  'what was left on paper is recorded as loss');
select is(pg_temp.left_in_tank(), 0::numeric, 'the tank is empty');
select is((select stage from batch_status where id = 'a8000000-0000-0000-0000-0000000000ba'), 'packaged', 'the batch is packaged');
select is((select status from tanks where id = 'a8000000-0000-0000-0000-000000000001'), 'cleaning', 'and the tank goes to cleaning');

-- 4. Guardrails
select throws_ok($$ select pg_temp.package('a8000000-0000-0000-0000-0000000000f3',
  jsonb_build_array(jsonb_build_object('type', pg_temp.type_id('keg_half'), 'count', 1)), false) $$,
  'P0001', 'That batch isn''t in that tank any more.', 'a batch that''s already packaged can''t be packaged again');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e8');
select throws_ok($$ select pg_temp.package('a8000000-0000-0000-0000-0000000000f4', '[]'::jsonb, true) $$,
  '42501', null, 'a viewer can''t package');
update package_types set name = 'Big keg' where catalog_key = 'keg_half';
select is((select name from package_types where catalog_key = 'keg_half'), '½ bbl keg', 'or change package types');

-- 5. Changing a package type later never changes a past run
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a8');
update package_types set volume_bbl = 0.6 where catalog_key = 'keg_half';
select is((select unit_volume_bbl from package_counts where movement_id = 'a8000000-0000-0000-0000-0000000000f1'), 0.5,
  'past runs keep the volume they were packaged with');

select * from finish();
rollback;
