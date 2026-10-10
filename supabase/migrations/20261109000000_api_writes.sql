-- API writes, step 1: every write is attributed and listed (docs/api-writes-design.md).
--
-- The API function marks its transaction with the key it's using (brewery_os.api_key). Records made
-- in that transaction are stamped with the key (via_key) by the database itself, so it can't be left
-- off or faked: a person in the app can't set it, and an API request can't set a different key.
-- Each write is also listed (api_actions), for the key's activity in Settings → API keys.

-- The key this transaction is acting through (null in the app)
create function public.current_api_key() returns uuid
language sql stable set search_path = '' as $$
  select nullif(current_setting('brewery_os.api_key', true), '')::uuid;
$$;

create function public.stamp_via_key() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.via_key := public.current_api_key();
  return new;
end;
$$;

-- Records made through a key (a change to a beer, tank, or draft line: the latest change's key)
do $$
declare
  t text;
begin
  foreach t in array array['batches', 'batch_events', 'beer_movements', 'cellar_entries', 'batch_additions', 'batch_readings',
                           'stock_moves', 'tank_cleanings', 'raw_receipts', 'raw_adjustments', 'plan_items',
                           'beers', 'tanks', 'draft_lines'] loop
    execute format('alter table public.%I add column via_key uuid references public.api_keys on delete set null', t);
    execute format('create trigger stamp_via_key before insert%s on public.%I for each row execute function public.stamp_via_key()',
                   case when t in ('beers', 'tanks', 'draft_lines') then ' or update' else '' end, t);
  end loop;
end;
$$;

-- ---------- Each key's activity ----------
create table public.api_actions (
  id          uuid primary key default gen_random_uuid(),
  brewery_id  uuid not null references public.breweries on delete cascade,
  key_id      uuid not null references public.api_keys on delete cascade,
  status      text not null default 'done' check (status in ('done', 'suggested', 'approved', 'rejected', 'undone')),
  method      text not null check (method in ('POST', 'PATCH', 'PUT', 'DELETE')),
  path        text not null check (length(path) <= 300),
  summary     text not null default '' check (length(summary) <= 300),   -- "Logged a check on #142"
  request     jsonb not null default '{}',                                -- what was sent
  result      jsonb not null default '{}',                                -- what it made (ids), for links and undo
  created_at  timestamptz not null default now(),
  decided_by  uuid references auth.users on delete set null,              -- who approved, rejected, or undid it
  decided_at  timestamptz
);
create index api_actions_brewery on public.api_actions (brewery_id, created_at desc);
alter table public.api_actions enable row level security;
-- Everyone in the brewery can see what keys did there (the records themselves are visible to them anyway)
create policy "members read" on public.api_actions for select to authenticated using (public.is_member(brewery_id));
revoke insert, update, delete on public.api_actions from authenticated, anon;

-- Listed by the API function, inside the write's own transaction (so a write that fails isn't listed)
create function public.log_api_action(p_method text, p_path text, p_summary text, p_request jsonb, p_result jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  k      public.api_keys;
  new_id uuid;
begin
  select * into k from public.api_keys a where a.id = public.current_api_key() and a.user_id = auth.uid() and a.revoked_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'Only the API lists its own writes.';
  end if;
  insert into public.api_actions (brewery_id, key_id, method, path, summary, request, result)
  values (k.brewery_id, k.id, p_method, left(p_path, 300), left(coalesce(p_summary, ''), 300), coalesce(p_request, '{}'), coalesce(p_result, '{}'))
  returning api_actions.id into new_id;
  return new_id;
end;
$$;
revoke execute on function public.log_api_action(text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.log_api_action(text, text, text, jsonb, jsonb) to authenticated;

-- The names of a brewery's keys, for "via My AI assistant" (everyone in the brewery; nothing secret)
create function public.api_key_names(p_brewery_id uuid) returns table (id uuid, name text, revoked boolean)
language sql stable security definer set search_path = '' as $$
  select k.id, k.name, k.revoked_at is not null from public.api_keys k
   where k.brewery_id = p_brewery_id and public.is_member(p_brewery_id);
$$;
revoke execute on function public.api_key_names(uuid) from public, anon;
grant execute on function public.api_key_names(uuid) to authenticated;
