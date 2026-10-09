-- Tests for the menu's data (menu boards, step 1): the brewery's menu lists need "Beer menu
-- details", each beer's new menu details follow the same two rules as the old ones, and a price
-- must name a pour size and an amount.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin
  ('00000000-0000-0000-0000-0000000000f1', 'tess@example.test'),   -- taproom manager
  ('00000000-0000-0000-0000-0000000000c1', 'carl@example.test');   -- cellar

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
insert into beers (id, brewery_id, code, name) select '77777777-0000-0000-0000-000000000001', brewery_id, 'ipa', 'IPA' from ids;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000f1', 'taproom' from ids;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000c1', 'cellar' from ids;

-- The taproom manager sets up the lists and fills in a beer's menu
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
select lives_ok($$ update breweries set menu_sizes = '[{"id": "s16", "name": "16 oz", "oz": 16}]',
  menu_sections = '[{"id": "ipa", "name": "IPAs"}]', menu_tags = '[{"id": "new", "name": "New", "kind": "badge"}]',
  menu_fields = '[{"id": "hops", "name": "Hops", "type": "text", "options": []}]' $$,
  'Taproom: can set up pour sizes, sections, tags, and fields');
select is((select menu_sizes -> 0 ->> 'name' from breweries), '16 oz', 'saved');
select throws_ok($$ update breweries set gravity_unit = 'sg' $$, '42501', null, 'but not the other settings');
select lives_ok($$ update beers set menu_short = 'Juicy and bright', menu_srm = 5, menu_section = 'ipa', menu_tags = '{new}',
  menu_extra = '{"hops": "Citra"}', menu_public = false, menu_prices = '[{"size": "s16", "price": 7, "at": {"x": 8}}]' $$,
  'can fill in a beer''s new menu details');
select is((select (menu_short, menu_srm, menu_public) from beers), ('Juicy and bright'::text, 5::numeric, false), 'saved');
select throws_like($$ update beers set name = 'Not IPA' $$, 'You can change a beer''s menu details, but not the beer itself%',
  'still not the beer itself');
select throws_ok($$ update beers set menu_prices = '[{"size": "s16"}]' $$, '23514', null, 'a price needs an amount');
select throws_ok($$ update beers set menu_short = repeat('x', 81) $$, '23514', null, 'the short line is up to 80 characters');

-- Cellar has no menu permission: neither the lists nor a beer's menu
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carl@example.test');
select throws_ok($$ update breweries set menu_tags = '[]' $$, '42501', null, 'Cellar: can''t change the menu''s lists');

-- A head brewer without the menu permission changes the beer but none of its menu details
set local role postgres;
update memberships set role = 'head_brewer', revokes = array['menu'] where user_id = '00000000-0000-0000-0000-0000000000c1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carl@example.test');
select lives_ok($$ update beers set style = 'Hazy IPA' $$, 'Head brewer without the menu: can change the beer');
select throws_like($$ update beers set menu_tags = '{}' $$, 'You can change the beer, but not its menu details%',
  'but not its tags (or any other menu detail)');

select * from finish();
rollback;
