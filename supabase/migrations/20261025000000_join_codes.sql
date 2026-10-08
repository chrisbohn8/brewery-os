-- Joining a brewery by code, and deleting a brewery made by mistake.
--
-- Invites still work by email: sign in with the invited address and you join automatically.
-- But people often sign in with a different address (a personal email instead of a work one),
-- so every invite also gets a short code, like "grist-knockout-4821". It's in the invite email
-- and on the admin's Team page (to read out loud). Typing it in joins the brewery from any email.
--
-- Safety: a code works once, only for 14 days after it was made or last emailed, and each
-- person gets 5 wrong tries an hour. Two brewing words and four digits make about 40 million
-- possible codes, so guessing one isn't practical.
--
-- Deleting: someone who made a brewery by mistake (or just tried the sample data) can delete it,
-- but only while they're the only person in it, so a team's brewery can't be deleted by one tap.

-- ---------- Codes ----------

-- Two words from this list and four digits. Short, easy to say, and no two look alike.
create function public.new_join_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  words text[] := array[
    'grist', 'hops', 'mash', 'wort', 'lauter', 'sparge', 'boil', 'whirlpool',
    'knockout', 'pitch', 'yeast', 'krausen', 'barley', 'malt', 'cask', 'keg',
    'firkin', 'brite', 'cellar', 'kettle', 'mill', 'rye', 'oats', 'wheat',
    'lager', 'stout', 'porter', 'saison', 'pilsner', 'bitter', 'mild', 'amber',
    'hazy', 'crisp', 'roast', 'toast', 'crystal', 'munich', 'vienna', 'cascade',
    'citra', 'mosaic', 'simcoe', 'saaz', 'tettnang', 'fuggle', 'goldings', 'galaxy',
    'dryhop', 'diacetyl', 'gravity', 'plato', 'carboy', 'growler', 'pint', 'tap',
    'bung', 'spunding', 'flight', 'session', 'foam', 'head', 'lacing', 'finings'];
  new_code text;
  r bigint;
begin
  loop
    -- gen_random_uuid() is cryptographically random; take 48 bits of it
    r := ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint;
    new_code := words[1 + r % 64] || '-' || words[1 + (r / 64) % 64] || '-' || lpad(((r / 4096) % 10000)::text, 4, '0');
    exit when not exists (select 1 from public.invites i where i.code = new_code);
  end loop;
  return new_code;
end;
$$;

alter table public.invites add column code text unique;
update public.invites set code = public.new_join_code() where code is null;
alter table public.invites alter column code set default public.new_join_code();
alter table public.invites alter column code set not null;

-- "grist-knockout-4821", "Grist Knockout 4821", "gristknockout4821" are all the same code
create function public.squash_code(c text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(coalesce(c, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- Wrong tries, for the 5-an-hour limit. Only join_with_code() reads or writes it.
create table public.join_code_tries (
  user_id   uuid not null references auth.users on delete cascade,
  tried_at  timestamptz not null default now()
);
create index join_code_tries_by_user on public.join_code_tries (user_id, tried_at);
alter table public.join_code_tries enable row level security;  -- no policies: nobody reads it directly

-- Join the brewery an invite code belongs to. Answers with what happened, so the app can say so:
--   { "joined": true, "brewery_id": ..., "brewery_name": ... }
--   { "joined": false, "reason": "..." }
-- (It answers rather than raising an error, so a wrong try is still counted.)
create function public.join_with_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := auth.uid();
  wanted text := public.squash_code(p_code);
  inv    public.invites;
  joined text;
begin
  if me is null then
    return jsonb_build_object('joined', false, 'reason', 'Sign in first.');
  end if;
  if (select count(*) from public.join_code_tries t where t.user_id = me and t.tried_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('joined', false, 'reason',
      'Too many wrong codes. Wait an hour and try again, or ask your admin to invite the email you signed in with.');
  end if;

  select * into inv from public.invites i where public.squash_code(i.code) = wanted and wanted <> '' for update;
  if inv.id is null then
    insert into public.join_code_tries (user_id) values (me);
    return jsonb_build_object('joined', false, 'reason',
      'That code didn''t work. Check it against the invite email, or ask your admin for it.');
  end if;
  if greatest(inv.created_at, coalesce(inv.emailed_at, inv.created_at)) < now() - interval '14 days' then
    return jsonb_build_object('joined', false, 'reason',
      'That code has expired. Ask your admin to tap "Email again" on the Team page; that makes it work for another 14 days.');
  end if;

  insert into public.memberships (brewery_id, user_id, role) values (inv.brewery_id, me, inv.role)
  on conflict (brewery_id, user_id) do nothing;
  delete from public.invites where id = inv.id;
  select b.name into joined from public.breweries b where b.id = inv.brewery_id;
  return jsonb_build_object('joined', true, 'brewery_id', inv.brewery_id, 'brewery_name', joined);
end;
$$;
revoke execute on function public.join_with_code(text) from public, anon;
grant execute on function public.join_with_code(text) to authenticated;
revoke execute on function public.new_join_code() from public, anon;

-- ---------- Deleting a brewery made by mistake ----------

-- Only its admin, and only while they're the only person in it. Everything in it goes with it
-- (every table's brewery_id is "on delete cascade").
create function public.delete_brewery(p_brewery_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.memberships m
                  where m.brewery_id = p_brewery_id and m.user_id = auth.uid() and m.role = 'admin') then
    raise exception 'Only the brewery''s admin can delete it.' using errcode = '42501';
  end if;
  if exists (select 1 from public.memberships m where m.brewery_id = p_brewery_id and m.user_id <> auth.uid()) then
    raise exception 'Other people are in this brewery, so it can''t be deleted here. Remove them first, or ask for help.'
      using errcode = '42501';
  end if;
  delete from public.breweries where id = p_brewery_id;
end;
$$;
revoke execute on function public.delete_brewery(uuid) from public, anon;
grant execute on function public.delete_brewery(uuid) to authenticated;
