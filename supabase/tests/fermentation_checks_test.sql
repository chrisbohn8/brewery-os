-- Tests for the fermentation checks (alerts from a batch's own readings): stalled, looks finished,
-- finished high or low (high left to "stalled"), and pH (a slow start, a rise; sour styles left out);
-- thresholds a brewery can change.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select set_config('role', 'authenticated', true),
       set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}', true);
create temp table ids as select public.create_brewery('Brewery A') as b;
grant all on ids to authenticated;
set local role postgres;
select set_config('request.jwt.claims', '', true);  -- (setting up, not as a person)
update breweries set time_zone = 'UTC', gravity_unit = 'plato';

-- Beers (target FG 1.012) and six batches, each fermenting in its own tank
insert into beers (id, brewery_id, code, name, style, target_fg) select '44444444-0000-0000-0000-000000000001', b, 'ipa', 'IPA', 'American IPA', 1.012 from ids;
insert into beers (id, brewery_id, code, name, style, target_fg) select '44444444-0000-0000-0000-000000000002', b, 'gose', 'Raspberry Gose', 'Gose', 1.008 from ids;
insert into locations (id, brewery_id, name) select '44444444-0000-0000-0000-000000000003', b, 'Main' from ids;
insert into tanks (id, brewery_id, name, type, location_id)
  select ('44444444-0000-0000-0000-0000000000' || n)::uuid, b, 'FV' || n, 'fermenter', '44444444-0000-0000-0000-000000000003'
    from ids, unnest(array['11', '12', '13', '14', '15', '16']) n;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date)
  select ('44444444-0000-0000-0000-0000000001' || n)::uuid, b, n, case when n = '16' then '44444444-0000-0000-0000-000000000002'::uuid else '44444444-0000-0000-0000-000000000001'::uuid end,
         current_date - 8 from ids, unnest(array['11', '12', '13', '14', '15', '16']) n;
insert into batch_events (brewery_id, batch_id, effective_date, stage, tank_id)
  select b, ('44444444-0000-0000-0000-0000000001' || n)::uuid, current_date - 8, 'fermenting', ('44444444-0000-0000-0000-0000000000' || n)::uuid
    from ids, unnest(array['11', '12', '13', '14', '15', '16']) n;
create function pg_temp.read(batch text, days_ago int, sg numeric, ph numeric default null) returns void language sql as $$
  insert into cellar_entries (brewery_id, batch_id, occurred_on, action, gravity_sg, ph)
  select b, ('44444444-0000-0000-0000-0000000001' || batch)::uuid, current_date - days_ago, 'Check', sg, ph from ids;
$$;
-- #11 stalled: 1.0398 three days ago, 1.0395 now (way above 1.012)
select pg_temp.read('11', 6, 1.040), pg_temp.read('11', 3, 1.0398), pg_temp.read('11', 0, 1.0395);
-- #12 looks finished: steady at 1.0122 near its target
select pg_temp.read('12', 5, 1.020), pg_temp.read('12', 2, 1.0125), pg_temp.read('12', 0, 1.0122);
-- #13 finished low: steady at 1.0042, 0.0078 under its target
select pg_temp.read('13', 4, 1.006), pg_temp.read('13', 2, 1.0045), pg_temp.read('13', 0, 1.0042);
-- #14 pH slow: still 5.0 eight days in. #15 pH rising: 4.3 then 4.6. #16 (a Gose) rising too, but sour styles are left out
select pg_temp.read('14', 1, null, 5.0);
select pg_temp.read('15', 3, null, 4.3), pg_temp.read('15', 0, null, 4.6);
select pg_temp.read('16', 3, null, 3.2), pg_temp.read('16', 0, null, 3.5);

create temp table found as select * from public.alert_conditions((select b from ids));
select is((select title from found where kind = 'stalled'), 'IPA #11 looks stalled at 9.9 °P', 'stalled: hardly moving, well above its target');
select ok((select detail from found where kind = 'stalled') like 'FV11: down 0.1 °P in 3 days; target FG 3.1 °P.', 'with how little it dropped');
select is((select title from found where kind = 'looks_finished'), 'IPA #12 looks finished at 3.1 °P', 'looks finished: steady near its target');
select is((select title from found where kind = 'finished_off'), 'IPA #13 finished low: 1.1 °P', 'finished low: steady, well under its target');
select ok(not exists (select 1 from found where kind = 'finished_off' and subject like '%0111'), 'the stalled batch isn''t also "finished high"');
select is((select count(*)::int from found where kind = 'ph' and subject like '%14:slow'), 1, 'pH still high days in: a slow start');
select is((select count(*)::int from found where kind = 'ph' and subject like '%15:rising'), 1, 'pH rising after it dropped');
select is((select count(*)::int from found where kind = 'ph' and subject like '%16:%'), 0, 'a Gose is left out of the pH checks');

-- Thresholds the brewery changes: a drop of 0.0002 (about 0.05 °P) in 3 days counts as moving, and pH off
insert into alert_rules (brewery_id, kind, enabled, params) select b, 'stalled', true, '{"drop": 0.0002}' from ids;
insert into alert_rules (brewery_id, kind, enabled, params) select b, 'ph', false, '{}' from ids;
select is((select count(*)::int from public.alert_conditions((select b from ids)) where kind = 'stalled'), 0, 'a smaller drop counts as moving: not stalled');
select is((select count(*)::int from public.alert_conditions((select b from ids)) where kind = 'ph'), 0, 'pH checks off');

select * from finish();
rollback;
