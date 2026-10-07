-- Tests for brewery preferences (units and time zone).
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a2', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'brewer@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'outsider@example.test');

create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
create temp table ids as select public.create_brewery('Prefs Brewery') as brewery_id;
grant all on ids to authenticated;

select is((select temperature_unit || '/' || gravity_unit || '/' || volume_unit from breweries),
  'F/plato/bbl', 'a new brewery starts with °F, Plato, and barrels');

update breweries set temperature_unit = 'C', gravity_unit = 'sg', volume_unit = 'hl', time_zone = 'Europe/Berlin';
select is((select temperature_unit || '/' || gravity_unit || '/' || volume_unit || '/' || time_zone from breweries),
  'C/sg/hl/Europe/Berlin', 'the admin can change the preferences');

select throws_ok($$ update breweries set gravity_unit = 'baume' $$, '23514', null, 'only known units are accepted');

select is((select target_limits->>'gravity' from breweries), '0.004', 'a new brewery starts with the usual target limits');
update breweries set target_limits = '{"gravity": 0.002, "temperature": null, "ph": 0.1, "amount": 0.05}';
select is((select target_limits->>'ph' from breweries), '0.1', 'the admin can change the target limits');
select is((select sheet_fields from breweries), null, 'a new brewery uses the usual brew sheet fields');
update breweries set sheet_fields = array['grist_weight', 'mash_temp', 'mash_ph'];
select is((select cardinality(sheet_fields) from breweries), 3, 'the admin can choose the brew sheet''s fields');
update breweries set sheet_custom_fields = '[{"key": "custom_a1", "label": "Hot side DO", "section": "Knockout", "type": "number", "unit": "ppb"}]';
select is((select sheet_custom_fields->0->>'label' from breweries), 'Hot side DO', 'the admin can add the brewery''s own fields');
select throws_ok($$ update breweries set sheet_custom_fields = '{}' $$, '23514', null, 'own fields must be a list');
update breweries set sheet_field_settings = '{"sparge_temp": {"label": "Sparge liquor", "target": {"min": 75.6, "max": 76.7}}}';
select is((select sheet_field_settings->'sparge_temp'->>'label' from breweries), 'Sparge liquor', 'the admin can rename a field and set its target');

-- A brewer can see the preferences but not change them
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000b2', 'brewer' from ids;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
select is((select gravity_unit from breweries), 'sg', 'a brewer can see the preferences');
select throws_ok($$ update breweries set gravity_unit = 'plato' $$, '42501',
  'You don''t have permission to change units, the time zone, or target limits.', 'but a brewer can''t change them');
select throws_ok($$ update breweries set target_limits = '{}' $$, '42501', null, 'or the target limits');
select throws_ok($$ update breweries set sheet_fields = null $$, '42501',
  'You don''t have permission to choose the brew sheet''s fields.', 'or the brew sheet''s fields');
select throws_ok($$ update breweries set sheet_custom_fields = '[]' $$, '42501', null, 'or add their own fields');
select throws_ok($$ update breweries set sheet_field_settings = '{}' $$, '42501', null, 'or rename fields and set targets');

-- Someone outside the brewery sees nothing
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
select is((select count(*) from breweries where id = (select brewery_id from ids))::int, 0, 'outsiders can''t see the preferences');

select * from finish();
rollback;
