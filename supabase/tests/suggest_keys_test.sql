-- Tests for suggest-only API keys (docs/api-writes-design.md, step 2): new keys suggest changes
-- unless their maker says otherwise; only a suggest-only key's request keeps a suggestion; a person
-- in the brewery approves or rejects it (a viewer can't, and neither can a key).
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin
  ('00000000-0000-0000-0000-0000000000e1', 'vic@example.test');    -- viewer
create function pg_temp.act_as(user_id uuid, perms text[] default null) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', user_id, 'role', 'authenticated', 'api_permissions', perms))::text, true);
$$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
create temp table made (name text, id uuid);
grant all on ids, made to authenticated;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000e1', 'viewer' from ids;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.create_api_key((select brewery_id from ids), 'Assistant', array['cellar_log']);
select public.create_api_key((select brewery_id from ids), 'Script', array['cellar_log'], 'direct');
select is((select mode from api_keys where name = 'Assistant'), 'suggest', 'a new key suggests changes unless told otherwise');
select is((select mode from api_keys where name = 'Script'), 'direct', 'or makes them directly, when its maker says so');

-- Only a suggest-only key's request keeps a suggestion
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', array['cellar_log']);
select set_config('brewery_os.api_key', (select id::text from api_keys where name = 'Script'), true);
select throws_ok($$ select public.log_api_suggestion('POST', 'x', 'y', '{}') $$, '42501', null, 'a direct key doesn''t keep suggestions');
select set_config('brewery_os.api_key', (select id::text from api_keys where name = 'Assistant'), true);
insert into made select 'first', public.log_api_suggestion('POST', 'batches/1/log', 'Logged a check', '{}');
insert into made select 'second', public.log_api_suggestion('POST', 'batches/1/log', 'Logged another', '{}');
select is((select count(*)::int from api_actions where status = 'suggested'), 2, 'a suggest-only key''s suggestions wait');
select throws_ok($$ select public.reject_api_suggestion((select id from made where name = 'first')) $$, '42501', null, 'a key can''t decide on suggestions');

-- People decide
select set_config('brewery_os.api_key', '', true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select throws_ok($$ select public.reject_api_suggestion((select id from made where name = 'first')) $$, '42501', null, 'a viewer can''t');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.reject_api_suggestion((select id from made where name = 'first')) $$, 'the admin rejects one');
select lives_ok($$ select public.approve_api_suggestion((select id from made where name = 'second'), '{"id": "x"}') $$, 'and approves the other');
select is((select string_agg(status || ':' || (decided_by is not null)::text, ',' order by status) from api_actions), 'approved:true,rejected:true',
  'each marked, with who decided');

select * from finish();
rollback;
