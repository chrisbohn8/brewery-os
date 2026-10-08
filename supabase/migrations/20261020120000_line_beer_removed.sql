-- When a beer that's pouring on a draft line is deleted, the line becomes empty (instead of the
-- delete being refused because a "pouring a beer" line would have no beer).
create function public.stamp_line() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.status = 'beer' and new.beer_id is null then
    new.status := 'empty';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger stamp_line on public.draft_lines;
create trigger stamp_line before update on public.draft_lines for each row execute function public.stamp_line();
