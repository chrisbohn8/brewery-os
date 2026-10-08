-- Tests for problem reports (report_error).
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(8);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated, anon;

-- Alice reports a problem, twice: one report, counted twice
select public.report_error(jsonb_build_object('message', 'save: TypeError: x is undefined', 'screen', 'app-screen',
  'brewery_id', (select brewery_id from ids), 'stack', repeat('s', 9000)));
select public.report_error(jsonb_build_object('message', 'save: TypeError: x is undefined'));
select is((select count(*) from error_reports)::int, 0, 'nobody can read the reports from the app');

-- Bob (not in Brewery A) reports one naming Brewery A; a signed-out visitor reports one too
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');
select public.report_error(jsonb_build_object('message', 'crash: boom', 'brewery_id', (select brewery_id from ids)));
select public.report_error(jsonb_build_object('message', 'crash: bad id', 'brewery_id', 'not-a-uuid'));
select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role":"anon"}', true);
select lives_ok($$ select public.report_error('{"message": "crash: on the sign-in screen"}') $$, 'a signed-out visitor can report a problem');

set local role postgres;
select is((select times from error_reports where message = 'save: TypeError: x is undefined'), 2,
  'the same problem from the same person within an hour is one report, counted twice');
select is((select brewery_id from error_reports where message = 'save: TypeError: x is undefined'), (select brewery_id from ids),
  'it names the reporter''s brewery');
select is((select length(stack) from error_reports where message = 'save: TypeError: x is undefined'), 4000, 'long details are cut short');
select is((select brewery_id from error_reports where message = 'crash: boom'), null,
  'a brewery the reporter isn''t in isn''t recorded');
select is((select count(*) from error_reports where user_id is null and message = 'crash: on the sign-in screen')::int, 1,
  'the signed-out report is kept, with no one named');

-- Past 500 reports in an hour, the rest are dropped
insert into error_reports (message) select 'flood ' || n from generate_series(1, 500) n;
select public.report_error('{"message": "one too many"}');
select is((select count(*) from error_reports where message = 'one too many')::int, 0, 'past 500 an hour, reports are dropped');

select * from finish();
rollback;
