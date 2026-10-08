-- Reasons for stock changes (the user's idea): a brewery can ask for a reason on every count,
-- move, and removal ("Stocked the taproom", "Dock sale", "Distributor order"...), from its own
-- list or typed. The reason is kept with each stock move (notes). Off by default.
alter table public.breweries
  add column stock_reasons text[] not null default '{}' check (cardinality(stock_reasons) <= 50),
  add column require_stock_reason boolean not null default false;

create or replace function public.check_brewery_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.name is distinct from old.name then
    perform public.require_permission(old.id, 'rename_brewery', 'rename the brewery');
  end if;
  if (new.temperature_unit, new.gravity_unit, new.volume_unit, new.time_zone, new.target_limits)
     is distinct from (old.temperature_unit, old.gravity_unit, old.volume_unit, old.time_zone, old.target_limits) then
    perform public.require_permission(old.id, 'manage_settings', 'change units, the time zone, or target limits');
  end if;
  if (new.sheet_fields, new.sheet_custom_fields, new.sheet_field_settings)
     is distinct from (old.sheet_fields, old.sheet_custom_fields, old.sheet_field_settings) then
    perform public.require_permission(old.id, 'manage_settings', 'choose the brew sheet''s fields');
  end if;
  if (new.stock_reasons, new.require_stock_reason) is distinct from (old.stock_reasons, old.require_stock_reason) then
    perform public.require_permission(old.id, 'manage_settings', 'change the reasons for stock changes');
  end if;
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;

create or replace function public.record_stock(
  p_id uuid, p_brewery_id uuid, p_date date, p_from uuid, p_to uuid, p_removal text,
  p_lines jsonb, p_account text, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  line jsonb;
begin
  perform public.require_permission(p_brewery_id, 'inventory', 'count and move finished goods');
  if coalesce(nullif(trim(p_notes), ''), 'count') = 'count'
     and (select require_stock_reason from public.breweries where id = p_brewery_id) then
    raise exception 'This brewery asks for a reason on every stock change.';
  end if;
  if exists (select 1 from public.stock_moves where group_id = p_id) then
    return; -- already saved
  end if;
  if p_from is null and p_to is null then
    raise exception 'Choose where the stock is coming from or going to.';
  end if;
  if p_from = p_to then
    raise exception 'Moving stock needs two different places.';
  end if;
  if exists (select 1 from unnest(array[p_from, p_to]) x(id) where id is not null
              and not exists (select 1 from public.stock_places where id = x.id and brewery_id = p_brewery_id)) then
    raise exception using errcode = '42501', message = 'That place isn''t in this brewery.';
  end if;
  if p_from is not null and p_to is null and p_removal is null then
    raise exception 'Say what kind of removal it was.';
  end if;
  for line in select * from jsonb_array_elements(p_lines) loop
    if (line->>'count')::numeric <= 0 then continue; end if;
    if p_from is not null then
      perform public.take_stock(p_brewery_id, p_id, p_date, case when p_to is null then 'removed' else 'moved' end,
                                case when p_to is null then p_removal end, (line->>'beer')::uuid, (line->>'batch')::uuid,
                                (line->>'type')::uuid, (line->>'count')::numeric, p_from, p_to, p_account, p_notes);
    else
      -- Returned into stock: to the batch given, or the beer's newest batch
      insert into public.stock_moves (brewery_id, group_id, occurred_on, kind, beer_id, batch_id, package_type_id, count,
                                      to_place_id, account, notes)
      values (p_brewery_id, p_id, p_date, 'returned', (line->>'beer')::uuid,
              coalesce((line->>'batch')::uuid, (select id from public.batches where beer_id = (line->>'beer')::uuid
                                                 and brewery_id = p_brewery_id order by brew_date desc nulls last limit 1)),
              (line->>'type')::uuid, (line->>'count')::numeric, p_to, coalesce(p_account, ''), coalesce(p_notes, ''));
    end if;
  end loop;
end;
$$;

create or replace function public.record_count(
  p_id uuid, p_brewery_id uuid, p_place_id uuid, p_date date, p_lines jsonb, p_drop text, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  line      jsonb;
  expected  numeric;
  counted   numeric;
begin
  perform public.require_permission(p_brewery_id, 'inventory', 'count finished goods');
  if coalesce(nullif(trim(p_notes), ''), 'count') = 'count'
     and (select require_stock_reason from public.breweries where id = p_brewery_id) then
    raise exception 'This brewery asks for a reason on every stock change.';
  end if;
  if exists (select 1 from public.stock_moves where group_id = p_id) then
    return; -- already saved
  end if;
  if not exists (select 1 from public.stock_places where id = p_place_id and brewery_id = p_brewery_id) then
    raise exception using errcode = '42501', message = 'That place isn''t in this brewery.';
  end if;
  for line in select * from jsonb_array_elements(p_lines) loop
    counted := (line->>'counted')::numeric;
    if counted is null or counted < 0 then continue; end if;
    select coalesce(sum(count), 0) into expected from public.stock_on_hand
     where brewery_id = p_brewery_id and place_id = p_place_id
       and beer_id = (line->>'beer')::uuid and package_type_id = (line->>'type')::uuid;
    if counted < expected then
      perform public.take_stock(p_brewery_id, p_id, p_date, 'removed', coalesce(p_drop, 'unknown'), (line->>'beer')::uuid, null,
                                (line->>'type')::uuid, expected - counted, p_place_id, null, '', coalesce(p_notes, 'count'));
    elsif counted > expected then
      insert into public.stock_moves (brewery_id, group_id, occurred_on, kind, beer_id, batch_id, package_type_id, count,
                                      to_place_id, notes, recorded_at)
      values (p_brewery_id, p_id, p_date, 'counted', (line->>'beer')::uuid,
              (select id from public.batches where beer_id = (line->>'beer')::uuid and brewery_id = p_brewery_id
                order by brew_date desc nulls last limit 1),
              (line->>'type')::uuid, counted - expected, p_place_id, coalesce(p_notes, 'count'), clock_timestamp());
    end if;
  end loop;
end;
$$;
