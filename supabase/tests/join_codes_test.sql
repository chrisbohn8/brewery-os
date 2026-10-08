-- Tests for joining a brewery by invite code, and deleting a brewery made by mistake.
-- Run with:  supabase test db   (private copy)   or   supabase test db --linked   (real project)

begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(21);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.test'),    -- admin of brewery A
  ('00000000-0000-0000-0000-0000000000b1', 'bob.home@example.test'), -- invited at work, signs in at home
  ('00000000-0000-0000-0000-0000000000c1', 'carol@example.test'),    -- guesses codes
  ('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');     -- makes a brewery by mistake

create function pg_temp.act_as(user_id uuid, email text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated', 'email', email)::text, true);
$$;

-- The code itself: two words from the list and four digits, all different
select is((select count(distinct public.new_join_code()) from generate_series(1, 200))::int, 200, '200 codes in a row are all different');
select ok((select bool_and(public.new_join_code() ~ '^[a-z]+-[a-z]+-[0-9]{4}$') from generate_series(1, 200)), 'every code looks like grist-knockout-4821');

-- Alice creates brewery A and invites Bob's work email as a brewer
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
create temp table ids as select public.create_brewery('Brewery A') as brewery_id;
grant all on ids to authenticated;
insert into invites (brewery_id, email, role) select brewery_id, 'bob@work.example.test', 'brewer' from ids;
create temp table bob_code as select code from invites where email = 'bob@work.example.test';
grant all on bob_code to authenticated;
select isnt((select code from bob_code), null, 'a new invite gets a code');

-- Bob signs in with his home email: the email doesn't match, so nothing happens on its own
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob.home@example.test');
select is(public.accept_invites(), 0, 'a different email joins nothing by itself');
select is((select count(*) from invites)::int, 0, 'and he can''t see invites or their codes');

-- With the code (typed in capitals, with spaces) he joins, at the invited level
set local role postgres;
create temp table typed as select upper(replace(code, '-', ' ')) as code from bob_code;
grant all on typed to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1', 'bob.home@example.test');
select is((public.join_with_code((select code from typed)) ->> 'joined'), 'true', 'Bob joins with the code (capitals and spaces don''t matter)');
select is((select role from memberships where user_id = '00000000-0000-0000-0000-0000000000b1'), 'brewer', 'as the level he was invited at');

set local role postgres;
select is((select count(*) from invites where email = 'bob@work.example.test')::int, 0, 'the invite is used up');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');
select is((public.join_with_code((select code from typed)) ->> 'joined'), 'false', 'a used code doesn''t work again');

-- Carol guesses: 5 wrong tries, then she's stopped for an hour (even with a real code)
select is((public.join_with_code('hops-mash-0000') ->> 'reason'), 'That code didn''t work. Check it against the invite email, or ask your admin for it.', 'a wrong code says so');
do $$ begin perform public.join_with_code('hops-mash-000' || n) from generate_series(1, 3) n; end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
insert into invites (brewery_id, email, role) select brewery_id, 'carol@example.test.invalid', 'viewer' from ids;
set local role postgres;
create temp table carol_code as select code from invites where email = 'carol@example.test.invalid';
grant all on carol_code to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');
select is((public.join_with_code('') ->> 'joined'), 'false', 'an empty code joins nothing');
select alike((public.join_with_code((select code from carol_code)) ->> 'reason'), 'Too many wrong codes%', 'after 5 wrong tries, even a right code waits an hour');
select is((select count(*) from memberships)::int, 0, 'Carol is in no brewery');
select is((select count(*) from join_code_tries)::int, 0, 'nobody can read the list of tries');

-- An expired code (made over 14 days ago, never emailed) doesn't work; emailing it again renews it
set local role postgres;
delete from join_code_tries;
update invites set created_at = now() - interval '15 days' where email = 'carol@example.test.invalid';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');
select alike((public.join_with_code((select code from carol_code)) ->> 'reason'), 'That code has expired%', 'a code over 14 days old has expired');
set local role postgres;
update invites set emailed_at = now() where email = 'carol@example.test.invalid';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'carol@example.test');
select is((public.join_with_code((select code from carol_code)) ->> 'brewery_name'), 'Brewery A', 'emailed again, it works again');

-- Deleting: not a brewery with other people in it, and not by someone who isn't its admin
select throws_like($$ select public.delete_brewery((select brewery_id from ids)) $$, 'Only the brewery''s admin%', 'a viewer can''t delete the brewery');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'alice@example.test');
select throws_like($$ select public.delete_brewery((select brewery_id from ids)) $$, 'Other people are in this brewery%', 'an admin can''t delete a brewery with a team');

-- Dave makes a brewery by mistake, adds a tank and a beer, and deletes it
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1', 'dave@example.test');
create temp table oops as select public.create_brewery('Oops Brewing') as brewery_id;
grant all on oops to authenticated;
insert into tanks (brewery_id, name) select brewery_id, 'FV1' from oops;
insert into beers (brewery_id, code, name) select brewery_id, 'pale', 'Pale' from oops;
select lives_ok($$ select public.delete_brewery((select brewery_id from oops)) $$, 'the only person in a brewery can delete it');
set local role postgres;
select is((select count(*) from breweries where id = (select brewery_id from oops))::int, 0, 'the brewery is gone');
select is((select count(*) from tanks where brewery_id = (select brewery_id from oops))::int
        + (select count(*) from memberships where brewery_id = (select brewery_id from oops))::int, 0, 'with everything in it');

select * from finish();
rollback;
