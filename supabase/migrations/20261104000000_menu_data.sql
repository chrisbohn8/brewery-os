-- Menu boards, step 1: the menu's data (docs/menu-board-design.md).
--
-- The brewery's lists, kept with its settings (like the brew sheet's fields), each item with an id
-- that beers point at, so renaming "16 oz" to "Pint" changes every beer's menu at once:
--   menu_sizes     [{"id", "name": "16 oz", "oz": 16}]          pour sizes, in order (oz may be empty)
--   menu_sections  [{"id", "name": "IPAs"}]                      in order
--   menu_tags      [{"id", "name": "New", "kind": "badge"}]      kind: badge or allergen
--   menu_fields    [{"id", "name": "Hops", "type": "text", "options": []}]
--                  type: text, number, yesno, or list (pick one of "options")
-- Anyone with "Beer menu details" sets these up (a taproom manager adds a pour size or a tag).
--
-- Each beer's menu details, besides the description, ABV, IBU, and prices it already had:
--   menu_short    a short line for the TV (up to 80 characters)
--   menu_srm      color (SRM), typed or filled in from the recipe for a person to check
--   menu_section  one of menu_sections' ids (or empty)
--   menu_tags     ids from menu_tags
--   menu_extra    the brewery's own fields: {"<field id>": value}
--   menu_public   false = leave off the public menu (still on the TV and print)
--   menu_prices   now [{"size": "<size id>", "price": 7, "at": {"<taproom place id>": 8}}]:
--                 a price per pour size, and optionally a different one at a taproom
-- Today's typed prices ([{"size": "16 oz", "price": 7}]) move onto pour sizes made from their names.

alter table public.breweries
  add column menu_sizes    jsonb not null default '[]' check (jsonb_typeof(menu_sizes) = 'array' and jsonb_array_length(menu_sizes) <= 100),
  add column menu_sections jsonb not null default '[]' check (jsonb_typeof(menu_sections) = 'array' and jsonb_array_length(menu_sections) <= 100),
  add column menu_tags     jsonb not null default '[]' check (jsonb_typeof(menu_tags) = 'array' and jsonb_array_length(menu_tags) <= 100),
  add column menu_fields   jsonb not null default '[]' check (jsonb_typeof(menu_fields) = 'array' and jsonb_array_length(menu_fields) <= 50);

alter table public.beers
  add column menu_short   text not null default '' check (length(menu_short) <= 80),
  add column menu_srm     numeric check (menu_srm between 0 and 100),
  add column menu_section text check (length(menu_section) <= 60),
  add column menu_tags    text[] not null default '{}' check (cardinality(menu_tags) <= 50),
  add column menu_extra   jsonb not null default '{}' check (jsonb_typeof(menu_extra) = 'object'),
  add column menu_public  boolean not null default true;

-- A recipe's color (SRM), from BeerXML, so a beer's menu color can be filled in from it
alter table public.recipes add column color_srm numeric check (color_srm between 0 and 100);

-- ---------- Today's typed prices move onto pour sizes ----------
create temp table typed_sizes on commit drop as
  select brewery_id, name, gen_random_uuid()::text as id,
         (regexp_match(name, '(\d+(?:\.\d+)?)\s*oz', 'i'))[1]::numeric as oz
    from (select distinct on (b.brewery_id, lower(trim(p ->> 'size'))) b.brewery_id, trim(p ->> 'size') as name
            from public.beers b cross join lateral jsonb_array_elements(b.menu_prices) p
           where coalesce(trim(p ->> 'size'), '') <> ''
           order by b.brewery_id, lower(trim(p ->> 'size')), trim(p ->> 'size')) x;

update public.breweries br
   set menu_sizes = (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'oz', s.oz) order by s.oz desc nulls last, s.name)
                       from typed_sizes s where s.brewery_id = br.id)
 where exists (select 1 from typed_sizes s where s.brewery_id = br.id);

update public.beers b
   set menu_prices = coalesce((
         select jsonb_agg(jsonb_build_object('size', s.id, 'price', (p ->> 'price')::numeric) order by e.ord)
           from jsonb_array_elements(b.menu_prices) with ordinality e(p, ord)
           join typed_sizes s on s.brewery_id = b.brewery_id and lower(s.name) = lower(trim(p ->> 'size'))
          where p ->> 'price' is not null), '[]')
 where b.menu_prices <> '[]';

-- From now on, every price names a pour size and has an amount
alter table public.beers add constraint menu_prices_shape check (
  not jsonb_path_exists(menu_prices, '$[*] ? (!exists(@.size) || !exists(@.price) || @.price < 0)'));

-- ---------- Who changes what ----------
-- The brewery's menu lists need "Beer menu details" (the rest of the settings stay as they were)
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
  if (new.stock_reasons, new.require_stock_reason) is distinct from (old.stock_reasons, old.require_stock_reason) then
    perform public.require_permission(old.id, 'manage_settings', 'change the reasons for stock changes');
  end if;
  if (new.alert_quiet_start, new.alert_quiet_end) is distinct from (old.alert_quiet_start, old.alert_quiet_end) then
    perform public.require_permission(old.id, 'manage_settings', 'change alert settings');
  end if;
  if (new.plan_lookahead_days, new.recipes_per, new.gravity_trigger_readings)
     is distinct from (old.plan_lookahead_days, old.recipes_per, old.gravity_trigger_readings) then
    perform public.require_permission(old.id, 'plan_schedule', 'change how the calendar looks ahead');
  end if;
  if new.acid_after_styles is distinct from old.acid_after_styles then
    perform public.require_permission(old.id, 'manage_cleaning', 'change acid rules');
  end if;
  if (new.menu_sizes, new.menu_sections, new.menu_tags, new.menu_fields)
     is distinct from (old.menu_sizes, old.menu_sections, old.menu_tags, old.menu_fields) then
    perform public.require_permission(old.id, 'menu', 'change the menu''s pour sizes, sections, tags, or fields');
  end if;
  return new;
end;
$$;

-- A beer's menu details: the new columns join the old ones (same two rules as before)
create or replace function public.check_beer_change() returns trigger
language plpgsql set search_path = '' as $$
declare
  menu constant text[] := array['menu_description', 'menu_abv', 'menu_ibu', 'menu_prices', 'menu_short', 'menu_srm',
                                'menu_section', 'menu_tags', 'menu_extra', 'menu_public'];
begin
  if auth.uid() is not null and not public.has_permission(old.brewery_id, 'manage_beers')
     and (to_jsonb(new) - menu) is distinct from (to_jsonb(old) - menu) then
    raise exception 'You can change a beer''s menu details, but not the beer itself.' using errcode = '42501';
  end if;
  if auth.uid() is not null and not public.has_permission(old.brewery_id, 'menu')
     and (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(menu) k)
         is distinct from (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(menu) k) then
    raise exception 'You can change the beer, but not its menu details.' using errcode = '42501';
  end if;
  return new;
end;
$$;
