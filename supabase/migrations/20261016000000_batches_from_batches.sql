-- Moving beer, step 4: splits and blends (docs/moving-beer-design.md, decided: option A).
--
-- Both make a NEW batch from existing ones, so a tank still holds one batch and each batch has
-- one stage:
--   split   #142 stays in FV-3 with what's left; #142-2 is made in BT-2 from part of it
--   blend   #142 and #143 go into BT-1 as a new batch "#142/143"
-- In the ledger, beer leaves a source batch ("to_batch") and arrives in the new batch
-- ("from_batch"), with source_batch_id linking the two. That's a transfer, not new beer: TTB
-- counts beer produced only from knockouts. A source that's all used becomes stage "used"
-- (used in another batch): out of its tank, but not packaged.

alter table public.beer_movements add column source_batch_id uuid;
alter table public.beer_movements
  add foreign key (brewery_id, source_batch_id) references public.batches (brewery_id, id) on delete set null (source_batch_id);
alter table public.beer_movements drop constraint beer_movements_kind_check;
alter table public.beer_movements add constraint beer_movements_kind_check
  check (kind in ('knockout', 'transfer', 'package', 'served', 'loss', 'correction', 'level', 'to_batch', 'from_batch'));

alter table public.batch_events drop constraint batch_events_stage_check;
alter table public.batch_events add constraint batch_events_stage_check
  check (stage in ('fermenting', 'dry-hopping', 'conditioning', 'carbonating', 'ready', 'packaged', 'used'));

-- A batch that was all used in another batch is finished: no more stage changes or moves.
-- (Only make_batch_from() below may mark a batch "used".)
create function public.check_batch_event() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.stage = 'used' and coalesce(current_setting('brewery_os.making_batch', true), 'off') <> 'on' then
    raise exception 'A batch is marked "used in another batch" only by making a new batch from it.';
  end if;
  if (select s.stage from public.batch_status s where s.id = new.batch_id) = 'used' then
    raise exception 'This batch was all used in another batch, so it can''t be moved or changed.';
  end if;
  return new;
end;
$$;
create trigger check_batch_event before insert on public.batch_events
  for each row execute function public.check_batch_event();

-- Make a new batch from one or more batches, all or nothing:
--   p_sources  [{ "batch": "<id>", "volume": 15 or null (= all of it), "used_up": true/false }, ...]
-- A used-up source's leftover is recorded as loss, and its tank goes to cleaning (unless the new
-- batch goes into that same tank). Safe to repeat (an offline retry).
create function public.make_batch_from(
  p_id uuid, p_brewery_id uuid, p_batch_number text, p_beer_id uuid, p_tank_id uuid, p_stage text,
  p_occurred_on date, p_sources jsonb, p_notes text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  src        jsonb;
  s          record;
  balance    numeric;
  moved      numeric;
  used_up    boolean;
  occupant   record;
  first_brew date;
begin
  perform public.require_permission(p_brewery_id, 'start_batch', 'make new batches');
  perform public.require_permission(p_brewery_id, 'move_beer', 'move beer');
  if exists (select 1 from public.batches where id = p_id) then
    return; -- already saved
  end if;
  if jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) = 0 then
    raise exception 'Choose the batch (or batches) it''s made from.';
  end if;
  if p_stage in ('packaged', 'used') then
    raise exception 'A new batch starts in a tank.';
  end if;

  -- The tank: it must be this brewery's, and empty unless the batch in it is used up here
  perform 1 from public.tanks where id = p_tank_id and brewery_id = p_brewery_id for update;
  if not found then
    raise exception 'That tank no longer exists.';
  end if;
  select s2.id, s2.batch_number, t.name as tank_name into occupant
    from public.batch_status s2 join public.tanks t on t.id = s2.tank_id
   where s2.tank_id = p_tank_id and s2.stage not in ('packaged', 'used') limit 1;
  if found and not exists (
      select 1 from jsonb_array_elements(p_sources) x
       where (x->>'batch')::uuid = occupant.id and coalesce((x->>'used_up')::boolean, false)) then
    raise exception '% already has #% in it. Use all of it in the new batch, or choose another tank.', occupant.tank_name, occupant.batch_number;
  end if;

  select min(b.brew_date) into first_brew from public.batches b
   where b.id in (select (x->>'batch')::uuid from jsonb_array_elements(p_sources) x);
  insert into public.batches (id, brewery_id, batch_number, beer_id, brew_date, size_bbl, turns)
  values (p_id, p_brewery_id, trim(p_batch_number), p_beer_id, coalesce(first_brew, p_occurred_on), null, 1);

  for src in select * from jsonb_array_elements(p_sources) loop
    select bs.id, bs.stage, bs.tank_id, bs.batch_number into s
      from public.batch_status bs where bs.id = (src->>'batch')::uuid and bs.brewery_id = p_brewery_id;
    if not found or s.tank_id is null or s.stage in ('packaged', 'used') then
      raise exception 'One of those batches isn''t in a tank any more.';
    end if;
    used_up := coalesce((src->>'used_up')::boolean, false);
    if s.tank_id = p_tank_id and not used_up then
      raise exception 'To make the new batch in #%''s tank, use all of #% in it.', s.batch_number, s.batch_number;
    end if;
    balance := public.tank_balance(s.id, s.tank_id);
    moved := coalesce((src->>'volume')::numeric, balance);
    if moved is not null and moved < 0 then
      raise exception 'A volume can''t be negative.';
    end if;

    -- Out of the source, into the new batch (clock_timestamp keeps them in order)
    insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, source_batch_id, notes, recorded_at)
    values (p_brewery_id, s.id, p_occurred_on, 'to_batch', s.tank_id, moved, p_id, 'into #' || trim(p_batch_number), clock_timestamp());
    insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, source_batch_id, notes, recorded_at)
    values (p_brewery_id, p_id, p_occurred_on, 'from_batch', p_tank_id, moved, s.id, 'from #' || s.batch_number, clock_timestamp());

    if used_up then
      -- What's left of the source is a loss (or, if more came out than was recorded, a correction)
      if balance is not null and moved is not null and balance > moved then
        insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, notes, recorded_at)
        values (p_brewery_id, s.id, p_occurred_on, 'loss', s.tank_id, balance - moved, 'left in the tank', clock_timestamp());
      elsif balance is not null and moved is not null and balance < moved then
        insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, notes, recorded_at)
        values (p_brewery_id, s.id, p_occurred_on, 'correction', s.tank_id, moved - balance, 'more moved out than was recorded', clock_timestamp());
      end if;
      perform set_config('brewery_os.making_batch', 'on', true);
      insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id, recorded_by)
      values (p_brewery_id, s.id, p_occurred_on, 'used', null, auth.uid());
      perform set_config('brewery_os.making_batch', 'off', true);
      if s.tank_id <> p_tank_id then
        perform set_config('brewery_os.saving_batch', 'on', true);
        update public.tanks set status = 'cleaning' where id = s.tank_id;
        perform set_config('brewery_os.saving_batch', 'off', true);
      end if;
    end if;
  end loop;

  insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id, recorded_by)
  values (p_brewery_id, p_id, p_occurred_on, p_stage, p_tank_id, auth.uid());
  perform set_config('brewery_os.saving_batch', 'on', true);
  update public.tanks set status = 'empty' where id = p_tank_id;
  perform set_config('brewery_os.saving_batch', 'off', true);
end;
$$;
revoke execute on function public.make_batch_from(uuid, uuid, text, uuid, uuid, text, date, jsonb, text) from public, anon;
grant execute on function public.make_batch_from(uuid, uuid, text, uuid, uuid, text, date, jsonb, text) to authenticated;
