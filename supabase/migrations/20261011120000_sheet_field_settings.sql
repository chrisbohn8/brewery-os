-- A brewery's own name and target for any brew-day field (Settings → Brew sheet → tap a field):
--   { "sparge_temp": { "label": "Sparge liquor", "target": { "min": 75.6, "max": 76.7 } },
--     "ko_ph":       { "target": "none" } }
-- Targets are in standard units (°C, SG, bbl), like readings. A field with no entry uses the app's
-- usual name and target. Renaming never changes the field's key, so recorded readings are unaffected.
alter table public.breweries
  add column sheet_field_settings jsonb not null default '{}'
    check (jsonb_typeof(sheet_field_settings) = 'object');

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
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  return new;
end;
$$;
