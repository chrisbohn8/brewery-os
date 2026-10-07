-- Tests for the brew log: brewhouse settings, readings (with history), the cellar log
-- (including stage changes, all or nothing), and additions.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a5', 'head@example.test'),    -- admin
  ('00000000-0000-0000-0000-0000000000b5', 'brewer@example.test'),  -- brewer
  ('00000000-0000-0000-0000-0000000000c5', 'cellar@example.test'),  -- cellar
  ('00000000-0000-0000-0000-0000000000f5', 'viewer@example.test'),  -- viewer
  ('00000000-0000-0000-0000-0000000000d5', 'outside@example.test'); -- another brewery

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5');
create temp table ids as select public.create_brewery('Log Brewery') as b;
grant all on ids to authenticated;
insert into locations (id, brewery_id, name, turn_size_bbl, usual_turns, kettle_full_bbl, flow_target, water_grist_qt_lb, grain_absorption_gal_lb)
  select 'a5000000-0000-0000-0000-000000000001', b, 'Main', 15, 2, 16, '6.6 - 5.5 - 6.2', 1.234, 0.125 from ids;
select is((select usual_turns || ' turns of ' || turn_size_bbl || ' bbl' from locations), '2 turns of 15 bbl',
  'a location keeps its brewhouse settings');
insert into tanks (id, brewery_id, name, location_id) select 'a5000000-0000-0000-0000-0000000000f1', b, 'FV-1', 'a5000000-0000-0000-0000-000000000001' from ids;
insert into beers (id, brewery_id, code, name) select 'a5000000-0000-0000-0000-0000000000be', b, 'pils', 'Pils' from ids;
select public.save_batch('a5000000-0000-0000-0000-0000000000ba', (select b from ids), '500', 'a5000000-0000-0000-0000-0000000000be',
                         '2026-10-01', 30, 'fermenting', '2026-10-01', 'a5000000-0000-0000-0000-0000000000f1', '2026-10-01');
update batches set turns = 2;
select is((select turns from batches), 2, 'a batch records how many turns it was brewed in');

set local role postgres;
insert into memberships (brewery_id, user_id, role) select b, u, r from ids, (values
  ('00000000-0000-0000-0000-0000000000b5'::uuid, 'brewer'),
  ('00000000-0000-0000-0000-0000000000c5'::uuid, 'cellar'),
  ('00000000-0000-0000-0000-0000000000f5'::uuid, 'viewer')) as v(u, r);

-- ---------- Readings: per turn, with history ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b5');  -- brewer
insert into batch_readings (brewery_id, batch_id, turn, field_key, value) select b, 'a5000000-0000-0000-0000-0000000000ba', 1, 'mash_temp', 66.7 from ids;
insert into batch_readings (brewery_id, batch_id, turn, field_key, value) select b, 'a5000000-0000-0000-0000-0000000000ba', 2, 'mash_temp', 66.4 from ids;
insert into batch_readings (brewery_id, batch_id, turn, field_key, value, raw)
  select b, 'a5000000-0000-0000-0000-0000000000ba', 1, 'mash_water_volume', 4.8387, '{"start": 150, "end": 300}' from ids;
select is((select count(*) from batch_readings_current where field_key = 'mash_temp')::int, 2, 'a reading per turn');
-- A correction: a new row, and the newest is current
insert into batch_readings (brewery_id, batch_id, turn, field_key, value, recorded_at)
  select b, 'a5000000-0000-0000-0000-0000000000ba', 1, 'mash_temp', 66.1, now() + interval '1 second' from ids;
select is((select value from batch_readings_current where field_key = 'mash_temp' and turn = 1), 66.1::numeric, 'the newest reading is current');
select is((select count(*) from batch_readings where field_key = 'mash_temp' and turn = 1)::int, 2, 'and the old value stays as history');
select is((select raw ->> 'start' from batch_readings_current where field_key = 'mash_water_volume'), '150', 'what was typed (meter start/end) is kept');
select throws_ok($$ insert into batch_readings (brewery_id, batch_id, field_key, value) select b, 'a5000000-0000-0000-0000-0000000000ba', 'Bad Key!', 1 from ids $$,
  '23514', null, 'field names are checked');
