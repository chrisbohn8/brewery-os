-- Tests for the beer movement ledger: volumes in tanks are worked out from knockouts, transfers,
-- packaging, and losses, all recorded by save_batch() in the same all-or-nothing step.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a7', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000d7', 'outsider@example.test');

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
create temp table ids as select public.create_brewery('Ledger Brewery') as b;
grant all on ids to authenticated;
insert into tanks (id, brewery_id, name) select 'a7000000-0000-0000-0000-000000000001', b, 'FV-1' from ids;
insert into tanks (id, brewery_id, name) select 'a7000000-0000-0000-0000-000000000002', b, 'BT-1' from ids;
insert into tanks (id, brewery_id, name) select 'a7000000-0000-0000-0000-000000000003', b, 'BT-2' from ids;
insert into beers (id, brewery_id, code, name) select 'a7000000-0000-0000-0000-0000000000be', b, 'amber', 'Amber' from ids;

-- One save: stage, tank, date, and optionally the volume moved
create function pg_temp.save(stage text, tank uuid, on_date date, volume numeric default null,
                             batch_id uuid default 'a7000000-0000-0000-0000-0000000000ba', size numeric default 30)
returns void language sql as $$
  select public.save_batch(batch_id, (select b from ids), right(batch_id::text, 3), 'a7000000-0000-0000-0000-0000000000be',
                           '2026-10-01', size, stage, on_date, tank, on_date, volume);
$$;
create function pg_temp.in_tank(tank uuid, batch_id uuid default 'a7000000-0000-0000-0000-0000000000ba') returns numeric
language sql as $$ select public.tank_balance(batch_id, tank) $$;

-- 1. Knockout
select pg_temp.save('fermenting', 'a7000000-0000-0000-0000-000000000001', '2026-10-01');
select is((select kind from beer_movements), 'knockout', 'a new batch is knocked out into its tank');
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000001'), 30::numeric, 'with no volume typed, the tank holds the batch size');
insert into batch_readings (brewery_id, batch_id, field_key, value)
select b, 'a7000000-0000-0000-0000-0000000000ba', 'ko_volume', 31 from ids;
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000001'), 31::numeric, 'the brew sheet''s knockout volume wins over the batch size');

-- 2. A repeated save (an offline retry) adds nothing
select pg_temp.save('fermenting', 'a7000000-0000-0000-0000-000000000001', '2026-10-01');
select is((select count(*) from beer_movements)::int, 1, 'repeating a save adds no movement');

-- 3. Transfer a measured volume: the rest is left behind as loss
select pg_temp.save('conditioning', 'a7000000-0000-0000-0000-000000000002', '2026-10-10', 29.5);
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000002'), 29.5, 'the new tank holds what was moved');
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000001'), 0::numeric, 'the old tank is empty');
select is((select volume_bbl from beer_movements where kind = 'loss'), 1.5, 'the 1.5 bbl left behind is a loss');

-- 4. Transfer with no volume typed: all of it moves
select pg_temp.save('conditioning', 'a7000000-0000-0000-0000-000000000003', '2026-10-12');
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000003'), 29.5, '"all of it" moves the whole balance');
select is((select count(*) from beer_movements where kind = 'loss')::int, 1, 'and leaves nothing behind');

-- 5. More moved than recorded: a correction, not a negative tank
select pg_temp.save('conditioning', 'a7000000-0000-0000-0000-000000000002', '2026-10-13', 30);
select is((select volume_bbl from beer_movements where kind = 'correction'), 0.5, 'moving more than recorded adds a correction');
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000003'), 0::numeric, 'so the old tank ends at zero, not below');

-- 6. Packaging takes it out of the tanks
select pg_temp.save('packaged', null, '2026-10-20', 28);
select is((select volume_bbl from beer_movements where kind = 'package'), 28::numeric, 'packaging records the volume packaged');
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000002'), 0::numeric, 'and what was left is recorded as loss');

-- 7. Unknown volumes stay unknown, without breaking anything
select pg_temp.save('fermenting', 'a7000000-0000-0000-0000-000000000001', '2026-10-21', null,
                    'a7000000-0000-0000-0000-0000000000bb', null);
select is(pg_temp.in_tank('a7000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-0000000000bb'), null::numeric,
  'a batch with no volume anywhere shows as "not recorded"');

select throws_ok($$ select pg_temp.save('conditioning', 'a7000000-0000-0000-0000-000000000002', '2026-10-22', -1,
                                         'a7000000-0000-0000-0000-0000000000bb', null) $$,
  'P0001', 'A volume can''t be negative.', 'negative volumes are refused');

-- 8. Another brewery sees none of it
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d7');
select is((select count(*) from beer_movements)::int, 0, 'another brewery sees no movements');

select * from finish();
rollback;
