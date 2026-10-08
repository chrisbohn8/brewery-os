-- Tests for gravity triggers (gravity_due, and the gravity_due alert).
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');   -- not in the brewery

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
set local role postgres;
update breweries set gravity_unit = 'plato' where id = (select brewery_id from ids);
insert into tanks (id, brewery_id, name) select '55555555-0000-0000-0000-000000000001', brewery_id, 'FV1' from ids;
insert into beers (id, brewery_id, code, name) select '55555555-0000-0000-0000-000000000002', brewery_id, 'ipa', 'IPA' from ids;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date)
  select '55555555-0000-0000-0000-000000000003', brewery_id, '1042', '55555555-0000-0000-0000-000000000002', current_date - 5 from ids;
insert into batch_events (brewery_id, batch_id, effective_date, stage, tank_id)
  select brewery_id, '55555555-0000-0000-0000-000000000003', current_date - 5, 'fermenting', '55555555-0000-0000-0000-000000000001' from ids;
-- The IPA's schedule: dry hop on day 5, or at 1.016 SG (about 4.1 °P)
insert into beer_schedules (brewery_id, beer_id, steps)
  select brewery_id, '55555555-0000-0000-0000-000000000002', '[{"kind": "dry_hop", "day": 5, "gravity": 1.016}, {"kind": "package", "day": 14}]' from ids;
create function pg_temp.reading(sg numeric, days_ago int) returns void language sql as $$
  insert into cellar_entries (brewery_id, batch_id, occurred_on, gravity_sg)
  select brewery_id, '55555555-0000-0000-0000-000000000003', current_date - days_ago, sg from ids;
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select is((select count(*) from gravity_due((select brewery_id from ids)))::int, 0, 'no readings yet: nothing due');
set local role postgres;
select pg_temp.reading(1.020, 2);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select is((select count(*) from gravity_due((select brewery_id from ids)))::int, 0, 'above the trigger: not yet');
set local role postgres;
select pg_temp.reading(1.015, 1);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select is((select kind from gravity_due((select brewery_id from ids))), 'dry_hop', 'a reading at or below it: the dry hop is due');

-- The alert says where, what, and the numbers in the brewery's unit
select public.check_alerts((select brewery_id from ids));
select is((select title || ' / ' || detail from alerts where kind = 'gravity_due'),
  'FV1: Dry hop due / IPA #1042 is at 3.8 °P (the schedule says dry hop at 4.1 °P).', 'the alert says where, what, and the numbers');

-- Two readings in a row: the one before was above, so not yet; another below, and it's due
set local role postgres;
update breweries set gravity_trigger_readings = 2 where id = (select brewery_id from ids);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select is((select count(*) from gravity_due((select brewery_id from ids)))::int, 0, 'set to two in a row: one low reading isn''t enough');
set local role postgres;
select pg_temp.reading(1.0145, 0);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select is((select count(*) from gravity_due((select brewery_id from ids)))::int, 1, 'two low readings in a row: due');

-- Once it's dry hopping, the step is done: no longer due, and the alert clears
set local role postgres;
insert into batch_events (brewery_id, batch_id, effective_date, stage, tank_id)
  select brewery_id, '55555555-0000-0000-0000-000000000003', current_date, 'dry-hopping', '55555555-0000-0000-0000-000000000001' from ids;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select is((select count(*) from gravity_due((select brewery_id from ids)))::int, 0, 'dry hopping now: done, not due');
select public.check_alerts((select brewery_id from ids));
select is((select count(*) from alerts where kind = 'gravity_due' and resolved_at is null)::int, 0, 'and the alert clears by itself');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');
select is((select count(*) from gravity_due((select brewery_id from ids)))::int, 0, 'someone outside the brewery sees nothing');

select * from finish();
rollback;
