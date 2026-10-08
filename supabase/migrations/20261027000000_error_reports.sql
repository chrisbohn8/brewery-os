-- Problem reports: when something goes wrong on someone's phone, the app sends a short report
-- here, so it's found the same day instead of a week later.
--
-- A report holds the error message, where it happened in the code (the "stack"), the screen, the
-- app's version, and the browser. Not the brewery's records. Nobody reads this table through the
-- app (no rules let them); it's read in the Supabase dashboard, and the alerts job (which runs every
-- 15 minutes) emails new reports to the address in its ERROR_REPORTS_TO setting, if it has one.
--
-- Anyone may send a report, even signed out (the sign-in screen can break too), so it's guarded:
-- sizes are capped, a repeat of the same problem from the same person within an hour only adds
-- to its count, and past 500 reports in an hour the rest are dropped.

create table public.error_reports (
  id           uuid primary key default gen_random_uuid(),
  reported_at  timestamptz not null default now(),
  last_at      timestamptz not null default now(),
  times        integer not null default 1,
  user_id      uuid references auth.users on delete set null,
  brewery_id   uuid references public.breweries on delete set null,
  message      text not null,
  stack        text not null default '',
  screen       text not null default '',
  app_version  text not null default '',
  browser      text not null default '',
  emailed_at   timestamptz
);
create index error_reports_recent on public.error_reports (last_at);
alter table public.error_reports enable row level security;  -- no rules: not readable from the app

create function public.report_error(p_report jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  msg     text := left(coalesce(nullif(trim(p_report ->> 'message'), ''), 'Unknown problem'), 1000);
  brewery uuid;
begin
  if (select count(*) from public.error_reports where last_at > now() - interval '1 hour') >= 500 then
    return;  -- something is flooding: the first 500 tell the story
  end if;
  -- Which brewery, only if the person is really in it
  begin
    brewery := (p_report ->> 'brewery_id')::uuid;
  exception when others then
    brewery := null;
  end;
  if brewery is not null and not public.is_member(brewery) then
    brewery := null;
  end if;

  update public.error_reports
     set times = times + 1, last_at = now()
   where message = msg and user_id is not distinct from auth.uid() and last_at > now() - interval '1 hour';
  if found then
    return;
  end if;
  insert into public.error_reports (user_id, brewery_id, message, stack, screen, app_version, browser)
  values (auth.uid(), brewery, msg,
          left(coalesce(p_report ->> 'stack', ''), 4000), left(coalesce(p_report ->> 'screen', ''), 200),
          left(coalesce(p_report ->> 'app_version', ''), 80), left(coalesce(p_report ->> 'browser', ''), 300));
end;
$$;
revoke execute on function public.report_error(jsonb) from public;
grant execute on function public.report_error(jsonb) to anon, authenticated;  -- on purpose: signed out too
