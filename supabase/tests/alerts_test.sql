-- Tests for alerts from the records: each kind opens when its condition is true, stays one alert
-- while it lasts, clears when the condition goes away, and can be turned off or acknowledged.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000ac', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000dc', 'outsider@example.test');
create function pg_temp.act_as(user_id uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
$$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000ac');
create temp table ids as select public.create_brewery('Alert Brewery') as b;
grant all on ids to authenticated;
update breweries set acid_after_styles = array['Sour'];
insert into tanks (id, brewery_id, name, acid_every_turns) select ('ac000000-0000-0000-0000-00000000000' || n)::uuid, b, 'T' || n, null from ids, generate_series(1, 4) n;
insert into beers (id, brewery_id, code, name, style) select 'ac000000-0000-0000-0000-0000000000b1', b, 'lager', 'Lager', 'Lager' from ids;
insert into beers (id, brewery_id, code, name, style) select 'ac000000-0000-0000-0000-0000000000b2', b, 'sour', 'Tart', 'Sour' from ids;

create function pg_temp.batch(id uuid, number text, beer uuid, stage text, days_ago int, tank uuid) returns void language sql as $$
  select public.save_batch(id, (select b from ids), number, beer, current_date - days_ago, 30, stage, current_date - days_ago, tank, current_date - days_ago);
$$;
create function pg_temp.open(kind text) returns int language sql as $$
  select count(*)::int from alerts where alerts.kind = open.kind and resolved_at is null
$$;
create function pg_temp.check() returns void language sql as $$ select public.check_alerts((select b from ids)) $$;

-- 1. No gravity in 5 days on a fermenting batch (the limit is 3)
select pg_temp.batch('ac000000-0000-0000-0000-0000000000a1', '1', 'ac000000-0000-0000-0000-0000000000b1', 'fermenting', 5, 'ac000000-0000-0000-0000-000000000001');
select pg_temp.check();
select is(pg_temp.open('no_gravity'), 1, 'no gravity for 5 days opens an alert');
select ok((select title from alerts where kind = 'no_gravity') like 'No gravity on Lager #1 in 5 days', 'saying which batch and how long');
select pg_temp.check();
select is((select count(*)::int from alerts where kind = 'no_gravity'), 1, 'checking again doesn''t open a second one');
select public.log_cellar_entry(gen_random_uuid(), (select b from ids), 'ac000000-0000-0000-0000-0000000000a1', current_date, 'Check', 1.020, null, null, '', '', null);
select pg_temp.check();
select is(pg_temp.open('no_gravity'), 0, 'logging a gravity clears it');

-- 2. Too long in a stage: conditioning for 30 days (the limit is 28)
select pg_temp.batch('ac000000-0000-0000-0000-0000000000a2', '2', 'ac000000-0000-0000-0000-0000000000b1', 'conditioning', 30, 'ac000000-0000-0000-0000-000000000002');
select pg_temp.check();
select is(pg_temp.open('stage_too_long'), 1, '30 days conditioning opens an alert');

-- 3. Acid due: a sour batch left T3 (now empty)
select pg_temp.batch('ac000000-0000-0000-0000-0000000000a3', '3', 'ac000000-0000-0000-0000-0000000000b2', 'fermenting', 10, 'ac000000-0000-0000-0000-000000000003');
select public.save_batch('ac000000-0000-0000-0000-0000000000a3', (select b from ids), '3', 'ac000000-0000-0000-0000-0000000000b2', current_date - 10, 30,
                         'conditioning', current_date - 1, 'ac000000-0000-0000-0000-000000000004', current_date - 1);
select pg_temp.check();
select ok((select title || ' ' || detail from alerts where kind = 'acid_due' and resolved_at is null) = 'Acid due on T3 After Sour.', 'a sour batch leaving a tank: acid due on it');
insert into tank_cleanings (brewery_id, tank_id, kind, cleaned_on) select b, 'ac000000-0000-0000-0000-000000000003', 'acid', current_date from ids;
select pg_temp.check();
select is(pg_temp.open('acid_due'), 0, 'an acid cycle clears it');

-- 4. Under par: a brewery-wide par of 10 bbl, nothing on hand
insert into stock_pars (brewery_id, place_id, beer_id, par_bbl) select b, null, 'ac000000-0000-0000-0000-0000000000b1', 10 from ids;
select pg_temp.check();
select ok((select title from alerts where kind = 'under_par' and resolved_at is null) = 'Lager under par', 'under par opens an alert');

-- 5. Low stock: 150 lb received, 80 lb used on a batch (same name), reorder below 100 lb
insert into raw_items (id, brewery_id, name, unit, reorder_level) select 'ac000000-0000-0000-0000-0000000000c1', b, 'Pils malt', 'lb', 100 from ids;
insert into raw_receipts (brewery_id, item_id, received_on, amount) select b, 'ac000000-0000-0000-0000-0000000000c1', current_date, 150 from ids;
select pg_temp.check();
select is(pg_temp.open('low_stock'), 0, '150 lb is above the reorder level');
insert into batch_additions (brewery_id, batch_id, added_on, kind, name, amount, unit, brew_day)
select b, 'ac000000-0000-0000-0000-0000000000a1', current_date, 'malt', 'PILS MALT', 36.287, 'kg', true from ids;  -- 80 lb
select pg_temp.check();
select ok((select detail from alerts where kind = 'low_stock' and resolved_at is null) like '70.00 lb left%', 'using 80 lb (typed as 36.287 kg) leaves 70 lb: low');

-- 6. Turning a rule off clears its alerts; acknowledging
insert into alert_rules (brewery_id, kind, enabled) select b, 'stage_too_long', false from ids;
select pg_temp.check();
select is(pg_temp.open('stage_too_long'), 0, 'turning a rule off clears its alerts');
select lives_ok($$ select public.acknowledge_alert((select id from alerts where kind = 'under_par' and resolved_at is null)) $$, 'I''ve got it');
select ok((select acknowledged_at is not null from alerts where kind = 'under_par' and resolved_at is null), 'and it''s marked');
select is((select count(*)::int from alerts where resolved_at is null and acknowledged_at is null), 1, 'one still needing attention (low stock)');

-- 7. Who may check
select throws_ok($$ select public.check_alerts(null) $$, '42501', null, 'only the server checks every brewery');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000dc');
select throws_ok($$ select public.check_alerts((select b from ids)) $$, '42501', null, 'an outsider can''t check this brewery');
select is((select count(*)::int from alerts), 0, 'or see its alerts');

select * from finish();
rollback;
