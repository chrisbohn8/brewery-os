-- Moving beer, step 3: level checks (docs/moving-beer-design.md).
--
-- Someone reads the sight glass and types what it shows. That reading is a checkpoint in the
-- ledger (a "level" movement): from then on, the tank's volume counts from it. When the app knew
-- what to expect, the difference is also recorded, as what it was:
--   served      a serving tank pouring to the taproom
--   loss        bottoms, a dump, a spill
--   correction  the earlier numbers were off
-- When the app didn't know (a volume wasn't recorded along the way), the reading simply sets it.
alter table public.beer_movements drop constraint beer_movements_kind_check;
alter table public.beer_movements add constraint beer_movements_kind_check
  check (kind in ('knockout', 'transfer', 'package', 'served', 'loss', 'correction', 'level'));

-- How much of a batch is in a tank now: movements in the order they happened. A level check
-- resets the count to its reading; anything else adds or takes away. Empty if a volume along the
-- way wasn't recorded (and no level check came after it).
create or replace function public.tank_balance(p_batch_id uuid, p_tank_id uuid) returns numeric
language plpgsql stable security invoker set search_path = '' as $$
declare
  m        record;
  total    numeric := 0;
  knockout numeric;
begin
  knockout := coalesce(
    (select r.value from public.batch_readings_current r
      where r.batch_id = p_batch_id and r.field_key = 'ko_volume' and r.turn is null),
    (select b.size_bbl from public.batches b where b.id = p_batch_id));
  for m in
    select * from public.beer_movements
     where batch_id = p_batch_id and (to_tank_id = p_tank_id or from_tank_id = p_tank_id)
     order by occurred_on, recorded_at
  loop
    if m.kind = 'level' then
      total := m.volume_bbl;
    elsif total is not null then
      if m.volume_bbl is null and m.kind <> 'knockout' then
        total := null;
      else
        total := total + case when m.to_tank_id = p_tank_id then 1 else -1 end
                       * coalesce(m.volume_bbl, knockout);
      end if;
    end if;
  end loop;
  return total;
end;
$$;

-- Record a level check, all or nothing. p_reason says what a drop was ('served', 'loss', or
-- 'correction'); a rise is always a correction. Safe to repeat (an offline retry).
create function public.record_level_check(
  p_id uuid, p_brewery_id uuid, p_batch_id uuid, p_tank_id uuid, p_occurred_on date,
  p_reading_bbl numeric, p_reason text, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  current_state record;
  expected      numeric;
begin
  perform public.require_permission(p_brewery_id, 'move_beer', 'check tank levels');
  if exists (select 1 from public.beer_movements where id = p_id) then
    return; -- already saved
  end if;
  if p_reading_bbl is null or p_reading_bbl < 0 then
    raise exception 'Type what the sight glass shows.';
  end if;
  if p_reason not in ('served', 'loss', 'correction') then
    raise exception 'Say what the difference was: served, loss, or a correction.';
  end if;
  select stage, tank_id into current_state from public.batch_status where id = p_batch_id and brewery_id = p_brewery_id;
  if not found then
    raise exception using errcode = '42501', message = 'You don''t have permission to change that batch.';
  end if;
  if current_state.stage = 'packaged' or current_state.tank_id is distinct from p_tank_id then
    raise exception 'That batch isn''t in that tank any more.';
  end if;

  expected := public.tank_balance(p_batch_id, p_tank_id);
  -- The difference first, then the reading itself (in that order, so the checkpoint comes last)
  if expected is not null and expected > p_reading_bbl then
    insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, notes, recorded_at)
    values (p_brewery_id, p_batch_id, p_occurred_on, p_reason, p_tank_id, expected - p_reading_bbl,
            coalesce(p_notes, ''), clock_timestamp());
  elsif expected is not null and expected < p_reading_bbl then
    insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, notes, recorded_at)
    values (p_brewery_id, p_batch_id, p_occurred_on, 'correction', p_tank_id, p_reading_bbl - expected,
            'level check', clock_timestamp());
  end if;
  insert into public.beer_movements (id, brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, notes, recorded_at)
  values (p_id, p_brewery_id, p_batch_id, p_occurred_on, 'level', p_tank_id, p_reading_bbl, coalesce(p_notes, ''), clock_timestamp());
end;
$$;
revoke execute on function public.record_level_check(uuid, uuid, uuid, uuid, date, numeric, text, text) from public, anon;
grant execute on function public.record_level_check(uuid, uuid, uuid, uuid, date, numeric, text, text) to authenticated;
