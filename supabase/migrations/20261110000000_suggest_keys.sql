-- API writes, step 2: suggest-only keys (docs/api-writes-design.md).
--
-- A suggest-only key changes nothing by itself. The API tries each write (so one that couldn't be
-- saved is refused right away, with the usual clear answer), undoes it, and keeps it as a
-- suggestion (api_actions, status 'suggested'). A person in the brewery approves it (the API runs
-- it as them, under their permissions, still marked "via" the key) or rejects it.
-- New keys are suggest-only unless their maker chooses otherwise; keys made before stay direct.

alter table public.api_keys add column mode text not null default 'direct' check (mode in ('direct', 'suggest'));
grant select (mode) on public.api_keys to authenticated;

-- Make a key, now with its mode (suggest-only unless the maker says "direct")
drop function public.create_api_key(uuid, text, text[]);
create function public.create_api_key(p_brewery_id uuid, p_name text, p_permissions text[], p_mode text default 'suggest') returns text
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
  if coalesce(p_mode, 'suggest') not in ('direct', 'suggest') then
    raise exception 'A key either suggests changes or makes them directly.';
  end if;
  mine := public.my_permissions(p_brewery_id);
  if not (coalesce(p_permissions, '{}') <@ mine) then
    raise exception using errcode = '42501', message = 'A key can only have permissions you have.';
  end if;
  key := 'bos_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_keys (brewery_id, user_id, name, prefix, key_hash, permissions, mode)
  values (p_brewery_id, auth.uid(), trim(p_name), left(key, 12), encode(extensions.digest(key, 'sha256'), 'hex'),
          coalesce(p_permissions, '{}'), coalesce(p_mode, 'suggest'));
  return key;
end;
$$;
revoke execute on function public.create_api_key(uuid, text, text[], text) from public, anon;
grant execute on function public.create_api_key(uuid, text, text[], text) to authenticated;

-- A suggestion: kept by the API, from a suggest-only key's write that was tried and undone
create function public.log_api_suggestion(p_method text, p_path text, p_summary text, p_request jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  k      public.api_keys;
  new_id uuid;
begin
  select * into k from public.api_keys a where a.id = public.current_api_key() and a.user_id = auth.uid() and a.revoked_at is null and a.mode = 'suggest';
  if not found then
    raise exception using errcode = '42501', message = 'Only the API keeps a suggest-only key''s suggestions.';
  end if;
  insert into public.api_actions (brewery_id, key_id, status, method, path, summary, request)
  values (k.brewery_id, k.id, 'suggested', p_method, left(p_path, 300), left(coalesce(p_summary, ''), 300), coalesce(p_request, '{}'))
  returning api_actions.id into new_id;
  return new_id;
end;
$$;
revoke execute on function public.log_api_suggestion(text, text, text, jsonb) from public, anon;
grant execute on function public.log_api_suggestion(text, text, text, jsonb) to authenticated;

-- Approving runs in the API (as the person approving); this marks it done, with what it made
create function public.approve_api_suggestion(p_id uuid, p_result jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.api_actions set status = 'approved', decided_by = auth.uid(), decided_at = now(), result = coalesce(p_result, '{}')
   where id = p_id and status = 'suggested' and public.is_member(brewery_id) and public.api_key_permissions() is null;
  if not found then
    raise exception using errcode = '42501', message = 'That suggestion isn''t waiting for review (or isn''t in your brewery).';
  end if;
end;
$$;
revoke execute on function public.approve_api_suggestion(uuid, jsonb) from public, anon;
grant execute on function public.approve_api_suggestion(uuid, jsonb) to authenticated;

-- Rejecting: anyone in the brewery who can change something (not a viewer); never through a key
create function public.reject_api_suggestion(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.api_actions set status = 'rejected', decided_by = auth.uid(), decided_at = now()
   where id = p_id and status = 'suggested' and public.api_key_permissions() is null
     and cardinality(public.my_permissions(brewery_id)) > 0;
  if not found then
    raise exception using errcode = '42501', message = 'That suggestion isn''t waiting for review (or you can''t decide on it).';
  end if;
end;
$$;
revoke execute on function public.reject_api_suggestion(uuid) from public, anon;
grant execute on function public.reject_api_suggestion(uuid) to authenticated;
