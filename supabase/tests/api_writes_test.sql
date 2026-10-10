-- Tests for API writes' attribution (docs/api-writes-design.md): a record is stamped with the key
-- only when it's written through that key (the database does it: a person in the app can't fake it),
-- and only the API lists a key's writes.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(6);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create function pg_temp.act_as(user_id uuid, perms text[] default null) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', user_id, 'role', 'authenticated', 'api_permissions', perms))::text, true);
$$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
insert into beers (id, brewery_id, code, name) select '66666666-0000-0000-0000-000000000001', brewery_id, 'ipa', 'IPA' from ids;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date) select '66666666-0000-0000-0000-000000000002', brewery_id, '1', '66666666-0000-0000-0000-000000000001', current_date from ids;
set local role postgres;
insert into api_keys (id, brewery_id, user_id, name, prefix, key_hash, permissions)
  select '66666666-0000-0000-0000-0000000000aa', brewery_id, '00000000-0000-0000-0000-0000000000a1', 'Agent', 'bos_x', 'hash', public.permission_list() from ids;

-- In the app (no key): nothing is stamped, even if someone tries
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into cellar_entries (brewery_id, batch_id, occurred_on, action, via_key)
  select brewery_id, '66666666-0000-0000-0000-000000000002', current_date, 'Check', '66666666-0000-0000-0000-0000000000aa' from ids;
select is((select via_key from cellar_entries where action = 'Check'), null, 'in the app, a record can''t claim a key wrote it');
select throws_ok($$ select public.log_api_action('POST', 'x', 'faked', '{}', '{}') $$, '42501', null, 'and can''t add to a key''s activity');

-- Through the key (as the API runs a request): stamped and listed
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', public.permission_list());
select set_config('brewery_os.api_key', '66666666-0000-0000-0000-0000000000aa', true);
insert into cellar_entries (brewery_id, batch_id, occurred_on, action)
  select brewery_id, '66666666-0000-0000-0000-000000000002', current_date, 'Dry hop' from ids;
select is((select via_key from cellar_entries where action = 'Dry hop'), '66666666-0000-0000-0000-0000000000aa'::uuid, 'through a key: stamped with it');
select lives_ok($$ select public.log_api_action('POST', 'batches/1/log', 'Logged a dry hop', '{}', '{}') $$, 'and listed');
select is((select summary from api_actions), 'Logged a dry hop', 'in the key''s activity');
-- A change to a beer through the key: stamped; a later change in the app: not
update beers set style = 'IPA';
select is((select via_key from beers), '66666666-0000-0000-0000-0000000000aa'::uuid, 'a beer changed through the key shows it');

select * from finish();
rollback;
