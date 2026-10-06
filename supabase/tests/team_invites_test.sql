-- Tests for inviting coworkers and managing roles.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),   -- admin of brewery A
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test'),     -- invited as brewer
  ('00000000-0000-0000-0000-0000000000c1', 'carol@example.test'),   -- invited as viewer
  ('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');    -- not invited

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

-- Alice creates brewery A and invites Bob (brewer) and Carol (viewer)
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
insert into invites (brewery_id, email, role) select brewery_id, 'bob@example.test', 'brewer' from ids;
insert into invites (brewery_id, email, role) select brewery_id, 'carol@example.test', 'viewer' from ids;
select is((select count(*) from invites)::int, 2, 'an admin can invite people');
select throws_ok(
  $$ insert into invites (brewery_id, email) select brewery_id, 'Bob@Example.test' from ids $$,
  '23514', null, 'emails must be stored in lower case (the app lower-cases them)');

-- Dave (not invited) can't see the invites or accept them
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');
select is((select count(*) from invites)::int, 0, 'someone outside the brewery sees no invites');
select is(public.accept_invites(), 0, 'accepting with no invite joins nothing');
select is((select count(*) from memberships)::int, 0, 'Dave is in no brewery');
select is((select count(*) from public.brewery_members((select brewery_id from ids))), 0::bigint, 'Dave cannot list brewery A''s members');

-- Bob signs in: joins as a brewer; his invite is used up
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'Bob@Example.test');
select is(public.accept_invites(), 1, 'Bob joins one brewery (email matched regardless of capitals)');
select is((select role from memberships where user_id = '00000000-0000-0000-0000-0000000000b1'), 'brewer', 'with the role he was invited as');
select is((select count(*) from public.brewery_members((select brewery_id from ids))), 2::bigint, 'Bob sees both members');
select throws_ok(
  $$ insert into invites (brewery_id, email) select brewery_id, 'dave@example.test' from ids $$,
  '42501', null, 'a brewer cannot invite people');

-- Carol signs in: viewer
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');
select is(public.accept_invites(), 1, 'Carol joins');
select throws_ok(
  $$ insert into locations (brewery_id, name) select brewery_id, 'Annex' from ids $$,
  '42501', null, 'as a viewer she cannot change anything');

-- Alice: the last admin can't be removed or demoted, but can hand over admin first
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select is((select count(*) from invites)::int, 0, 'accepted invites are used up');
select throws_like(
  $$ update memberships set role = 'brewer' where user_id = '00000000-0000-0000-0000-0000000000a1' $$,
  '%needs at least one admin%', 'the last admin cannot be demoted');
update memberships set role = 'admin' where user_id = '00000000-0000-0000-0000-0000000000b1';
update memberships set role = 'brewer' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select role from memberships where user_id = '00000000-0000-0000-0000-0000000000a1'), 'brewer',
  'after making Bob an admin, Alice can step down');

-- Deleting a whole brewery still works (its last admin goes with it)
set local role postgres;
delete from breweries where id = (select brewery_id from ids);
select is((select count(*) from memberships where brewery_id = (select brewery_id from ids))::int, 0,
  'deleting a brewery removes its members too');

select * from finish();
rollback;
