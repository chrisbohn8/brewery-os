-- API keys (Phase 6½; the user's API-first idea). Outside tools and AI agents use a key to read
-- and write through the same database rules the app uses.
--
-- A key belongs to a person in a brewery, and carries up to all of that person's permissions
-- (chosen when it's made). Whenever it's used, it can do only what BOTH the key and the person
-- can do right now, so removing someone from the brewery, or lowering their level, also limits
-- their keys. The key itself is shown once; only a scrambled copy (a SHA-256 hash) is stored.
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  brewery_id    uuid not null references public.breweries on delete cascade,
  user_id       uuid not null references auth.users on delete cascade,
  name          text not null check (length(trim(name)) > 0 and length(name) <= 60),
  prefix        text not null,                         -- the key's first characters, to recognize it
  key_hash      text not null unique,
  permissions   text[] not null check (permissions <@ public.permission_list()),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
alter table public.api_keys enable row level security;
-- You see your own keys; an admin sees the brewery's. (The scrambled copy is never needed by the app.)
create policy "see keys" on public.api_keys for select to authenticated
  using (user_id = auth.uid() or public.is_admin(brewery_id));
-- The scrambled copy isn't readable through the API at all: only the other columns are.
revoke select on public.api_keys from authenticated, anon;
grant select (id, brewery_id, user_id, name, prefix, permissions, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;

-- When a request comes in with a key, the API marks it in the session's claims. Then every
-- permission check also requires the key to include that permission (a key can only narrow).
create function public.api_key_permissions() returns text[]
language sql stable set search_path = '' as $$
  select case when current_setting('request.jwt.claims', true)::jsonb ? 'api_permissions'
              then array(select jsonb_array_elements_text(current_setting('request.jwt.claims', true)::jsonb -> 'api_permissions'))
         end;
$$;

create or replace function public.has_permission(b uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.memberships m
      left join public.role_levels l on l.brewery_id = m.brewery_id and l.level = m.role
     where m.brewery_id = b
       and m.user_id = auth.uid()
       and (
         m.role = 'admin'
         or ((perm = any(coalesce(l.permissions, public.default_permissions(m.role))) or perm = any(m.grants))
             and not perm = any(m.revokes))
       )
  )
  and (public.api_key_permissions() is null or perm = any(public.api_key_permissions()));
$$;

-- Make a key: returns it ONCE (it can't be shown again). Only your own permissions can be given.
create function public.create_api_key(p_brewery_id uuid, p_name text, p_permissions text[]) returns text
language plpgsql security definer set search_path = '' as $$
declare
  key text;
  mine text[];
begin
  if not public.is_member(p_brewery_id) then
    raise exception using errcode = '42501', message = 'You''re not part of that brewery.';
  end if;
  if public.api_key_permissions() is not null then
    raise exception using errcode = '42501', message = 'A key can''t make other keys.';
  end if;
  mine := public.my_permissions(p_brewery_id);
  if not (coalesce(p_permissions, '{}') <@ mine) then
    raise exception using errcode = '42501', message = 'A key can only have permissions you have.';
  end if;
  key := 'bos_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_keys (brewery_id, user_id, name, prefix, key_hash, permissions)
  values (p_brewery_id, auth.uid(), trim(p_name), left(key, 12), encode(extensions.digest(key, 'sha256'), 'hex'),
          coalesce(p_permissions, '{}'));
  return key;
end;
$$;
revoke execute on function public.create_api_key(uuid, text, text[]) from public, anon;
grant execute on function public.create_api_key(uuid, text, text[]) to authenticated;

-- Revoke a key: your own, or (an admin) any of the brewery's. Revoked keys stop working at once.
create function public.revoke_api_key(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.api_keys set revoked_at = now()
   where id = p_id and revoked_at is null and (user_id = auth.uid() or public.is_admin(brewery_id));
  if not found then
    raise exception using errcode = '42501', message = 'That key isn''t yours to revoke.';
  end if;
end;
$$;
revoke execute on function public.revoke_api_key(uuid) from public, anon;
grant execute on function public.revoke_api_key(uuid) to authenticated;
