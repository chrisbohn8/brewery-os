-- Tests for the Taproom level: the taproom side (finished goods, draft lines, menu details), not
-- the brewhouse side (batches, beers themselves, raw materials). And raw materials' own permission.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

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
insert into stock_places (id, brewery_id, name, kind) select '77777777-0000-0000-0000-000000000002', brewery_id, 'Taproom', 'taproom' from ids;
insert into raw_items (id, brewery_id, name, kind, unit) select '77777777-0000-0000-0000-000000000003', brewery_id, 'Citra', 'hop', 'lb' from ids;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000f1', 'taproom' from ids;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000c1', 'cellar' from ids;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1', 'tess@example.test');
select is((select array_agg(p order by p) from unnest(public.my_permissions((select brewery_id from ids))) p), array['inventory', 'menu'],
  'Taproom: finished goods and the menu');
select lives_ok($$ insert into draft_lines (brewery_id, place_id, line_no, status, beer_id)
  select brewery_id, '77777777-0000-0000-0000-000000000002', 1, 'beer', '77777777-0000-0000-0000-000000000001' from ids $$,
  'can put a beer on a draft line');
select lives_ok($$ update beers set menu_description = 'Juicy and bright', menu_abv = 6.5, menu_prices = '[{"size": "16 oz", "price": 7}]' $$,
  'can set a beer''s menu details');
select is((select menu_abv from beers), 6.5, 'saved');
select throws_like($$ update beers set name = 'Not IPA' $$, 'You can change a beer''s menu details, but not the beer itself%',
  'but not change the beer itself');
select throws_ok($$ insert into raw_receipts (brewery_id, item_id, received_on, amount)
  select brewery_id, '77777777-0000-0000-0000-000000000003', current_date, 10 from ids $$, '42501', null, 'can''t receive raw materials');
select throws_ok($$ insert into batches (brewery_id, batch_number, beer_id) select brewery_id, '1', '77777777-0000-0000-0000-000000000001' from ids $$,
  '42501', null, 'can''t start batches');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carl@example.test');
select ok('raw_materials' = any(public.my_permissions((select brewery_id from ids))), 'Cellar keeps raw materials');
select lives_ok($$ insert into raw_receipts (brewery_id, item_id, received_on, amount)
  select brewery_id, '77777777-0000-0000-0000-000000000003', current_date, 10 from ids $$, 'and can receive them');
update beers set menu_abv = 7;  -- the rules hide the beer from this change, so nothing changes
select is((select menu_abv from beers), 6.5, 'but not the menu');

-- A head brewer without the menu permission (an admin took it away) sets up beers, but not the menu
set local role postgres;
update memberships set role = 'head_brewer', revokes = array['menu'] where user_id = '00000000-0000-0000-0000-0000000000c1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carl@example.test');
select lives_ok($$ update beers set style = 'Hazy IPA' $$, 'Head brewer without the menu: can change the beer');
select throws_like($$ update beers set menu_description = 'Different' $$, 'You can change the beer, but not its menu details%',
  'but not its menu details');

select * from finish();
rollback;
