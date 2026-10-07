-- A new batch starts with its brewhouse's usual number of turns (locations.usual_turns), worked
-- out here from the tank it goes into, so starting a batch stays one change (also offline).
-- The turns can be changed afterward on the batch's brew-day sheet. save_batch is otherwise unchanged.
create or replace function public.save_batch(
  p_id uuid, p_brewery_id uuid, p_batch_number text, p_beer_id uuid, p_brew_date date,
  p_size_bbl numeric, p_stage text, p_stage_started_on date, p_tank_id uuid, p_action_date date
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
begin
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

