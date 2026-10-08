-- Tests for API keys: made with up to your own permissions, shown once, stored scrambled,
-- narrowing what a request can do, and revocable.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000ab', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000cb', 'cellar@example.test');
create function pg_temp.act_as(user_id uuid, api_permissions text[] default null) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', (jsonb_build_object('sub', user_id, 'role', 'authenticated')
           || case when api_permissions is null then '{}'::jsonb else jsonb_build_object('api_permissions', to_jsonb(api_permissions)) end)::text, true);
$$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ab');
create temp table ids as select public.create_brewery('Key Brewery') as b;
grant all on ids to authenticated;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select b, '00000000-0000-0000-0000-0000000000cb', 'cellar' from ids;

-- 1. A cellar person makes a key with some of their permissions
select pg_temp.act_as('00000000-0000-0000-0000-0000000000cb');
create temp table made as select public.create_api_key((select b from ids), 'Agent', array['cellar_log', 'tank_status']) as key;
grant all on made to authenticated;
select ok((select key from made) like 'bos_%' and length((select key from made)) = 52, 'a key is made and shown once');
select is((select prefix from api_keys), left((select key from made), 12), 'its start is kept, to recognize it');
select throws_ok($$ select key_hash from api_keys $$, '42501', null, 'the scrambled copy can''t be read back');
select throws_ok($$ select public.create_api_key((select b from ids), 'Too much', array['delete_records']) $$,
  '42501', 'A key can only have permissions you have.', 'a key can''t have more than its maker');

-- 2. Using it: only what both the key and the person can do
select pg_temp.act_as('00000000-0000-0000-0000-0000000000cb', array['cellar_log', 'tank_status']);
select ok(public.has_permission((select b from ids), 'tank_status'), 'the key can set tank status');
select ok(not public.has_permission((select b from ids), 'move_beer'), 'but not move beer (the person can, the key can''t)');
select throws_ok($$ select public.create_api_key((select b from ids), 'Chain', array['cellar_log']) $$,
  '42501', 'A key can''t make other keys.', 'a key can''t make more keys');

-- 3. Revoking: by its maker, or the brewery's admin; not by someone else
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ab');
select is((select count(*) from api_keys)::int, 1, 'an admin sees the brewery''s keys');
select lives_ok($$ select public.revoke_api_key((select id from api_keys)) $$, 'an admin can revoke a key');
select ok((select revoked_at is not null from api_keys), 'and it''s marked revoked');
select throws_ok($$ select public.revoke_api_key((select id from api_keys)) $$, '42501', null, 'revoking twice says so');

select * from finish();
rollback;
