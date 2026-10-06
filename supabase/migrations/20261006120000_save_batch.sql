-- Saving a batch as ONE all-or-nothing step.
--
-- Before: the app saved a batch in several separate requests (the batch, its history event,
-- the tank it left, the tank it entered). If the connection dropped halfway, records were
-- left half-changed. Now the app makes one call, and the database does every part of it
-- in a single transaction: all of it happens, or none of it does.
--
-- This also makes saving safe to repeat. The app sends "this is how the batch should look
-- now", not "make these changes", so sending the same save twice (for example when an
-- offline phone retries) doesn't add a second history event.
--
-- It runs with the permissions of the person calling it ("security invoker"), so the
-- row-level security rules still decide who may change what.

create function public.save_batch(
  p_id               uuid,     -- the batch's ID (made by the app, so a new batch can be saved offline)
  p_brewery_id       uuid,
  p_batch_number     text,
  p_beer_id          uuid,
  p_brew_date        date,
  p_size_bbl         numeric,
  p_stage            text,
  p_stage_started_on date,     -- when the current stage began
  p_tank_id          uuid,     -- ignored when packaged (packaged beer is in no tank)
  p_action_date      date      -- the day the person did this, on their device (counts for offline saves)
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  current_state   record;   -- the batch as it is now (null for a new batch)
  start_event_id  uuid;
  in_tank         boolean := p_stage <> 'packaged';
  new_tank        uuid := case when p_stage <> 'packaged' then p_tank_id end;
  occupant        record;
  stage_changed   boolean;
  tank_changed    boolean;
begin
  -- A clear message for viewers (row-level security would block them anyway)
  if not public.can_edit(p_brewery_id) then
    raise exception using errcode = '42501', message = 'You don''t have permission to change batches.';
  end if;

  if in_tank and p_tank_id is null then
    raise exception 'Choose a tank for this batch.';
  end if;

  -- Lock the tank the batch is going into, so two people can't fill it at the same moment
  if in_tank then
    perform 1 from public.tanks where id = new_tank for update;
    if not found then
      raise exception 'That tank no longer exists.';
    end if;

    -- One batch per tank: is a different batch in it right now?
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

  select stage, tank_id, stage_started_on into current_state from public.batch_status where id = p_id;

  -- The batch's own details
  insert into public.batches (id, brewery_id, batch_number, beer_id, brew_date, size_bbl)
  values (p_id, p_brewery_id, trim(p_batch_number), p_beer_id, p_brew_date, p_size_bbl)
  on conflict (id) do update
    set batch_number = excluded.batch_number,
        beer_id      = excluded.beer_id,
        brew_date    = excluded.brew_date,
        size_bbl     = excluded.size_bbl;

  -- History: a new stage or a new tank adds an event. Nothing is overwritten.
  stage_changed := current_state.stage is distinct from p_stage;
  tank_changed  := in_tank and current_state.tank_id is distinct from new_tank;

  if stage_changed or tank_changed then
    insert into public.batch_events (brewery_id, batch_id, effective_date, stage, tank_id)
    values (
      p_brewery_id, p_id,
      -- A stage change happens on its "stage started" date; a plain transfer happens on the action date
      case when stage_changed then p_stage_started_on else p_action_date end,
      p_stage, new_tank
    );
  elsif current_state.stage_started_on is distinct from p_stage_started_on then
    -- Same stage and tank, different date: a correction. Move the event where this stage began.
    select e.id into start_event_id
      from public.batch_events e
     where e.batch_id = p_id and e.stage = p_stage and e.effective_date = current_state.stage_started_on
     order by e.recorded_at
     limit 1;
    update public.batch_events set effective_date = p_stage_started_on where id = start_event_id;
  end if;

  -- Tanks: the one the beer left needs cleaning; the one it entered is no longer "cleaning" or "maintenance"
  if current_state.tank_id is not null and current_state.stage <> 'packaged'
     and (not in_tank or current_state.tank_id <> new_tank) then
    update public.tanks set status = 'cleaning' where id = current_state.tank_id;
  end if;
  if tank_changed or (in_tank and current_state.stage = 'packaged') then
    update public.tanks set status = 'empty' where id = new_tank;
  end if;
end;
$$;

revoke execute on function public.save_batch(uuid, uuid, text, uuid, date, numeric, text, date, uuid, date) from public, anon;
grant execute on function public.save_batch(uuid, uuid, text, uuid, date, numeric, text, date, uuid, date) to authenticated;
