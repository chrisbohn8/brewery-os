-- Tests for "push the rest back" (plan_shifts): who can push a batch's schedule.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test'),    -- brewer: can push
  ('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');  -- cellar: can't

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
insert into beers (brewery_id, code, name) select brewery_id, 'pale', 'Pale' from ids;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date)
  select '33333333-0000-0000-0000-000000000001', i.brewery_id, '101', b.id, '2026-10-01' from ids i join beers b on b.code = 'pale';
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000b1', 'brewer' from ids;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000c1', 'cellar' from ids;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');
select lives_ok($$ insert into plan_shifts (brewery_id, batch_id, days) select brewery_id, '33333333-0000-0000-0000-000000000001', 3 from ids $$,
  'a brewer can push a batch''s schedule back');
select lives_ok($$ update plan_shifts set days = 5 $$, 'and push it further');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');
select is((select days from plan_shifts), 5, 'everyone sees the push');
update plan_shifts set days = 0;  -- the rules hide the row from this change
select is((select days from plan_shifts), 5, 'someone without the permission can''t change it');

set local role postgres;
select ok('plan_shifts' = any(public.backup_tables()), 'backups bring pushes back too');

select * from finish();
rollback;
