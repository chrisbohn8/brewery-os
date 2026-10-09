-- Tests for menu boards (step 2): a taproom's board from its draft lines, its TV and public links
-- (which work without signing in, show only the menu, and stop working when turned off or
-- replaced), and who can run the boards.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin
  ('00000000-0000-0000-0000-0000000000f1', 'tess@example.test'),   -- taproom manager
  ('00000000-0000-0000-0000-0000000000e1', 'vic@example.test');    -- viewer

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;
create function pg_temp.as_anyone() returns void language sql as $$
  select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role": "anon"}', true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
create temp table links (kind text, token text);
grant all on ids, links to authenticated, anon;
update breweries set menu_sizes = '[{"id": "pint", "name": "16 oz", "oz": 16}]', menu_tags = '[{"id": "new", "name": "New", "kind": "badge"}]';
insert into beers (id, brewery_id, code, name, menu_prices, menu_tags)
  select '88888888-0000-0000-0000-000000000001', brewery_id, 'ipa', 'IPA',
         '[{"size": "pint", "price": 7, "at": {"88888888-0000-0000-0000-00000000000a": 8}}]', '{new}' from ids;
insert into beers (id, brewery_id, code, name, menu_public) select '88888888-0000-0000-0000-000000000002', brewery_id, 'staff', 'Staff Only', false from ids;
insert into beers (id, brewery_id, code, name) select '88888888-0000-0000-0000-000000000003', brewery_id, 'stout', 'Stout' from ids;
insert into stock_places (id, brewery_id, name, kind) select '88888888-0000-0000-0000-00000000000a', brewery_id, 'Taproom', 'taproom' from ids;
insert into stock_places (id, brewery_id, name, kind) select '88888888-0000-0000-0000-00000000000b', brewery_id, 'Cold room', 'storage' from ids;
insert into package_types (id, brewery_id, name, volume_bbl, kind) select '88888888-0000-0000-0000-00000000000c', brewery_id, '1/2 bbl', 0.5, 'keg' from ids;
insert into draft_lines (brewery_id, place_id, line_no, status, beer_id)
  select brewery_id, '88888888-0000-0000-0000-00000000000a', 1, 'beer', '88888888-0000-0000-0000-000000000001' from ids;
insert into draft_lines (brewery_id, place_id, line_no, status, beer_id)
  select brewery_id, '88888888-0000-0000-0000-00000000000a', 2, 'beer', '88888888-0000-0000-0000-000000000002' from ids;
insert into draft_lines (brewery_id, place_id, line_no, status, label)
  select brewery_id, '88888888-0000-0000-0000-00000000000a', 3, 'other', 'House wine' from ids;
insert into draft_lines (brewery_id, place_id, line_no, status) select brewery_id, '88888888-0000-0000-0000-00000000000a', 4, 'empty' from ids;
-- A keg of stout in storage: coming soon
insert into stock_moves (brewery_id, occurred_on, kind, beer_id, package_type_id, count, to_place_id)
  select brewery_id, current_date, 'counted', '88888888-0000-0000-0000-000000000003', '88888888-0000-0000-0000-00000000000c', 2,
         '88888888-0000-0000-0000-00000000000b' from ids;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000f1', 'taproom' from ids;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000e1', 'viewer' from ids;

-- The taproom manager makes both links
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
insert into links select 'tv', public.set_menu_board_link('88888888-0000-0000-0000-00000000000a', 'tv', true);
insert into links select 'public', public.set_menu_board_link('88888888-0000-0000-0000-00000000000a', 'public', true);
select ok((select token from links where kind = 'tv') like 'tv\_%' and (select token from links where kind = 'public') like 'public\_%',
  'Taproom: makes a TV link and a public link');
select lives_ok($$ update menu_boards set title = 'On tap', order_by = 'sections' $$, 'and changes the board''s settings');
select throws_ok($$ update menu_boards set tv_token = 'tv_chosen_by_hand_000000000' $$, '42501', null, 'but not a link''s secret by hand');

-- Anyone with the TV link (no sign-in)
select pg_temp.as_anyone();
create temp table tv as select public.menu_board_data((select token from links where kind = 'tv')) as j;
select is((select j ->> 'title' from tv), 'On tap', 'the TV link shows the board, without signing in');
select is((select jsonb_agg(l -> 'no') from tv, jsonb_array_elements(j -> 'lines') l), '[1, 2, 3]'::jsonb,
  'lines pouring something, in order (not the empty one)');
select is((select j -> 'lines' -> 0 -> 'beer' -> 'prices' -> 0 ->> 'price' from tv), '8', 'with this taproom''s own price');
select is((select j -> 'lines' -> 0 -> 'beer' -> 'tags' -> 0 ->> 'name' from tv), 'New', 'and the beer''s tags, by name');
select is((select j -> 'lines' -> 2 ->> 'label' from tv), 'House wine', 'something else: its label');
select is((select j -> 'coming_soon' -> 0 ->> 'name' from tv), 'Stout', 'coming soon: a keg in storage that isn''t here yet');

-- The public link: the beer left off the public menu isn't there
create temp table pub as select public.menu_board_data((select token from links where kind = 'public')) as j;
select is((select jsonb_agg(l -> 'no') from pub, jsonb_array_elements(j -> 'lines') l), '[1, 3]'::jsonb,
  'the public link leaves off the staff-only beer');
select is(public.menu_board_data('tv_not_a_real_link_000000000000'), null, 'a made-up link shows nothing');
select throws_ok($$ select * from menu_boards $$, '42501', null, 'without signing in, the boards themselves can''t be read');
select throws_ok($$ select public.menu_board_json('88888888-0000-0000-0000-00000000000a', false) $$, '42501', null,
  'and a board can''t be read without its link');

-- Replacing and turning off
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
select isnt(public.set_menu_board_link('88888888-0000-0000-0000-00000000000a', 'tv', true), (select token from links where kind = 'tv'), 'a new TV link');
select public.set_menu_board_link('88888888-0000-0000-0000-00000000000a', 'public', false);
insert into links select 'tv2', public.set_menu_board_link('88888888-0000-0000-0000-00000000000a', 'tv', true);
select pg_temp.as_anyone();
select is((select jsonb_agg(l -> 'no') from jsonb_array_elements(public.menu_board_data((select token from links where kind = 'tv2')) -> 'lines') l),
  '[1, 2, 3]'::jsonb, 'with no public link, the TV still shows the staff-only beer');
select ok(public.menu_board_data((select token from links where kind = 'tv')) is null
          and public.menu_board_data((select token from links where kind = 'public')) is null,
  'the replaced link and the turned-off link stop working');

-- A viewer sees the board in the app but can't run it
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'vic@example.test');
select is(public.menu_board_preview('88888888-0000-0000-0000-00000000000a', false) ->> 'title', 'On tap', 'Viewer: sees the board in the app');
select throws_ok($$ select public.set_menu_board_link('88888888-0000-0000-0000-00000000000a', 'tv', true) $$, '42501', null,
  'but can''t make links');

select * from finish();
rollback;
