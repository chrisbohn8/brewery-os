-- Tests for kicked kegs and "Almost gone" (docs/keg-design.md, step 1): a kick is logged from its
-- line (beer, size, day), the line then pours the next keg or is empty; kicks don't change stock;
-- who can log and remove them; a beer is almost gone when no storage place has a keg of it left.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin
  ('00000000-0000-0000-0000-0000000000f1', 'tess@example.test'),   -- taproom manager
  ('00000000-0000-0000-0000-0000000000e1', 'vic@example.test');    -- viewer
create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table ids as select public.create_brewery('Brewery A') as b;
grant all on ids to authenticated;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select b, '00000000-0000-0000-0000-0000000000f1', 'taproom' from ids;
insert into memberships (brewery_id, user_id, role) select b, '00000000-0000-0000-0000-0000000000e1', 'viewer' from ids;
-- Two beers, a storage place and a taproom, two lines; IPA has 2 halves in storage, Stout 1 half in the taproom only
insert into beers (id, brewery_id, code, name) select '55555555-0000-0000-0000-000000000001', b, 'ipa', 'IPA' from ids;
insert into beers (id, brewery_id, code, name) select '55555555-0000-0000-0000-000000000002', b, 'stout', 'Stout' from ids;
insert into beers (id, brewery_id, code, name) select '55555555-0000-0000-0000-000000000003', b, 'new', 'New One' from ids;
insert into stock_places (id, brewery_id, name, kind) select '55555555-0000-0000-0000-00000000000a', b, 'Storage', 'storage' from ids;
insert into stock_places (id, brewery_id, name, kind) select '55555555-0000-0000-0000-00000000000b', b, 'Taproom', 'taproom' from ids;
insert into draft_lines (id, brewery_id, place_id, line_no, status, beer_id) select '55555555-0000-0000-0000-0000000000c1', b, '55555555-0000-0000-0000-00000000000b', 1, 'beer', '55555555-0000-0000-0000-000000000001' from ids;
insert into draft_lines (id, brewery_id, place_id, line_no, status, beer_id) select '55555555-0000-0000-0000-0000000000c2', b, '55555555-0000-0000-0000-00000000000b', 2, 'beer', '55555555-0000-0000-0000-000000000002' from ids;
insert into draft_lines (id, brewery_id, place_id, line_no, status, beer_id) select '55555555-0000-0000-0000-0000000000c3', b, '55555555-0000-0000-0000-00000000000b', 3, 'beer', '55555555-0000-0000-0000-000000000003' from ids;
insert into draft_lines (id, brewery_id, place_id, line_no, status) select '55555555-0000-0000-0000-0000000000c4', b, '55555555-0000-0000-0000-00000000000b', 4, 'empty' from ids;
create temp table half as select id from package_types where name = '½ bbl keg' and brewery_id = (select b from ids);
grant all on half to authenticated;
insert into stock_moves (brewery_id, occurred_on, kind, beer_id, package_type_id, count, to_place_id)
  select b, current_date - 9, 'counted', '55555555-0000-0000-0000-000000000001', (select id from half), 2, '55555555-0000-0000-0000-00000000000a' from ids;
-- Stout: 2 halves went into storage, both were brought up to the taproom
insert into stock_moves (brewery_id, occurred_on, kind, beer_id, package_type_id, count, to_place_id)
  select b, current_date - 9, 'counted', '55555555-0000-0000-0000-000000000002', (select id from half), 2, '55555555-0000-0000-0000-00000000000a' from ids;
insert into stock_moves (brewery_id, occurred_on, kind, beer_id, package_type_id, count, from_place_id, to_place_id)
  select b, current_date - 5, 'moved', '55555555-0000-0000-0000-000000000002', (select id from half), 2, '55555555-0000-0000-0000-00000000000a', '55555555-0000-0000-0000-00000000000b' from ids;
insert into menu_boards (brewery_id, place_id) select b, '55555555-0000-0000-0000-00000000000b' from ids;

-- 1. Almost gone, worked out for the board
create temp table board as select public.menu_board_content('55555555-0000-0000-0000-00000000000b', false, false, false) as j;
create function pg_temp.almost(n int) returns boolean language sql as $$
  select (l -> 'beer' ->> 'almost_gone')::boolean from board, jsonb_array_elements(j -> 'lines') l where (l ->> 'no')::int = n
$$;
select is(pg_temp.almost(1), false, 'IPA: 2 halves still in storage, not almost gone');
select is(pg_temp.almost(2), true, 'Stout: none left in storage (both are in the taproom): almost gone');
select is(pg_temp.almost(3), false, 'a beer never kept in storage: never marked (the app can''t know)');
select is((select parts from menu_boards where place_id = '55555555-0000-0000-0000-00000000000b') ? 'almost', true, 'new boards show it');

-- 2. The taproom manager logs a kicked keg; the line pours the next one
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select lives_ok($$ select public.kick_keg('55555555-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-0000000000c1', current_date, (select id from half), 'same') $$,
  'Taproom: logs a kick on line 1');
select lives_ok($$ select public.kick_keg('55555555-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-0000000000c1', current_date, (select id from half), 'same') $$,
  'sending it again (an offline retry) is fine');
select is((select count(*)::int from keg_kicks), 1, 'and logs it once');
select ok((select beer_id = '55555555-0000-0000-0000-000000000001' and line_no = 1 and kicked_on = current_date from keg_kicks),
  'with the beer, the line, and the day');
select is((select status from draft_lines where id = '55555555-0000-0000-0000-0000000000c1'), 'beer', 'the line still pours IPA (the next keg)');
select is((select sum(count)::int from stock_on_hand where beer_id = '55555555-0000-0000-0000-000000000001'), 2, 'stock isn''t changed (counts do that)');
select public.kick_keg(gen_random_uuid(), '55555555-0000-0000-0000-0000000000c2', current_date, (select id from half), 'empty');
select is((select status from draft_lines where id = '55555555-0000-0000-0000-0000000000c2'), 'empty', 'the last Stout kicked: the line is empty');
select throws_ok($$ select public.kick_keg(gen_random_uuid(), '55555555-0000-0000-0000-0000000000c4', current_date, null, 'same') $$,
  'P0001', null, 'an empty line can''t kick');

-- 3. A viewer can see kicks but not log or remove them
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select throws_ok($$ select public.kick_keg(gen_random_uuid(), '55555555-0000-0000-0000-0000000000c3', current_date, null, 'same') $$,
  '42501', null, 'Viewer: can''t log a kick');
delete from keg_kicks;
select is((select count(*)::int from keg_kicks), 2, 'or remove one');

select * from finish();
rollback;
