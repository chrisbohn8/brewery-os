-- Brewery preferences: the units a brewery reads and types in, and its time zone.
--
-- These change only how numbers are SHOWN and TYPED. Every value is stored in one standard
-- unit (gravity as SG, temperature as °C, volume as US barrels), so changing a preference
-- never changes a record, and two breweries' numbers always mean the same thing.
-- Admins change them (the existing "admins can update their brewery" rule covers it).

alter table public.breweries
  add column temperature_unit text not null default 'F'      check (temperature_unit in ('F', 'C')),
  add column gravity_unit     text not null default 'plato'  check (gravity_unit in ('plato', 'sg', 'brix')),
  add column volume_unit      text not null default 'bbl'    check (volume_unit in ('bbl', 'hl', 'gal')),
  add column time_zone        text not null default 'America/Chicago'
    check (length(time_zone) between 3 and 64);
