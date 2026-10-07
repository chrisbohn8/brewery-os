-- Moving beer, step 1: beer is tracked by VOLUME (docs/moving-beer-design.md).
--
-- A ledger of movements, like a bank account: knockout into a tank, transfers between tanks,
-- packaging out of a tank, losses, and corrections. What's in a tank is worked out from the
-- movements (tank_balance below); it's never stored, so it can't drift out of step.
--
--   from_tank_id  the tank the beer left (empty for a knockout)
--   to_tank_id    the tank the beer went into (empty for packaging, losses, serving)
--   volume_bbl    how much, in US barrels; empty = not recorded (it's allowed: nothing breaks,
--                 and gaps show honestly instead of being made up)
--
-- Append-only: a mistake is fixed with a correction movement, never by editing history.
create table public.beer_movements (
  id            uuid primary key default gen_random_uuid(),
  brewery_id    uuid not null references public.breweries on delete cascade,
  batch_id      uuid not null,
  occurred_on   date not null,
  kind          text not null check (kind in ('knockout', 'transfer', 'package', 'served', 'loss', 'correction')),
  from_tank_id  uuid,
  to_tank_id    uuid,
  volume_bbl    numeric check (volume_bbl >= 0),
  notes         text not null default '' check (length(notes) <= 500),
  recorded_by   uuid default auth.uid() references auth.users on delete set null,
  recorded_at   timestamptz not null default now(),
  check (from_tank_id is not null or to_tank_id is not null),
  foreign key (brewery_id, batch_id) references public.batches (brewery_id, id) on delete cascade,
  foreign key (brewery_id, from_tank_id) references public.tanks (brewery_id, id),
  foreign key (brewery_id, to_tank_id) references public.tanks (brewery_id, id)
);
create index beer_movements_batch on public.beer_movements (batch_id, occurred_on);
create index beer_movements_tanks on public.beer_movements (brewery_id, from_tank_id, to_tank_id);

alter table public.beer_movements enable row level security;
create policy "members read" on public.beer_movements for select to authenticated using (public.is_member(brewery_id));
-- Day-to-day movements are written by save_batch() (and later, packaging and level checks).
-- Writing directly (loading a backup) needs the "move beer" permission; there's no editing.
create policy "record movements" on public.beer_movements for insert to authenticated
  with check (public.has_permission(brewery_id, 'move_beer'));
create policy "remove movements" on public.beer_movements for delete to authenticated
  using (public.has_permission(brewery_id, 'delete_records'));

-- How much of a batch is in a tank now, in barrels (empty if any volume along the way wasn't
-- recorded). A knockout with no volume counts as the brew sheet's knockout volume, or the batch size.
create function public.tank_balance(p_batch_id uuid, p_tank_id uuid) returns numeric
language sql stable security invoker set search_path = '' as $$
  with knockout_volume as (
    select coalesce(
      (select r.value from public.batch_readings_current r
        where r.batch_id = p_batch_id and r.field_key = 'ko_volume' and r.turn is null),
      (select b.size_bbl from public.batches b where b.id = p_batch_id)) as v
  ),
  moves as (
    select case when m.to_tank_id = p_tank_id then 1 else -1 end as sign,
           case when m.volume_bbl is null and m.kind = 'knockout' then (select v from knockout_volume)
                else m.volume_bbl end as v
      from public.beer_movements m
     where m.batch_id = p_batch_id and (m.to_tank_id = p_tank_id or m.from_tank_id = p_tank_id)
  )
  select case when bool_or(v is null) then null else coalesce(sum(sign * v), 0) end from moves;
$$;

-- save_batch() gains one optional value: the volume moved (or knocked out). Everything else is the
-- same as before. (A new parameter makes a new function in Postgres, so the old one is replaced.)
drop function public.save_batch(uuid, uuid, text, uuid, date, numeric, text, date, uuid, date);

