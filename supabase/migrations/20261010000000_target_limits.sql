-- How far from its target a brew-day value can be before the sheet flags it ("Far from target. Typo?").
-- One limit per kind of reading, per brewery, in standard units:
--   gravity     SG (0.004 is about 1 °P)
--   temperature degrees C (1.6667 is 3 °F)
--   ph          pH
--   amount      a share of the target, for volumes and other amounts (0.1 = 10%)
-- A missing or null limit means "don't flag that kind of reading".
alter table public.breweries
  add column target_limits jsonb not null
    default '{"gravity": 0.004, "temperature": 1.6667, "ph": 0.15, "amount": 0.1}'
    check (jsonb_typeof(target_limits) = 'object');

-- Same rules as before, plus: changing the limits needs the units-and-time-zone permission
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
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;
