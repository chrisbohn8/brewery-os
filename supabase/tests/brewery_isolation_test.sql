-- Tests that breweries can't see or touch each other's data, that roles are enforced,
-- and that batch history works out the current stage correctly.
--
-- Run with:  supabase test db --linked
-- Everything here happens inside a transaction that is rolled back at the end,
-- so the test users and breweries never actually stay in the database.

begin;
-- The test runner signs in as a limited login user; switch to the main database user
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(40);

-- ---------- Setup: three pretend people ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.test'),  -- admin of brewery A
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.test'),    -- admin of brewery B
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.test');  -- viewer at brewery A

-- "Act as" a signed-in person: same role and identity the app's requests would have
create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;

-- ---------- Alice sets up brewery A ----------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table ids as select public.create_brewery('Brewery A') as brewery_a;
grant all on ids to authenticated, anon;

insert into locations (id, brewery_id, name)
  select '10000000-0000-0000-0000-000000000001', brewery_a, 'Downtown' from ids;
insert into tanks (id, brewery_id, location_id, name, capacity_bbl)
  select '20000000-0000-0000-0000-000000000001', brewery_a, '10000000-0000-0000-0000-000000000001', 'FV-1', 15 from ids;
insert into tanks (id, brewery_id, location_id, name, type, capacity_bbl)
  select '20000000-0000-0000-0000-000000000002', brewery_a, '10000000-0000-0000-0000-000000000001', 'BT-1', 'brite', 15 from ids;
insert into beers (id, brewery_id, code, name, style, target_og, target_fg)
  select '30000000-0000-0000-0000-000000000001', brewery_a, 'house-hazy', 'House Hazy', 'Hazy IPA', 1.066, 1.016 from ids;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date, size_bbl)
  select '40000000-0000-0000-0000-000000000001', brewery_a, '1042', '30000000-0000-0000-0000-000000000001', '2026-09-01', 15 from ids;

-- History: fermenting in FV-1 (Sep 1) → conditioning in FV-1 (Sep 10) → transferred to BT-1, still conditioning (Sep 15)
insert into batch_events (brewery_id, batch_id, effective_date, stage, tank_id)
  select brewery_a, '40000000-0000-0000-0000-000000000001', d::date, s, t::uuid from ids, (values
    ('2026-09-01', 'fermenting',   '20000000-0000-0000-0000-000000000001'),
    ('2026-09-10', 'conditioning', '20000000-0000-0000-0000-000000000001'),
    ('2026-09-15', 'conditioning', '20000000-0000-0000-0000-000000000002')
  ) as v(d, s, t);

select is((select stage from batch_status where batch_number = '1042'), 'conditioning',
  'batch_status shows the newest stage');
select is((select tank_id from batch_status where batch_number = '1042'), '20000000-0000-0000-0000-000000000002'::uuid,
  'batch_status shows the newest tank');
select is((select stage_started_on from batch_status where batch_number = '1042'), '2026-09-10'::date,
  'a transfer without a stage change does not reset days-in-stage');

select throws_ok(
  $$ insert into batches (brewery_id, batch_number, beer_id, brew_date)
     select brewery_a, '1042', '30000000-0000-0000-0000-000000000001', '2026-10-01' from ids $$,
  '23505', null, 'duplicate batch numbers are rejected');

select throws_ok(
  $$ delete from tanks where id = '20000000-0000-0000-0000-000000000001' $$,
  '23503', null, 'a tank with batch history cannot be deleted');

-- ---------- Bob sets up brewery B, and tries to reach brewery A ----------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
create temp table ids_b as select public.create_brewery('Brewery B') as brewery_b;

select is((select count(*) from breweries)::int, 1, 'Bob sees only his own brewery');
select is((select count(*) from tanks)::int, 0, 'Bob sees none of brewery A''s tanks');
select is((select count(*) from batches)::int, 0, 'Bob sees none of brewery A''s batches');
select is((select count(*) from batch_status)::int, 0, 'Bob sees nothing through the batch_status view either');

select throws_ok(
  $$ insert into tanks (brewery_id, name) select brewery_a, 'Sneaky tank' from ids $$,
  '42501', null, 'Bob cannot add a tank to brewery A');

update tanks set name = 'Hacked' where id = '20000000-0000-0000-0000-000000000001';
delete from beers where id = '30000000-0000-0000-0000-000000000001';

-- Bob's own beer and batch, then try to point his batch's history at brewery A's tank
insert into beers (id, brewery_id, code, name)
  select '30000000-0000-0000-0000-0000000000b1', brewery_b, 'lager', 'Lager' from ids_b;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date)
  select '40000000-0000-0000-0000-0000000000b1', brewery_b, '1', '30000000-0000-0000-0000-0000000000b1', '2026-10-01' from ids_b;
select throws_ok(
  $$ insert into batch_events (brewery_id, batch_id, effective_date, stage, tank_id)
     select brewery_b, '40000000-0000-0000-0000-0000000000b1', '2026-10-01', 'fermenting',
            '20000000-0000-0000-0000-000000000001' from ids_b $$,
  '23503', null, 'Bob cannot link his batch to brewery A''s tank');

-- ---------- Back to Alice: Bob's attempts changed nothing ----------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is((select name from tanks where id = '20000000-0000-0000-0000-000000000001'), 'FV-1',
  'Bob''s attempt to rename brewery A''s tank did nothing');
select is((select count(*) from beers)::int, 1, 'Bob''s attempt to delete brewery A''s beer did nothing');

-- Alice adds Carol as a viewer
insert into memberships (brewery_id, user_id, role)
  select brewery_a, '00000000-0000-0000-0000-00000000000c', 'viewer' from ids;

-- ---------- Carol (viewer) can look but not change ----------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select is((select count(*) from tanks)::int, 2, 'a viewer can see their brewery''s tanks');
select throws_ok(
  $$ insert into locations (brewery_id, name) select brewery_a, 'Annex' from ids $$,
  '42501', null, 'a viewer cannot add anything');

-- ---------- Someone not signed in sees nothing ----------
select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*) from tanks)::int, 0, 'signed-out visitors see no tanks');
select throws_ok($$ select public.create_brewery('Anon brewery') $$, '42501', null,
  'signed-out visitors cannot create a brewery');

-- Signed-out visitors can't even run the functions that need a sign-in (a second lock behind
-- each function's own check). If this fails after restoring a backup, run supabase/after-restore.sql.
set local role postgres;
select ok(not has_function_privilege('anon', p.oid, 'execute'), 'signed-out visitors cannot run ' || p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('create_brewery', 'accept_invites', 'brewery_members', 'my_permissions', 'save_batch', 'log_cellar_entry', 'record_packaging', 'record_level_check', 'make_batch_from', 'record_stock', 'record_count', 'set_place_order', 'create_api_key', 'revoke_api_key', 'check_alerts', 'acknowledge_alert', 'new_join_code', 'join_with_code', 'delete_brewery', 'load_into_brewery', 'plan_needs', 'plan_shortfalls', 'gravity_due')
 order by p.proname;

select * from finish();
rollback;
