-- Which brew-day fields this brewery measures (Settings → Brew sheet). The fields themselves are a
-- catalog in the app; this is the list of field keys the brewery ticked. Empty (null) means "the
-- usual set". Readings already recorded are never affected: a batch always shows every field it has
-- a value for, whether or not the brewery still uses it.
alter table public.breweries
  add column sheet_fields text[]
    check (sheet_fields is null or cardinality(sheet_fields) <= 500);

-- Same rules as before, plus: choosing the brew sheet's fields needs the brewery settings permission
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
  if new.sheet_fields is distinct from old.sheet_fields then
    perform public.require_permission(old.id, 'manage_settings', 'choose the brew sheet''s fields');
  end if;
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;
