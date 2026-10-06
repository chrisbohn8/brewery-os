-- Team: inviting coworkers into a brewery, seeing who's in it, and changing roles.
--
-- How joining works: an admin adds an invite (email + role). When someone signs in with that
-- email, accept_invites() turns the invite into a membership. Signing in by emailed code proves
-- the person owns the address, so the email is all that's needed.
--
-- Safety: a brewery always keeps at least one admin (see keep_an_admin), so nobody can lock
-- a brewery out of its own settings by removing or demoting the last admin.

create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  email       text not null check (email = lower(trim(email)) and email like '_%@_%'),
  role        text not null default 'brewer' check (role in ('admin', 'brewer', 'viewer')),
  invited_by  uuid default auth.uid() references auth.users on delete set null,
  created_at  timestamptz not null default now()
);
-- One invite per email per brewery
create unique index invites_one_per_email on public.invites (brewery_id, email);

alter table public.invites enable row level security;
create policy "admins manage invites" on public.invites
  for all to authenticated using (public.is_admin(brewery_id)) with check (public.is_admin(brewery_id));

-- Called by the app right after sign-in: join every brewery that invited this email.
-- Returns how many breweries were joined.
create function public.accept_invites() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  my_email text := lower(auth.jwt() ->> 'email');
  joined   integer;
begin
  if auth.uid() is null or my_email is null then
    return 0;
  end if;
  insert into public.memberships (brewery_id, user_id, role)
  select i.brewery_id, auth.uid(), i.role from public.invites i where i.email = my_email
  on conflict (brewery_id, user_id) do nothing;
  get diagnostics joined = row_count;
  delete from public.invites where email = my_email;
  return joined;
end;
$$;
revoke execute on function public.accept_invites() from public, anon;
grant execute on function public.accept_invites() to authenticated;

-- Who's in a brewery, with their emails. (Emails live in Supabase's private sign-in table,
-- so this reads them for the members of YOUR brewery only.)
create function public.brewery_members(p_brewery_id uuid)
returns table (user_id uuid, email text, role text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email::text, m.role
    from public.memberships m
    join auth.users u on u.id = m.user_id
   where m.brewery_id = p_brewery_id
     and public.is_member(p_brewery_id)
   order by u.email;
$$;
revoke execute on function public.brewery_members(uuid) from public, anon;
grant execute on function public.brewery_members(uuid) to authenticated;

-- A brewery always keeps at least one admin. (Deleting the whole brewery is still fine.)
create function public.keep_an_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and exists (select 1 from public.breweries b where b.id = old.brewery_id)
     and not exists (
       select 1 from public.memberships m
        where m.brewery_id = old.brewery_id and m.role = 'admin' and m.user_id <> old.user_id
     ) then
    raise exception 'A brewery needs at least one admin. Make someone else an admin first.';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger keep_an_admin
  before update or delete on public.memberships
  for each row execute function public.keep_an_admin();
