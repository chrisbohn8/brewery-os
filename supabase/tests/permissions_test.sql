-- Tests for permission levels and per-person adjustments.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(25);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a3', 'john@example.test'),   -- admin
  ('00000000-0000-0000-0000-0000000000c3', 'david@example.test'),  -- cellar
  ('00000000-0000-0000-0000-0000000000c4', 'erin@example.test'),   -- cellar
  ('00000000-0000-0000-0000-0000000000b3', 'bea@example.test'),    -- brewer
  ('00000000-0000-0000-0000-0000000000e3', 'hank@example.test'),   -- head brewer
  ('00000000-0000-0000-0000-0000000000f3', 'vic@example.test');    -- viewer

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;

-- John creates the brewery and some equipment
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
create temp table ids as select public.create_brewery('Perm Brewery') as b;
grant all on ids to authenticated;
insert into tanks (id, brewery_id, name) select 'a3000000-0000-0000-0000-000000000001', b, 'FV-1' from ids;
insert into tanks (id, brewery_id, name) select 'a3000000-0000-0000-0000-000000000002', b, 'BT-1' from ids;
insert into beers (id, brewery_id, code, name) select 'e3000000-0000-0000-0000-000000000001', b, 'lager', 'Lager' from ids;

set local role postgres;
insert into memberships (brewery_id, user_id, role) select b, u, r from ids, (values
  ('00000000-0000-0000-0000-0000000000c3'::uuid, 'cellar'),
  ('00000000-0000-0000-0000-0000000000c4'::uuid, 'cellar'),
  ('00000000-0000-0000-0000-0000000000b3'::uuid, 'brewer'),
  ('00000000-0000-0000-0000-0000000000e3'::uuid, 'head_brewer'),
  ('00000000-0000-0000-0000-0000000000f3'::uuid, 'viewer')) as v(u, r);

create function pg_temp.save(stage text, tank uuid, batch_number text default '100',
                             batch_id uuid default 'b3000000-0000-0000-0000-000000000001') returns void language sql as $$
  select public.save_batch(batch_id, (select b from ids), batch_number, 'e3000000-0000-0000-0000-000000000001',
                           '2026-10-01', 15, stage, '2026-10-01', tank, '2026-10-01');
$$;

-- ---------- Levels do what they say ----------
select is(public.my_permissions((select b from ids)),
  (select array_agg(p order by p) from unnest(public.permission_list()) p), 'an admin has every permission');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b3');  -- Bea, brewer
select lives_ok($$ select pg_temp.save('fermenting', 'a3000000-0000-0000-0000-000000000001') $$, 'a brewer can start a batch');
select throws_ok($$ insert into beers (brewery_id, code, name) select b, 'ipa', 'IPA' from ids $$, '42501', null,
  'a brewer cannot add beers (head brewer and up)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');  -- David, cellar
select throws_ok($$ select pg_temp.save('fermenting', 'a3000000-0000-0000-0000-000000000002', '101',
                                        'b3000000-0000-0000-0000-000000000002') $$,
  '42501', 'You don''t have permission to start batches or change batch details.', 'cellar cannot start a batch');
select throws_ok($$ select pg_temp.save('fermenting', 'a3000000-0000-0000-0000-000000000001', '999') $$,
  '42501', null, 'cellar cannot change a batch''s number');
select lives_ok($$ select pg_temp.save('conditioning', 'a3000000-0000-0000-0000-000000000002') $$,
  'cellar CAN transfer a batch and change its stage');
select is((select status from tanks where name = 'FV-1'), 'cleaning', 'and the tank it left is marked cleaning');
select lives_ok($$ update tanks set status = 'empty' where name = 'FV-1' $$, 'cellar can set a tank''s status');
select throws_ok($$ update tanks set name = 'FV-ONE' where name = 'FV-1' $$, '42501',
  'You don''t have permission to change tank details.', 'but cannot rename a tank');
select throws_ok($$ update tanks set acid_every_turns = 3 where name = 'FV-1' $$, '42501', null,
  'or change its acid rule');
select lives_ok($$ insert into tank_cleanings (brewery_id, tank_id, cleaned_on) select b, 'a3000000-0000-0000-0000-000000000001', '2026-10-02' from ids $$,
  'cellar can log an acid cycle');
select lives_ok($$ select pg_temp.save('packaged', null) $$, 'cellar CAN package');
-- (row rules quietly skip rows you may not delete, so check the batch survives)
delete from batches where batch_number = '100';
select is((select count(*) from batches where batch_number = '100')::int, 1, 'cellar cannot delete batches (the row survives)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');  -- Hank, head brewer
select lives_ok($$ insert into beers (brewery_id, code, name) select b, 'ipa', 'IPA' from ids $$, 'a head brewer can add beers');
select lives_ok($$ update tanks set name = 'FV-1A', acid_every_turns = 4 where name = 'FV-1' $$, 'and change tank details and acid rules');
select throws_ok($$ update breweries set name = 'Hank''s Brewery' $$, '42501', 'You don''t have permission to rename the brewery.',
  'but cannot rename the brewery');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');  -- Vic, viewer
select is(public.my_permissions((select b from ids)), '{}'::text[], 'a viewer has no permissions');
select throws_ok($$ select pg_temp.save('fermenting', 'a3000000-0000-0000-0000-000000000002') $$, '42501', null,
  'a viewer cannot move beer');

-- ---------- Adjusting one person ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
update memberships set grants = array['start_batch'], revokes = array['package']
 where user_id = '00000000-0000-0000-0000-0000000000c3';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');  -- David again
select ok('start_batch' = any(public.my_permissions((select b from ids))), 'David (cellar + start batches) can now start batches');
select ok(not 'package' = any(public.my_permissions((select b from ids))), 'and can no longer package');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c4');  -- Erin, also cellar
select ok('package' = any(public.my_permissions((select b from ids))) and not 'start_batch' = any(public.my_permissions((select b from ids))),
  'Erin (plain cellar) is unaffected by David''s adjustments');

-- ---------- Changing a whole level ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
insert into role_levels (brewery_id, level, permissions)
  select b, 'cellar', public.default_permissions('cellar') || array['manage_beers'] from ids;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c4');
select ok('manage_beers' = any(public.my_permissions((select b from ids))), 'changing the Cellar level gives Erin the new permission');

-- ---------- Nobody but an admin can change permissions ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e3');  -- Hank, head brewer
update memberships set role = 'admin' where user_id = '00000000-0000-0000-0000-0000000000e3';
select is((select role from memberships where user_id = '00000000-0000-0000-0000-0000000000e3'), 'head_brewer',
  'a head brewer cannot make themself an admin');
select throws_ok($$ insert into role_levels (brewery_id, level, permissions) select b, 'head_brewer', public.permission_list() from ids $$,
  '42501', null, 'or give their level more permissions');
set local role postgres;
select throws_ok($$ update memberships set grants = array['bogus'] where user_id = '00000000-0000-0000-0000-0000000000c4' $$,
  '23514', null, 'unknown permission names are rejected');

select * from finish();
rollback;
