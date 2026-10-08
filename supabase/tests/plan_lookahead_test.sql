-- Tests for "will we have enough?" (plan_needs, plan_shortfalls, the short_for_brew alert).
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin of brewery A
  ('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');   -- not in it

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

-- Brewery A: a 2-turn brewhouse, a beer whose recipe (one turn) takes 275 lb of Pilsner malt and
-- some "Mystery hops" that aren't in the raw materials; 880 lb of Pilsner on hand
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
insert into locations (id, brewery_id, name, usual_turns) select '44444444-0000-0000-0000-000000000001', brewery_id, 'Main', 2 from ids;
insert into tanks (id, brewery_id, name, location_id) select '44444444-0000-0000-0000-000000000002', brewery_id, 'FV1', '44444444-0000-0000-0000-000000000001' from ids;
insert into beers (id, brewery_id, code, name) select '44444444-0000-0000-0000-000000000003', brewery_id, 'helles', 'Helles' from ids;
insert into recipes (id, brewery_id, beer_id, name) select '44444444-0000-0000-0000-000000000004', brewery_id, '44444444-0000-0000-0000-000000000003', 'Helles' from ids;
insert into recipe_ingredients (brewery_id, recipe_id, kind, name, amount, unit)
  select brewery_id, '44444444-0000-0000-0000-000000000004'::uuid, 'malt', 'Pilsner malt', 275, 'lb' from ids
  union all select brewery_id, '44444444-0000-0000-0000-000000000004'::uuid, 'hop', 'Mystery hops', 2, 'kg' from ids;
insert into raw_items (id, brewery_id, name, kind, unit, pack_size, pack_name, lead_days)
  select '44444444-0000-0000-0000-000000000005', brewery_id, 'Pilsner Malt', 'malt', 'lb', 55, 'sack', 3 from ids;
insert into raw_receipts (brewery_id, item_id, received_on, amount) select brewery_id, '44444444-0000-0000-0000-000000000005', current_date, 880 from ids;
-- Two brews planned in FV1: tomorrow and in 3 days
insert into plan_items (id, brewery_id, kind, planned_on, tank_id, beer_id)
  select '44444444-0000-0000-0000-000000000006'::uuid, brewery_id, 'brew', current_date + 1, '44444444-0000-0000-0000-000000000002'::uuid, '44444444-0000-0000-0000-000000000003'::uuid from ids
  union all
  select '44444444-0000-0000-0000-000000000007'::uuid, brewery_id, 'brew', current_date + 3, '44444444-0000-0000-0000-000000000002'::uuid, '44444444-0000-0000-0000-000000000003'::uuid from ids;

select is((select sum(needed) from plan_needs((select brewery_id from ids)) where item_id is not null and plan_id = '44444444-0000-0000-0000-000000000006'),
  550::numeric, 'a brew needs the recipe times the 2 turns (275 lb x 2)');
select is((select count(*) from plan_needs((select brewery_id from ids)) where item_id is null and ingredient = 'Mystery hops')::int, 2,
  'an ingredient not in the raw materials is listed, not guessed');
select is((select count(*) from plan_shortfalls((select brewery_id from ids)))::int, 1, 'only the second brew comes up short');
select is((select (available, short) from plan_shortfalls((select brewery_id from ids))), (330::numeric, 220::numeric),
  '880 on hand, 550 for the first brew: 330 left, 220 short for the second');

-- An order arriving before the second brew counts
insert into raw_orders (brewery_id, item_id, amount, expected_on) select brewery_id, '44444444-0000-0000-0000-000000000005', 100, current_date + 2 from ids;
select is((select short from plan_shortfalls((select brewery_id from ids))), 120::numeric, 'a delivery on order before then counts (120 short)');

-- The alert (on unless turned off)
select is(public.check_alerts((select brewery_id from ids)) >= 1, true, 'the check opens an alert');
select is((select title from alerts where kind = 'short_for_brew'), format('Short of Pilsner Malt for Helles on %s', to_char(current_date + 3, 'Mon DD')),
  'saying what, for which brew, when');

-- Dismissing it stops the alert, until the shortfall grows
insert into shortfall_dismissals (brewery_id, plan_id, item_id, short_amount, note)
  select brewery_id, '44444444-0000-0000-0000-000000000007', '44444444-0000-0000-0000-000000000005', 120, 'borrowing from next door' from ids;
select is((select dismissed from plan_shortfalls((select brewery_id from ids))), true, 'dismissed, with a note');
select public.check_alerts((select brewery_id from ids));
select is((select count(*) from alerts where kind = 'short_for_brew' and resolved_at is null)::int, 0, 'and the alert clears');
update raw_orders set amount = 50;
select is((select dismissed from plan_shortfalls((select brewery_id from ids))), false, 'a bigger shortfall (170) comes back');

-- Recipes written for the whole batch: no turns multiplying, so no shortfall
update breweries set recipes_per = 'batch' where id = (select brewery_id from ids);
select is((select count(*) from plan_shortfalls((select brewery_id from ids)))::int, 0, 'recipes for the whole batch: enough for both');

-- Someone outside the brewery sees nothing
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');
select is((select count(*) from plan_needs((select brewery_id from ids)))::int, 0, 'someone outside sees no needs');
select is((select count(*) from plan_shortfalls((select brewery_id from ids)))::int, 0, 'or shortfalls');

select * from finish();
rollback;
