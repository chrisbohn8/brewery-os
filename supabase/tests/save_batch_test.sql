-- Tests for save_batch(): saving a batch as one all-or-nothing step.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)
-- Everything happens inside a transaction that is rolled back at the end.

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.test');

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;


select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;

-- Shorthand for one save, with the IDs used throughout
create function pg_temp.save(stage text, started date, tank uuid, action_date date,
                             batch_id uuid default 'b0000000-0000-0000-0000-000000000001',
                             batch_number text default '1042') returns void language sql as $$
  select public.save_batch(batch_id, (select brewery_id from ids), batch_number,
                           'e0000000-0000-0000-0000-000000000001', '2026-09-01', 15,
                           stage, started, tank, action_date);
$$;

insert into tanks (id, brewery_id, name) select 'a0000000-0000-0000-0000-000000000001', brewery_id, 'FV-1' from ids;
insert into tanks (id, brewery_id, name, status) select 'a0000000-0000-0000-0000-000000000002', brewery_id, 'BT-1', 'cleaning' from ids;
insert into beers (id, brewery_id, code, name) select 'e0000000-0000-0000-0000-000000000001', brewery_id, 'house-hazy', 'House Hazy' from ids;

-- 1. New batch: the batch and its first history event, in one call
select pg_temp.save('fermenting', '2026-09-01', 'a0000000-0000-0000-0000-000000000001', '2026-09-01');
select is((select count(*) from batch_events)::int, 1, 'a new batch gets its first history event');
select is((select stage from batch_status), 'fermenting', 'and starts at the chosen stage');

-- 2. Saving the same thing again (like an offline retry) changes nothing
select pg_temp.save('fermenting', '2026-09-01', 'a0000000-0000-0000-0000-000000000001', '2026-09-02');
select is((select count(*) from batch_events)::int, 1, 'repeating a save does not add a second event');

-- 3. Stage change: a new event dated the stage's start date
select pg_temp.save('conditioning', '2026-09-10', 'a0000000-0000-0000-0000-000000000001', '2026-09-11');
select is((select stage_started_on from batch_status), '2026-09-10'::date, 'a stage change is dated by its stage-started date');

-- 4. Transfer to BT-1 (marked cleaning): dated by the action date, keeps days-in-stage, updates both tanks
select pg_temp.save('conditioning', '2026-09-10', 'a0000000-0000-0000-0000-000000000002', '2026-09-15');
select is((select tank_id from batch_status), 'a0000000-0000-0000-0000-000000000002'::uuid, 'transfer moves the batch to the new tank');
select is((select max(effective_date) from batch_events), '2026-09-15'::date, 'a transfer is dated by the day it was done (not the day it synced)');
select is((select stage_started_on from batch_status), '2026-09-10'::date, 'a transfer keeps the days-in-stage counter');
select is((select status from tanks where name = 'FV-1'), 'cleaning', 'the tank the beer left is marked cleaning');
select is((select status from tanks where name = 'BT-1'), 'empty', 'the tank the beer entered is no longer marked cleaning');

-- 5. Correcting the stage start date moves the event, doesn't add one
select pg_temp.save('conditioning', '2026-09-09', 'a0000000-0000-0000-0000-000000000002', '2026-09-16');
select is((select stage_started_on from batch_status), '2026-09-09'::date, 'a date correction changes the stage start');
select is((select count(*) from batch_events)::int, 3, 'and adds no event');

-- 6. A second batch can't go into the occupied tank, and the failed save leaves no trace
select throws_like(
  $$ select pg_temp.save('fermenting', '2026-09-20', 'a0000000-0000-0000-0000-000000000002', '2026-09-20',
                         'b0000000-0000-0000-0000-000000000002', '1043') $$,
  '%BT-1 already has House Hazy%', 'a batch cannot go into a tank that already has beer');
select is((select count(*) from batches)::int, 1, 'the rejected save left nothing behind (all or nothing)');

-- 7. Packaging: out of the tank, tank marked cleaning
select pg_temp.save('packaged', '2026-09-25', 'a0000000-0000-0000-0000-000000000002', '2026-09-25');
select ok((select tank_id is null from batch_status), 'packaged beer is in no tank');
select is((select status from tanks where name = 'BT-1'), 'cleaning', 'packaging marks the tank cleaning');

-- 8. A viewer gets a clear "no permission"
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-00000000000c', 'viewer' from ids;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select throws_ok(
  $$ select pg_temp.save('fermenting', '2026-09-01', 'a0000000-0000-0000-0000-000000000001', '2026-09-01',
                         'b0000000-0000-0000-0000-000000000003', '2000') $$,
  '42501', 'You don''t have permission to start batches or change batch details.', 'viewers cannot save batches');

select * from finish();
rollback;
