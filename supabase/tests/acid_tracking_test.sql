-- Tests for acid tracking: logging acid cycles, the tank and brewery settings,
-- and that breweries and roles can't reach what they shouldn't.
--
-- Run with:  supabase test db  (local)  or  supabase test db --linked  (online)
-- Everything happens inside a transaction that is rolled back at the end.

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

-- ---------- Setup ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin of brewery A
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test'),    -- admin of brewery B
  ('00000000-0000-0000-0000-0000000000c1', 'carol@example.test'),  -- viewer at brewery A
  ('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');   -- brewer at brewery A

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.act_as_owner() returns void language sql as $$
  select set_config('role', 'postgres', true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table ids as select public.create_brewery('Brewery A') as brewery_a;
grant all on ids to authenticated, anon;
insert into tanks (id, brewery_id, name) select '21000000-0000-0000-0000-000000000001', brewery_a, 'FV-1' from ids;
insert into tanks (id, brewery_id, name) select '21000000-0000-0000-0000-000000000002', brewery_a, 'FV-2' from ids;

select pg_temp.act_as_owner();
insert into memberships (brewery_id, user_id, role)
  select brewery_a, '00000000-0000-0000-0000-0000000000c1'::uuid, 'viewer' from ids
  union all
  select brewery_a, '00000000-0000-0000-0000-0000000000d1'::uuid, 'brewer' from ids;

-- ---------- Alice (admin) ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

select lives_ok(
  $$ insert into tank_cleanings (brewery_id, tank_id, cleaned_on, note)
     select brewery_a, '21000000-0000-0000-0000-000000000001', '2026-10-01', 'Acid after the sour' from ids $$,
  'a brewery member can log an acid cycle');
select is((select kind from tank_cleanings limit 1), 'acid', 'a cleaning is an acid cycle by default');

select lives_ok(
  $$ update tanks set acid_every_turns = 4 where id = '21000000-0000-0000-0000-000000000001' $$,
  'a tank can be set to need acid every 4 turns');
select throws_ok(
  $$ update tanks set acid_every_turns = 0 where id = '21000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'zero turns is rejected');

select throws_ok(
  $$ insert into tank_cleanings (brewery_id, tank_id, kind, cleaned_on)
     select brewery_a, '21000000-0000-0000-0000-000000000001', 'mystery', '2026-10-01' from ids $$,
  '23514', null, 'unknown cleaning kinds are rejected');

update breweries set acid_after_styles = array['Sour', 'Brett'] where id = (select brewery_a from ids);
select is((select acid_after_styles from breweries where id = (select brewery_a from ids)), array['Sour', 'Brett'],
  'an admin can set the brewery''s acid-after styles');

-- ---------- Dave (brewer) can log acid but can't change brewery settings ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select lives_ok(
  $$ insert into tank_cleanings (brewery_id, tank_id, cleaned_on)
     select brewery_a, '21000000-0000-0000-0000-000000000002', '2026-10-02' from ids $$,
  'a brewer can log an acid cycle');
update breweries set acid_after_styles = '{}' where id = (select brewery_a from ids);
select is((select acid_after_styles from breweries where id = (select brewery_a from ids)), array['Sour', 'Brett'],
  'a brewer cannot change the brewery''s acid-after styles');

-- ---------- Carol (viewer) can read but not write ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*) from tank_cleanings)::int, 2, 'a viewer can see the acid log');
select throws_ok(
  $$ insert into tank_cleanings (brewery_id, tank_id, cleaned_on)
     select brewery_a, '21000000-0000-0000-0000-000000000001', '2026-10-03' from ids $$,
  '42501', null, 'a viewer cannot log an acid cycle');

-- ---------- Bob (another brewery) sees and touches nothing ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select public.create_brewery('Brewery B');
select is((select count(*) from tank_cleanings)::int, 0, 'another brewery sees none of the acid log');
select throws_ok(
  $$ insert into tank_cleanings (brewery_id, tank_id, cleaned_on)
     select brewery_a, '21000000-0000-0000-0000-000000000001', '2026-10-03' from ids $$,
  '42501', null, 'another brewery cannot log acid on these tanks');

select * from finish();
rollback;
