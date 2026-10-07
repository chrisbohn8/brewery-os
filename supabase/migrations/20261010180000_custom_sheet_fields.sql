-- A brewery's own brew-day fields, for anything the app's catalog doesn't have. Each is
--   { "key": "custom_ab12cd", "label": "Hot side DO", "section": "Knockout", "type": "number", "unit": "ppb" }
-- Readings are stored under the key, like any other field. Fields are never deleted (only unticked
-- in sheet_fields), so readings recorded under them always have a name to show with.
alter table public.breweries
  add column sheet_custom_fields jsonb not null default '[]'
    check (jsonb_typeof(sheet_custom_fields) = 'array' and jsonb_array_length(sheet_custom_fields) <= 200);

-- Same rules as before; adding the brewery's own fields needs the brewery settings permission too
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
  if (new.sheet_fields, new.sheet_custom_fields) is distinct from (old.sheet_fields, old.sheet_custom_fields) then
    perform public.require_permission(old.id, 'manage_settings', 'choose the brew sheet''s fields');
  end if;
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;