create function public.save_batch(
  p_id uuid, p_brewery_id uuid, p_batch_number text, p_beer_id uuid, p_brew_date date,
  p_size_bbl numeric, p_stage text, p_stage_started_on date, p_tank_id uuid, p_action_date date,
  p_volume_bbl numeric default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  existing        record;
  current_state   record;
  start_event_id  uuid;
  in_tank         boolean := p_stage <> 'packaged';
  new_tank        uuid := case when p_stage <> 'packaged' then p_tank_id end;
  occupant        record;
  stage_changed   boolean;
  tank_changed    boolean;
  move_date       date;
  balance         numeric;
  moved           numeric;
begin
  if p_volume_bbl is not null and p_volume_bbl < 0 then
    raise exception 'A volume can''t be negative.';
  end if;
  if not public.is_member(p_brewery_id) then
    raise exception using errcode = '42501', message = 'You don''t have permission to change batches.';
  end if;

  select * into existing from public.batches where id = p_id;
  if found and existing.brewery_id <> p_brewery_id then
    raise exception using errcode = '42501', message = 'You don''t have permission to change batches.';
  end if;
  select stage, tank_id, stage_started_on into current_state from public.batch_status where id = p_id;

  stage_changed := current_state.stage is distinct from p_stage;
  tank_changed  := in_tank and current_state.tank_id is distinct from new_tank;

  -- What kind of change is this, and is this person allowed to make it?
  if existing.id is null
     or (existing.batch_number, existing.beer_id, existing.brew_date, existing.size_bbl)
        is distinct from (trim(p_batch_number), p_beer_id, p_brew_date, p_size_bbl) then
    perform public.require_permission(p_brewery_id, 'start_batch', 'start batches or change batch details');
  end if;
  if (stage_changed or tank_changed) and p_stage = 'packaged' then
    perform public.require_permission(p_brewery_id, 'package', 'package beer');
  elsif stage_changed or tank_changed
        or current_state.stage_started_on is distinct from p_stage_started_on then
    perform public.require_permission(p_brewery_id, 'move_beer', 'change stages or transfer beer');
  end if;

  if in_tank and p_tank_id is null then
    raise exception 'Choose a tank for this batch.';
  end if;

  if in_tank then
    -- Lock the tank (it must belong to this brewery), so two people can't fill it at once
    perform 1 from public.tanks where id = new_tank and brewery_id = p_brewery_id for update;
    if not found then
      raise exception 'That tank no longer exists.';
    end if;
    select s.batch_number, b.name as beer_name, t.name as tank_name
      into occupant
      from public.batch_status s
      join public.beers b on b.id = s.beer_id
      join public.tanks t on t.id = s.tank_id
     where s.tank_id = new_tank and s.stage <> 'packaged' and s.id <> p_id
     limit 1;
    if found then
      raise exception '% already has % in it. Move or package that batch first.', occupant.tank_name, occupant.beer_name;
    end if;
  end if;

  insert into public.batches (id, brewery_id, batch_number, beer_id, brew_date, size_bbl, turns)
  values (p_id, p_brewery_id, trim(p_batch_number), p_beer_id, p_brew_date, p_size_bbl,
          coalesce((select l.usual_turns from public.tanks t join public.locations l on l.id = t.location_id
                     where t.id = new_tank), 1))
  on conflict (id) do update
    set batch_number = excluded.batch_number,
        beer_id      = excluded.beer_id,
        brew_date    = excluded.brew_date,
        size_bbl     = excluded.size_bbl;

  if stage_changed or tank_changed then
    insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id, recorded_by)
    values (p_brewery_id, p_id,
            case when stage_changed then p_stage_started_on else p_action_date end,
            p_stage, new_tank, auth.uid());
  elsif current_state.stage_started_on is distinct from p_stage_started_on then
    select e.id into start_event_id
      from public.batch_events e
     where e.batch_id = p_id and e.stage = p_stage and e.effective_date = current_state.stage_started_on
     order by e.recorded_at
     limit 1;
    update public.batch_events set effective_date = p_stage_started_on where id = start_event_id;
  end if;

  -- Volumes: the movement ledger (see docs/moving-beer-design.md). What's in a tank is worked out
  -- from these; nothing here overwrites anything. A repeated save (an offline retry) changes no
  -- tank, so it adds no movements.
  move_date := case when stage_changed then p_stage_started_on else p_action_date end;
  if existing.id is null and in_tank then
    -- A new batch: knocked out into its tank. With no volume given, the tank's contents are
    -- worked out later from the brew sheet's knockout volume, or the batch size.
    insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl)
    values (p_brewery_id, p_id, coalesce(p_brew_date, move_date), 'knockout', new_tank, p_volume_bbl);
  elsif current_state.tank_id is not null and current_state.stage <> 'packaged' and (tank_changed or not in_tank) then
    -- Beer leaves its tank: transferred to another tank, or packaged. Moved: what was typed, or
    -- everything the ledger says is there. What's left behind (yeast, trub, bottoms) is a loss.
    balance := public.tank_balance(p_id, current_state.tank_id);
    moved := coalesce(p_volume_bbl, balance);
    if moved is not null and balance is not null and moved > balance then
      -- More came out than the ledger had: the earlier numbers were low
      insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, notes)
      values (p_brewery_id, p_id, move_date, 'correction', current_state.tank_id, moved - balance,
              'more moved out than was recorded');
      balance := moved;
    end if;
    insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, from_tank_id, to_tank_id, volume_bbl)
    values (p_brewery_id, p_id, move_date, case when in_tank then 'transfer' else 'package' end,
            current_state.tank_id, new_tank, moved);
    if balance is not null and moved is not null and balance > moved then
      insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, from_tank_id, volume_bbl, notes)
      values (p_brewery_id, p_id, move_date, 'loss', current_state.tank_id, balance - moved, 'left in the tank');
    end if;
  elsif current_state.stage = 'packaged' and in_tank then
    -- Back into a tank after being marked packaged (a correction of an earlier save)
    insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, volume_bbl, notes)
    values (p_brewery_id, p_id, move_date, 'correction', new_tank, p_volume_bbl, 'back in a tank');
  end if;

  -- Tank statuses that follow from the move (trusted: tell the tank trigger it's save_batch)
  perform set_config('brewery_os.saving_batch', 'on', true);
  if current_state.tank_id is not null and current_state.stage <> 'packaged'
     and (not in_tank or current_state.tank_id <> new_tank) then
    update public.tanks set status = 'cleaning' where id = current_state.tank_id;
  end if;
  if tank_changed or (in_tank and current_state.stage = 'packaged') then
    update public.tanks set status = 'empty' where id = new_tank;
  end if;
  perform set_config('brewery_os.saving_batch', 'off', true);
end;
$$;

revoke execute on function public.save_batch(uuid, uuid, text, uuid, date, numeric, text, date, uuid, date, numeric) from public, anon;
grant execute on function public.save_batch(uuid, uuid, text, uuid, date, numeric, text, date, uuid, date, numeric) to authenticated;

-- Batches already in tanks: record how they got there (a knockout into the tank they're in now,
-- with the volume worked out from the brew sheet or batch size). Past transfers keep their
-- history; they just have no volumes.
insert into public.beer_movements (brewery_id, batch_id, occurred_on, kind, to_tank_id, notes)
select s.brewery_id, s.id, coalesce(s.brew_date, s.stage_started_on, current_date), 'knockout', s.tank_id,
       'recorded when volumes were added'
  from public.batch_status s
 where s.stage <> 'packaged' and s.tank_id is not null;
