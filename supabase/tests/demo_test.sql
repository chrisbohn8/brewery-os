-- Tests for the demo (docs/demo-design.md): a visitor without an email gets their own demo brewery
-- (the same one when they come back), can't set up or join a real brewery, and a demo has API
-- keys, calendar links, invites, and font uploads off; a demo stays a demo; old demos are cleaned up.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(15);

insert into auth.users (id, email, is_anonymous, created_at) values
  ('00000000-0000-0000-0000-0000000000d1', null, true, now()),                       -- a visitor trying the demo
  ('00000000-0000-0000-0000-0000000000d2', null, true, now() - interval '9 days'),   -- one from last week
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test', false, now());       -- a brewer with an email

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;
create temp table ids (name text, id uuid);
grant all on ids to authenticated;

-- The visitor's demo
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
insert into ids select 'demo', public.create_demo_brewery();
select ok((select is_demo from breweries where id = (select id from ids where name = 'demo')), 'Try the demo: a demo brewery');
select is(public.create_demo_brewery(), (select id from ids where name = 'demo'), 'coming back: the same demo');
select is((select role from memberships where user_id = '00000000-0000-0000-0000-0000000000d1'), 'admin', 'the visitor runs it (admin)');
select throws_ok($$ select public.create_brewery('A real one') $$, '42501', null, 'a visitor can''t set up a real brewery');

-- What's off in a demo
select throws_like($$ select public.create_api_key((select id from ids where name = 'demo'), 'Agent', array['cellar_log']) $$,
  '%API keys are off in the demo%', 'no API keys');
select throws_like($$ insert into invites (brewery_id, email, role) select id, 'friend@example.test', 'cellar' from ids where name = 'demo' $$,
  '%Invites are off in the demo%', 'no invites');
select throws_like($$ insert into brewery_files (brewery_id, kind, name, mime, data, bytes) select id, 'font', 'Font', 'font/woff2', 'YWJjZGVm', 6 from ids where name = 'demo' $$,
  '%Uploading fonts is off in the demo%', 'no fonts');
select lives_ok($$ insert into brewery_files (brewery_id, kind, name, mime, data, bytes) select id, 'logo', 'Logo', 'image/png', 'YWJjZGVm', 6 from ids where name = 'demo' $$,
  'logos work');
select throws_like($$ update breweries set is_demo = false where id = (select id from ids where name = 'demo') $$,
  '%can''t become a real one%', 'a demo can''t become a real brewery');

-- A brewer with an email: no demo for them, and their brewery can't become one
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.create_demo_brewery() $$, '42501', null, 'signed in with an email: no demo brewery');
insert into ids select 'real', public.create_brewery('Real Brewing');
select throws_like($$ update breweries set is_demo = true where id = (select id from ids where name = 'real') $$,
  '%can''t become a real one%', 'a real brewery can''t become a demo');
set local role postgres;
select throws_ok($$ insert into memberships (brewery_id, user_id, role) select id, '00000000-0000-0000-0000-0000000000d1', 'cellar' from ids where name = 'real' $$,
  '42501', null, 'a visitor can''t be added to a real brewery');

-- The daily clean-up: last week's demo and its visitor go; this week's stay
insert into breweries (id, name, is_demo, created_at) values ('00000000-0000-0000-0000-0000000000e9', 'Old demo', true, now() - interval '8 days');
insert into memberships (brewery_id, user_id, role) values ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000d2', 'admin');
select is(public.cleanup_demos(), 1, 'the clean-up removes last week''s demo');
select is((select count(*)::int from auth.users where id = '00000000-0000-0000-0000-0000000000d2'), 0, 'and its visitor''s sign-in');
select ok(exists (select 1 from breweries where id = (select id from ids where name = 'demo'))
          and exists (select 1 from breweries where id = (select id from ids where name = 'real')), 'this week''s demo and real breweries stay');

select * from finish();
rollback;
