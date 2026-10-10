-- Tests for a brewery's own font files and logos (menu boards, step 3b): only an Admin uploads a
-- font; a board runner uploads a logo; sizes and types are checked; a board's link gives out only
-- the files that board uses; ten of each at most; another brewery can't see them.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin of Brewery A
  ('00000000-0000-0000-0000-0000000000f1', 'tess@example.test'),   -- taproom manager at Brewery A
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');    -- admin of Brewery B

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;
create function pg_temp.as_anyone() returns void language sql as $$
  select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role": "anon"}', true);
$$;
-- A tiny "file": 6 bytes, "abcdef" in base64
create function pg_temp.file(kind text, name text, mime text) returns text language sql as $$
  select format($f$insert into brewery_files (id, brewery_id, kind, name, mime, data, bytes)
    select gen_random_uuid(), brewery_id, %L, %L, %L, 'YWJjZGVm', 6 from ids$f$, kind, name, mime);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
create temp table links (kind text, token text);
grant all on ids, links to authenticated, anon;
insert into stock_places (id, brewery_id, name, kind) select '77777777-0000-0000-0000-00000000000a', brewery_id, 'Taproom', 'taproom' from ids;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000f1', 'taproom' from ids;

-- Fonts: Admins only
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
select throws_ok(pg_temp.file('font', 'House Script', 'font/woff2'), '42501', null, 'Taproom: can''t upload a font');
select lives_ok(pg_temp.file('logo', 'Main logo', 'image/png'), 'but can upload a logo');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select lives_ok(pg_temp.file('font', 'House Script', 'font/woff2'), 'Admin: can upload a font');
select throws_ok(pg_temp.file('font', 'house script', 'font/woff2'), '23505', null, 'two fonts can''t share a name');
select throws_ok(pg_temp.file('font', 'Not A Font', 'image/png'), '23514', null, 'a font must be a font file');
select throws_ok(pg_temp.file('logo', 'Bad <name>', 'image/png'), '23514', null, 'names are letters, numbers, and spaces');
select throws_ok($$ insert into brewery_files (brewery_id, kind, name, mime, data, bytes) select brewery_id, 'logo', 'Wrong size', 'image/png', 'YWJjZGVm', 600 from ids $$,
  '23514', null, 'the size has to match the file');
select throws_ok($$ insert into brewery_files (brewery_id, kind, name, mime, data, bytes)
  select brewery_id, 'logo', 'Too big', 'image/png', repeat('A', 409600), 307201 from ids $$, '23514', null, 'a logo over 300 KB is refused');

-- A board's link gives out only what that board uses
insert into menu_boards (id, brewery_id, place_id, theme)
  select '77777777-0000-0000-0000-0000000000b1', brewery_id, '77777777-0000-0000-0000-00000000000a',
         jsonb_build_object('scheme', 'auto', 'head', 'House Script', 'logo', (select id from brewery_files where kind = 'logo')) from ids;
insert into links select 'tv', public.set_menu_board_link_for('77777777-0000-0000-0000-0000000000b1', 'tv', true);
set local role postgres;
insert into brewery_files (brewery_id, kind, name, mime, data, bytes) select brewery_id, 'logo', 'Unused', 'image/png', 'YWJjZGVm', 6 from ids;
-- (the ids, looked up first: a signed-out visitor can't read the files table, only ask a board's link)
create temp table file_ids as select name, id from brewery_files;
grant all on file_ids to anon;
select pg_temp.as_anyone();
select is(jsonb_array_length(public.menu_board_data((select token from links)) -> 'files'), 2, 'the board''s link lists its font and its logo');
select is(public.menu_board_file((select token from links), (select id from file_ids where name = 'House Script')) ->> 'data', 'YWJjZGVm',
  'and gives out the font');
select is(public.menu_board_file((select token from links), (select id from file_ids where name = 'Unused')), null,
  'but not a file the board doesn''t use');
select is(public.menu_board_file('tv_nottherealtokenatall0000', (select id from file_ids where name = 'House Script')), null, 'or to a wrong link');

-- Another brewery sees none of them
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');
select public.create_brewery('Brewery B');
select is((select count(*)::int from brewery_files), 0, 'Brewery B: can''t see Brewery A''s files');

-- Ten at most
set local role postgres;
insert into brewery_files (brewery_id, kind, name, mime, data, bytes)
  select brewery_id, 'logo', 'Logo ' || n, 'image/png', 'YWJjZGVm', 6 from ids, generate_series(1, 8) n;
select throws_like(pg_temp.file('logo', 'Eleventh', 'image/png'), 'A brewery can keep up to 10 logos%', 'an eleventh logo is refused');
select * from finish();
rollback;