update batch_readings set value = 1;
select is((select count(*) from batch_readings where value = 1)::int, 0, 'readings can''t be edited in place (corrections are new rows)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c5');  -- cellar
select throws_ok($$ insert into batch_readings (brewery_id, batch_id, turn, field_key, value) select b, 'a5000000-0000-0000-0000-0000000000ba', 1, 'ko_gravity', 1.05 from ids $$,
  '42501', null, 'brew-day readings need the brew-day permission (start batches), which cellar doesn''t have by default');

-- ---------- Cellar log ----------
select lives_ok($$ select public.log_cellar_entry('a5000000-0000-0000-0000-0000000000c1', (select b from ids), 'a5000000-0000-0000-0000-0000000000ba',
                   '2026-10-03', 'Check', 1.030, 4.6, 18.5, 'FR to 62', 'smells great', null) $$, 'cellar can log a check');
select lives_ok($$ select public.log_cellar_entry('a5000000-0000-0000-0000-0000000000c2', (select b from ids), 'a5000000-0000-0000-0000-0000000000ba',
                   '2026-10-05', 'Dry hop', null, null, null, '', 'DH1', 'dry-hopping') $$, 'cellar can log a dry hop that moves the stage');
select is((select stage from batch_status), 'dry-hopping', 'the batch is now dry hopping');
select is((select stage_started_on from batch_status), '2026-10-05'::date, 'dated by the entry');
-- Sending the same entry again (offline retry) changes nothing
select public.log_cellar_entry('a5000000-0000-0000-0000-0000000000c2', (select b from ids), 'a5000000-0000-0000-0000-0000000000ba',
                               '2026-10-05', 'Dry hop', null, null, null, '', 'DH1', 'dry-hopping');
select is((select count(*) from cellar_entries)::int || '/' || (select count(*) from batch_events)::int, '2/2',
  'repeating an entry adds nothing (2 entries, 2 history events)');
select throws_like($$ select public.log_cellar_entry(gen_random_uuid(), (select b from ids), 'a5000000-0000-0000-0000-0000000000ba',
                   '2026-10-06', 'Package', null, null, null, '', '', 'packaged') $$, '%can''t move a batch to%',
  'packaging isn''t done from the cellar log');
select is((select count(*) from cellar_entries)::int, 2, 'and the refused entry left nothing behind (all or nothing)');

-- ---------- Additions ----------
select lives_ok($$ insert into batch_additions (brewery_id, batch_id, added_on, kind, name, amount, unit, timing, lot)
                   select b, 'a5000000-0000-0000-0000-0000000000ba', '2026-10-05', 'hop', 'Citra', 176, 'oz', 'Primary', 'L123' from ids $$,
  'cellar can record a dry hop addition with its lot');

-- ---------- Viewers and other breweries ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f5');  -- viewer
select throws_ok($$ select public.log_cellar_entry(gen_random_uuid(), (select b from ids), 'a5000000-0000-0000-0000-0000000000ba',
                   '2026-10-06', 'Check', null, null, null, '', '', null) $$, '42501', null, 'a viewer can''t log cellar work');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d5');  -- outsider
select is((select count(*) from batch_readings)::int + (select count(*) from cellar_entries)::int + (select count(*) from batch_additions)::int, 0,
  'another brewery sees none of it');

select has_column('public', 'batch_status', 'turns', 'the batch list includes how many turns each batch has');

select has_column('public', 'batch_additions', 'brew_day', 'additions can be marked as brew-day ingredients');
select col_has_check('public', 'batch_additions', 'turn', 'and say which turn');

select * from finish();
rollback;
