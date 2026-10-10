-- Tests for the board builder (menu boards, step 3a): several boards per taproom, each with its own
-- links and settings; a board's link shows its own settings; who can add, change, and remove boards;
-- settings that aren't allowed are refused; and step 2's one-board-per-taproom way still works.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

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
insert into beers (id, brewery_id, code, name) select '99999999-0000-0000-0000-000000000001', brewery_id, 'ipa', 'IPA' from ids;
insert into stock_places (id, brewery_id, name, kind) select '99999999-0000-0000-0000-00000000000a', brewery_id, 'Taproom', 'taproom' from ids;
insert into draft_lines (brewery_id, place_id, line_no, status, beer_id)
  select brewery_id, '99999999-0000-0000-0000-00000000000a', 1, 'beer', '99999999-0000-0000-0000-000000000001' from ids;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000f1', 'taproom' from ids;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000e1', 'viewer' from ids;

-- The taproom manager makes two boards for one taproom
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
select lives_ok($$ insert into menu_boards (id, brewery_id, place_id, name, layout, theme)
  select '99999999-0000-0000-0000-0000000000b1', brewery_id, '99999999-0000-0000-0000-00000000000a', 'TV 1: drafts', 'columns',
         '{"scheme": "chalkboard", "head": "Oswald"}' from ids $$, 'Taproom: can make a board');
select lives_ok($$ insert into menu_boards (id, brewery_id, place_id, name, layout, show_on_tap, show_to_go)
  select '99999999-0000-0000-0000-0000000000b2', brewery_id, '99999999-0000-0000-0000-00000000000a', 'TV 2: cans to go', 'cards', false, true from ids $$,
  'and a second board for the same taproom');
select is((select count(*)::int from menu_boards), 2, 'two boards');
select throws_ok($$ update menu_boards set layout = 'freeform' where id = '99999999-0000-0000-0000-0000000000b1' $$,
  '23514', null, 'a layout that isn''t one of the four is refused');
select throws_ok($$ update menu_boards set parts = '"name"' where id = '99999999-0000-0000-0000-0000000000b1' $$,
  '23514', null, 'parts must be a list');

-- Each board has its own links, which show that board's settings
insert into links select 'tv1', public.set_menu_board_link_for('99999999-0000-0000-0000-0000000000b1', 'tv', true);
insert into links select 'tv2', public.set_menu_board_link_for('99999999-0000-0000-0000-0000000000b2', 'tv', true);
select isnt((select token from links where kind = 'tv1'), (select token from links where kind = 'tv2'), 'each board gets its own TV link');

select pg_temp.as_anyone();
select is(public.menu_board_data((select token from links where kind = 'tv1')) -> 'board' ->> 'name', 'TV 1: drafts', 'board 1''s link: its name');
select is(public.menu_board_data((select token from links where kind = 'tv1')) -> 'board' -> 'theme' ->> 'head', 'Oswald', 'its fonts and colors');
select is(public.menu_board_data((select token from links where kind = 'tv1')) -> 'board' ->> 'layout', 'columns', 'its layout');
select is(public.menu_board_data((select token from links where kind = 'tv2')) -> 'board' ->> 'show_on_tap', 'false', 'board 2''s link: its own settings');
select is(jsonb_array_length(public.menu_board_data((select token from links where kind = 'tv1')) -> 'lines'), 1, 'and the taproom''s lines');

-- A viewer can see boards but not change or remove them
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'vic@example.test');
update menu_boards set name = 'Changed';  -- the rules hide the boards from this change
select is((select count(*)::int from menu_boards where name = 'Changed'), 0, 'Viewer: can''t rename a board');
delete from menu_boards;
select is((select count(*)::int from menu_boards), 2, 'or remove one');
select throws_ok($$ select public.set_menu_board_link_for('99999999-0000-0000-0000-0000000000b1', 'tv', false) $$, '42501', null,
  'or turn off its link');

-- The taproom manager removes board 2; its link stops working
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
delete from menu_boards where id = '99999999-0000-0000-0000-0000000000b2';
select pg_temp.as_anyone();
select is(public.menu_board_data((select token from links where kind = 'tv2')), null, 'a removed board''s link shows nothing');

-- Step 2's way (one board per taproom) acts on the first board
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
select is(public.set_menu_board_link('99999999-0000-0000-0000-00000000000a', 'tv', false), null, 'the old way turns off the first board''s link');
select * from finish();
rollback;
