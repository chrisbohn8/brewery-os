-- Tests for the planning calendar: who can plan, who can only move, and beer schedules.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),  -- admin
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test'),    -- brewer: moves items
  ('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');  -- cellar: looks only

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
insert into tanks (brewery_id, name) select brewery_id, 'FV1' from ids;
insert into tanks (brewery_id, name) select brewery_id, 'FV2' from ids;
insert into beers (brewery_id, code, name) select brewery_id, 'pale', 'Pale' from ids;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000b1', 'brewer' from ids;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000c1', 'cellar' from ids;

-- The admin plans a brew in FV1, and a someday plan
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select lives_ok($$ insert into plan_items (id, brewery_id, kind, planned_on, tank_id, beer_id)
  select '22222222-0000-0000-0000-000000000001', i.brewery_id, 'brew', '2026-11-02', t.id, b.id
    from ids i join tanks t on t.name = 'FV1' join beers b on b.code = 'pale' $$, 'an admin plans a brew');
select lives_ok($$ insert into plan_items (brewery_id, kind, someday, beer_id)
  select i.brewery_id, 'brew', 'Fall', b.id from ids i join beers b on b.code = 'pale' $$, 'and a someday plan (no day yet)');
select throws_ok($$ insert into plan_items (brewery_id, kind) select brewery_id, 'brew' from ids $$,
  '23514', null, 'a plan needs a day, or a rough time');
select lives_ok($$ insert into beer_schedules (brewery_id, beer_id, steps)
  select i.brewery_id, b.id, '[{"kind": "dry_hop", "day": 5}, {"kind": "package", "day": 14}]' from ids i join beers b on b.code = 'pale' $$,
  'and gives the beer a schedule');

-- A brewer moves it to FV2 and another day, and ticks it done, but can't change what it is
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');
select lives_ok($$ update plan_items set planned_on = '2026-11-03', tank_id = (select id from tanks where name = 'FV2')
  where id = '22222222-0000-0000-0000-000000000001' $$, 'a brewer can move an item');
select is((select updated_by from plan_items where id = '22222222-0000-0000-0000-000000000001'), '00000000-0000-0000-0000-0000000000b1'::uuid,
  'and it says who moved it');
select throws_like($$ update plan_items set kind = 'package' where id = '22222222-0000-0000-0000-000000000001' $$,
  'You can move items on the calendar%', 'but not change what it is');
delete from plan_items;  -- the rules hide the rows from this delete, so nothing goes
select is((select count(*) from plan_items)::int, 2, 'or delete it');
select throws_ok($$ insert into plan_items (brewery_id, kind, planned_on) select brewery_id, 'clean', '2026-11-04' from ids $$,
  '42501', null, 'or add one');
update beer_schedules set steps = '[]';  -- the rules hide the row from this change, so nothing changes
select is((select jsonb_array_length(steps) from beer_schedules), 2, 'or change a beer''s schedule');

-- Someone at Cellar can look, not move
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');
select is((select count(*) from plan_items)::int, 2, 'everyone in the brewery sees the plan');
update plan_items set planned_on = '2026-12-01' where id = '22222222-0000-0000-0000-000000000001';
select is((select planned_on from plan_items where id = '22222222-0000-0000-0000-000000000001'), '2026-11-03'::date,
  'someone without the permission can''t move it');

select * from finish();
rollback;
