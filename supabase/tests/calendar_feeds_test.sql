-- Tests for calendar links (create_calendar_feed, calendar_feed, revoke_calendar_feed) and step_done.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
set local role postgres;
insert into memberships (brewery_id, user_id, role) select brewery_id, '00000000-0000-0000-0000-0000000000b1', 'brewer' from ids;
insert into tanks (id, brewery_id, name) select '66666666-0000-0000-0000-000000000001', brewery_id, 'FV1' from ids;
insert into beers (id, brewery_id, code, name) select '66666666-0000-0000-0000-000000000002', brewery_id, 'ipa', 'IPA' from ids;
insert into batches (id, brewery_id, batch_number, beer_id, brew_date)
  select '66666666-0000-0000-0000-000000000003', brewery_id, '1042', '66666666-0000-0000-0000-000000000002', current_date - 2 from ids;
insert into batch_events (brewery_id, batch_id, effective_date, stage, tank_id)
  select brewery_id, '66666666-0000-0000-0000-000000000003', current_date - 2, 'fermenting', '66666666-0000-0000-0000-000000000001' from ids;
insert into beer_schedules (brewery_id, beer_id, steps)
  select brewery_id, '66666666-0000-0000-0000-000000000002', '[{"kind": "dry_hop", "day": 5}, {"kind": "package", "day": 14}]' from ids;
insert into plan_items (brewery_id, kind, planned_on, tank_id, assigned_to)
  select brewery_id, 'clean', current_date + 1, '66666666-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-0000000000b1'::uuid from ids
  union all select brewery_id, 'delivery', current_date + 2, null::uuid, null::uuid from ids;

-- step_done: the one rule for "has this batch done that step?"
select is(public.step_done('66666666-0000-0000-0000-000000000003', 'fermenting', 'dry_hop'), false, 'fermenting: not dry hopped yet');
select is(public.step_done('66666666-0000-0000-0000-000000000003', 'conditioning', 'crash'), true, 'conditioning: crashed');
select is(public.step_done('66666666-0000-0000-0000-000000000003', 'fermenting', 'diacetyl_rest'), null::boolean, 'a diacetyl rest: the records can''t tell');

-- Bob makes two links: everything, and only his
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');
create temp table links as select public.create_calendar_feed((select brewery_id from ids), false) as everything,
                                  public.create_calendar_feed((select brewery_id from ids), true) as mine;
grant all on links to authenticated;
select ok((select everything ~ '^cal_[0-9a-f]{48}$' from links), 'a link''s secret is shown once, when it''s made');
select is((select count(*) from calendar_feeds)::int, 2, 'he sees his links (without the secret)');
select throws_ok($$ select token_hash from calendar_feeds $$, '42501', null, 'the scrambled secret can''t be read');
select throws_ok($$ select * from public.calendar_feed((select everything from links)) $$, '42501', null,
  'only the calendar function can read a feed, not people signed in');

set local role postgres;
select is((select string_agg(title, ' | ' order by day, title) from public.calendar_feed((select everything from links))),
  'FV1: Clean · bob | Delivery | FV1: Dry hop: IPA (expected) | FV1: Package: IPA (expected)',
  'everything: planned items (and who), and expected steps from the beer''s schedule');
select is((select string_agg(title, ' | ') from public.calendar_feed((select mine from links))), 'FV1: Clean · bob', 'only his: what he''s on');
select is((select count(*) from public.calendar_feed('cal_000000000000000000000000000000000000000000000000'))::int, 0, 'a wrong link: nothing');

-- Turned off, it stops; and if Bob leaves the brewery, his links stop too
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob@example.test');
select public.revoke_calendar_feed((select id from calendar_feeds where mine_only));
set local role postgres;
select is((select count(*) from public.calendar_feed((select mine from links)))::int, 0, 'a turned-off link shows nothing');
delete from memberships where user_id = '00000000-0000-0000-0000-0000000000b1';
select is((select count(*) from public.calendar_feed((select everything from links)))::int, 0, 'nor does one whose owner left the brewery');

select * from finish();
rollback;
