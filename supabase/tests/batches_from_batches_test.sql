-- Tests for splits and blends: a new batch made from part or all of other batches.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a9', 'admin@example.test');
create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a9');
create temp table ids as select public.create_brewery('Blend Brewery') as b;
grant all on ids to authenticated;
insert into tanks (id, brewery_id, name)
select ('a9000000-0000-0000-0000-00000000000' || n)::uuid, b, name from ids,
  (values (1, 'FV-1'), (2, 'FV-2'), (3, 'BT-1'), (4, 'BT-2')) as t(n, name);
insert into beers (id, brewery_id, code, name) select 'a9000000-0000-0000-0000-0000000000be', b, 'ipa', 'IPA' from ids;

-- Batch A: 30 bbl in FV-1, brewed Oct 1. Batch B: 20 bbl in FV-2, brewed Oct 3.
select public.save_batch('a9000000-0000-0000-0000-00000000000a', (select b from ids), '900', 'a9000000-0000-0000-0000-0000000000be',
                         '2026-10-01', 30, 'fermenting', '2026-10-01', 'a9000000-0000-0000-0000-000000000001', '2026-10-01');
select public.save_batch('a9000000-0000-0000-0000-00000000000b', (select b from ids), '901', 'a9000000-0000-0000-0000-0000000000be',
                         '2026-10-03', 20, 'fermenting', '2026-10-03', 'a9000000-0000-0000-0000-000000000002', '2026-10-03');

create function pg_temp.make(id uuid, number text, tank uuid, sources jsonb) returns void language sql as $$
  select public.make_batch_from(id, (select b from ids), number, 'a9000000-0000-0000-0000-0000000000be', tank,
                                'conditioning', '2026-10-15', sources, '');
$$;
create function pg_temp.in_tank(batch uuid, tank uuid) returns numeric language sql as $$ select public.tank_balance(batch, tank) $$;

-- 1. Split: 12 bbl of A into BT-1 as a new batch; A keeps the rest
select pg_temp.make('a9000000-0000-0000-0000-00000000000c', '900-2', 'a9000000-0000-0000-0000-000000000003',
  '[{"batch": "a9000000-0000-0000-0000-00000000000a", "volume": 12, "used_up": false}]');
select is(pg_temp.in_tank('a9000000-0000-0000-0000-00000000000c', 'a9000000-0000-0000-0000-000000000003'), 12::numeric, 'the split holds 12 bbl in BT-1');
select is(pg_temp.in_tank('a9000000-0000-0000-0000-00000000000a', 'a9000000-0000-0000-0000-000000000001'), 18::numeric, 'and the source keeps 18 bbl');
select is((select stage || ' in ' || t.name from batch_status s join tanks t on t.id = s.tank_id where s.id = 'a9000000-0000-0000-0000-00000000000a'),
  'fermenting in FV-1', 'the source stays where it was');
select is((select brew_date from batches where id = 'a9000000-0000-0000-0000-00000000000c'), '2026-10-01'::date, 'the split keeps the brew date');
select is((select source_batch_id from beer_movements where batch_id = 'a9000000-0000-0000-0000-00000000000c' and kind = 'from_batch'),
  'a9000000-0000-0000-0000-00000000000a'::uuid, 'and remembers where it came from');
select is((select count(*) from beer_movements where kind = 'knockout')::int, 2, 'no new beer was "produced" (only the two knockouts)');

-- 2. Repeating it (an offline retry) changes nothing
select pg_temp.make('a9000000-0000-0000-0000-00000000000c', '900-2', 'a9000000-0000-0000-0000-000000000003',
  '[{"batch": "a9000000-0000-0000-0000-00000000000a", "volume": 12, "used_up": false}]');
select is((select count(*) from beer_movements where kind = 'from_batch')::int, 1, 'repeating it adds nothing');

-- 3. Blend: all of A and 19 bbl of B into FV-2 (B's own tank), both used up
select pg_temp.make('a9000000-0000-0000-0000-00000000000d', '900/901', 'a9000000-0000-0000-0000-000000000002',
  '[{"batch": "a9000000-0000-0000-0000-00000000000a", "volume": null, "used_up": true},
    {"batch": "a9000000-0000-0000-0000-00000000000b", "volume": 19, "used_up": true}]');
select is(pg_temp.in_tank('a9000000-0000-0000-0000-00000000000d', 'a9000000-0000-0000-0000-000000000002'), 37::numeric,
  'the blend holds 18 + 19 bbl in FV-2');
select is((select volume_bbl from beer_movements where kind = 'loss' and batch_id = 'a9000000-0000-0000-0000-00000000000b'), 1::numeric,
  'the 1 bbl of B not used is a loss');
select is((select stage from batch_status where id = 'a9000000-0000-0000-0000-00000000000a'), 'used', 'A is used in another batch');
select is((select status from tanks where id = 'a9000000-0000-0000-0000-000000000001'), 'cleaning', 'its tank goes to cleaning');
select is((select status from tanks where id = 'a9000000-0000-0000-0000-000000000002'), 'empty', 'the blend''s own tank doesn''t');

-- 4. Guardrails
select throws_ok($$ select public.save_batch('a9000000-0000-0000-0000-00000000000a', (select b from ids), '900',
  'a9000000-0000-0000-0000-0000000000be', '2026-10-01', 30, 'ready', '2026-10-16', 'a9000000-0000-0000-0000-000000000004', '2026-10-16') $$,
  'P0001', 'This batch was all used in another batch, so it can''t be moved or changed.', 'a used batch can''t be moved');
select throws_ok($$ select public.save_batch('a9000000-0000-0000-0000-00000000000c', (select b from ids), '900-2',
  'a9000000-0000-0000-0000-0000000000be', '2026-10-01', null, 'used', '2026-10-16', null, '2026-10-16') $$,
  'P0001', null, 'only making a new batch can mark a batch used');
select throws_ok($$ select pg_temp.make('a9000000-0000-0000-0000-00000000000e', '900-3', 'a9000000-0000-0000-0000-000000000002',
  '[{"batch": "a9000000-0000-0000-0000-00000000000c", "volume": 2, "used_up": false}]') $$,
  'P0001', null, 'a tank with another batch in it can''t take a new one');
select throws_ok($$ select pg_temp.make('a9000000-0000-0000-0000-00000000000e', '900-3', 'a9000000-0000-0000-0000-000000000003',
  '[{"batch": "a9000000-0000-0000-0000-00000000000c", "volume": 2, "used_up": false}]') $$,
  'P0001', null, 'a batch can''t go into its own tank unless all of it is used');

select * from finish();
rollback;
