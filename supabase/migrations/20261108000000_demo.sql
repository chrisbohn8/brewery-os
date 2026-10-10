-- The demo, step 2: "Try the demo" (docs/demo-design.md).
--
-- A visitor taps "Try the demo" and is signed in with no email (Supabase's anonymous sign-in). They
-- get their own demo brewery (create_demo_brewery), which the app fills with the demo's records
-- (demo.js). A demo is marked, and it's deleted about a week after it was made (cleanup_demos, daily).
--
-- The rules, kept by the database (not only the screen):
--   - a visitor without an email can only be in a demo brewery: never set up or join a real one
--   - a demo can't make API keys or calendar links (they'd outlive it), upload fonts (licenses),
--     or send invites (no emails from a demo)
--   - nobody can turn a demo into a real brewery, or a real one into a demo

alter table public.breweries add column is_demo boolean not null default false;

-- Is this person signed in without an email (a demo visitor)?
create function public.is_anonymous_user(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select u.is_anonymous from auth.users u where u.id = p_user_id), false);
$$;
revoke execute on function public.is_anonymous_user(uuid) from public, anon, authenticated;

-- A visitor without an email is only ever in a demo brewery
create function public.check_membership_demo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_anonymous_user(new.user_id) and not (select b.is_demo from public.breweries b where b.id = new.brewery_id) then
    raise exception 'This is the demo. To set up or join a real brewery, sign in with your email.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger check_membership_demo before insert or update on public.memberships
  for each row execute function public.check_membership_demo();

-- A demo stays a demo, and a real brewery stays real
create function public.keep_demo_flag() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.is_demo is distinct from old.is_demo then
    raise exception 'A demo brewery can''t become a real one (or the other way around).' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger keep_demo_flag before update on public.breweries
  for each row execute function public.keep_demo_flag();

-- What's switched off in a demo
create function public.not_in_demo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select b.is_demo from public.breweries b where b.id = new.brewery_id) then
    raise exception '%', case tg_table_name
      when 'api_keys' then 'API keys are off in the demo.'
      when 'calendar_feeds' then 'Calendar links are off in the demo.'
      else 'Invites are off in the demo (it doesn''t send emails).' end
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger not_in_demo before insert on public.api_keys for each row execute function public.not_in_demo();
create trigger not_in_demo before insert on public.calendar_feeds for each row execute function public.not_in_demo();
create trigger not_in_demo before insert on public.invites for each row execute function public.not_in_demo();
-- (logos work in a demo; fonts don't)
create function public.no_fonts_in_demo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'font' and (select b.is_demo from public.breweries b where b.id = new.brewery_id) then
    raise exception 'Uploading fonts is off in the demo.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger no_fonts_in_demo before insert on public.brewery_files for each row execute function public.no_fonts_in_demo();

-- "Try the demo": the visitor's own demo brewery (the one they already have, if they come back)
create function public.create_demo_brewery() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b uuid;
begin
  if auth.uid() is null or not public.is_anonymous_user(auth.uid()) then
    raise exception 'The demo is for visitors trying the app without an email.' using errcode = '42501';
  end if;
  select m.brewery_id into b from public.memberships m join public.breweries br on br.id = m.brewery_id
   where m.user_id = auth.uid() and br.is_demo order by br.created_at desc limit 1;
  if b is not null then
    return b;
  end if;
  -- A limit on new demos, so a flood of visitors (or a script) can't fill the database
  if (select count(*) from public.breweries where is_demo and created_at > now() - interval '1 hour') >= 200 then
    raise exception 'Lots of people are trying the demo right now. Please try again in a little while.' using errcode = '53400';
  end if;
  insert into public.breweries (name, is_demo, time_zone) values ('Demo Brewing Co.', true, 'America/Chicago') returning id into b;
  insert into public.memberships (brewery_id, user_id, role) values (b, auth.uid(), 'admin');
  return b;
end;
$$;
revoke execute on function public.create_demo_brewery() from public, anon;
grant execute on function public.create_demo_brewery() to authenticated;

-- Every day: demos over a week old are deleted (everything in them goes too), and so are the
-- visitors' sign-ins once they're in no brewery
create function public.cleanup_demos() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  removed integer;
begin
  with gone as (delete from public.breweries where is_demo and created_at < now() - interval '7 days' returning id)
  select count(*) into removed from gone;
  delete from auth.users u
   where u.is_anonymous and u.created_at < now() - interval '8 days'
     and not exists (select 1 from public.memberships m where m.user_id = u.id);
  return removed;
end;
$$;
revoke execute on function public.cleanup_demos() from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('brewery-os-demo-cleanup', '23 9 * * *', $job$ select public.cleanup_demos(); $job$);
