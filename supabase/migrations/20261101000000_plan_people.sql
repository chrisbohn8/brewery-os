-- Planning calendar, step 5 (part): who's on an item ("Sam brews Tuesday").
--
-- Optional. Someone who can only move items can also hand one to another person (that's part of
-- arranging the week), but the person must be in the brewery.

alter table public.plan_items add column assigned_to uuid references auth.users on delete set null;

create or replace function public.check_plan_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.assigned_to is not null and not exists (
       select 1 from public.memberships m where m.brewery_id = new.brewery_id and m.user_id = new.assigned_to) then
    raise exception 'That person isn''t in this brewery.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  if auth.uid() is not null and not public.has_permission(new.brewery_id, 'plan_schedule')
     and (new.kind, new.title, new.someday, new.beer_id, new.batch_id, new.notes, new.brewery_id)
         is distinct from (old.kind, old.title, old.someday, old.beer_id, old.batch_id, old.notes, old.brewery_id) then
    raise exception 'You can move items on the calendar and tick them done, but not change what they are.' using errcode = '42501';
  end if;
  return new;
end;
$$;
-- Now also checked when an item is added (the person must be in the brewery)
drop trigger check_plan_change on public.plan_items;
create trigger check_plan_change before insert or update on public.plan_items
  for each row execute function public.check_plan_change();
