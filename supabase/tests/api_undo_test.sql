-- Tests for undoing a key's change (docs/api-writes-design.md, step 3): a record it added is removed
-- and the activity list says "undone" (once); a change it made is put back, unless someone changed it
-- since; volumes and stock aren't undone here; a key can't undo, and a viewer can't remove what the
-- app wouldn't let them.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

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
insert into beers (id, brewery_id, code, name) select '55555555-0000-0000-0000-000000000001', brewery_id, 'ipa', 'IPA' from ids;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date) select '55555555-0000-0000-0000-000000000002', brewery_id, '1', '55555555-0000-0000-0000-000000000001', current_date from ids;
insert into locations (id, brewery_id, name) select '55555555-0000-0000-0000-000000000003', brewery_id, 'Main' from ids;
insert into tanks (id, brewery_id, name, type, location_id) select '55555555-0000-0000-0000-000000000004', brewery_id, 'FV1', 'fermenter', '55555555-0000-0000-0000-000000000003' from ids;
select public.create_api_key((select brewery_id from ids), 'Agent', public.permission_list(), 'direct');
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000e1', 'viewer' from ids;

-- Three writes through the key, as the API makes them: a cellar entry, a tank's status, a transfer
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', public.permission_list());
select set_config('brewery_os.api_key', (select id::text from api_keys), true);
insert into cellar_entries (id, brewery_id, batch_id, occurred_on, action)
  select '55555555-0000-0000-0000-0000000000c1', brewery_id, '55555555-0000-0000-0000-000000000002', current_date, 'Check' from ids;
insert into made select 'log', public.log_api_action('POST', 'batches/1/log', 'Logged Check on #1', '{}', '{"id": "55555555-0000-0000-0000-0000000000c1"}');
update tanks set status = 'cleaning';
insert into made select 'tank', public.log_api_action('PATCH', 'tanks/FV1', 'FV1 set to cleaning', '{}',
  '{"id": "55555555-0000-0000-0000-000000000004", "was": {"status": "empty"}, "now": {"status": "cleaning"}}');
insert into made select 'move', public.log_api_action('POST', 'batches/1/stage', 'Moved #1', '{}', '{}');
select set_config('brewery_os.api_key', '', true);

-- A key can't undo; a viewer can't remove what the app wouldn't let them
select throws_like($$ select public.undo_api_action((select id from made where name = 'log')) $$, '%A key can''t undo%', 'a key can''t undo');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select throws_ok($$ select public.undo_api_action((select id from made where name = 'log')) $$, '42501', null, 'a viewer can''t remove a cellar entry');

-- The admin undoes the cellar entry: gone, and marked (once)
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.undo_api_action((select id from made where name = 'log')) $$, 'undo a cellar entry the key added');
select is((select count(*)::int from cellar_entries), 0, 'it''s gone');
select is((select status from api_actions where id = (select id from made where name = 'log')), 'undone', 'marked undone');
select throws_like($$ select public.undo_api_action((select id from made where name = 'log')) $$, '%was undone%', 'only once');

-- A change put back, unless changed since
update tanks set status = 'maintenance';
select throws_like($$ select public.undo_api_action((select id from made where name = 'tank')) $$, '%changed since%', 'changed since: undo refuses (it would erase that)');
update tanks set status = 'cleaning';
select lives_ok($$ select public.undo_api_action((select id from made where name = 'tank')) $$, 'otherwise, put back');
select is((select status from tanks), 'empty', 'the tank''s status is what it was');

-- Volumes and stock: not undone here
select throws_like($$ select public.undo_api_action((select id from made where name = 'move')) $$, '%Volumes and stock aren''t undone here%', 'a transfer isn''t undone here');

select * from finish();
rollback;
