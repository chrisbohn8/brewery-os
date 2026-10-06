-- Acid tracking: when was each tank last acid-cleaned, and when is it due again?
--
-- What's stored:
--   * tank_cleanings — one row per acid cycle: which tank, what day, an optional note.
--     (The "kind" column leaves room for caustic and other cleanings later.)
--   * tanks.acid_every_turns — "acid this tank after this many batches" (empty = no turn limit).
--   * breweries.acid_after_styles — one list for the whole brewery: styles that always need
--     an acid cycle afterward (for example "Sour", "Brett"). Admins set it.
--
-- What's NOT stored: turns since the last acid, and whether a tank is due. Those are worked
-- out from batch history and these cleaning records, so they can never disagree.

alter table public.tanks
  add column acid_every_turns integer check (acid_every_turns between 1 and 100);

alter table public.breweries
  add column acid_after_styles text[] not null default '{}';

create table public.tank_cleanings (
  id           uuid primary key default gen_random_uuid(),
  brewery_id   uuid not null references public.breweries on delete cascade,
  tank_id      uuid not null,
  kind         text not null default 'acid' check (kind in ('acid')),
  cleaned_on   date not null,
  note         text not null default '',
  recorded_by  uuid default auth.uid() references auth.users on delete set null,
  recorded_at  timestamptz not null default now(),
  -- Same brewery: a cleaning only points at its own brewery's tank.
  -- Deleting a tank deletes its cleaning records.
  foreign key (brewery_id, tank_id) references public.tanks (brewery_id, id) on delete cascade
);
create index tank_cleanings_tank on public.tank_cleanings (tank_id, cleaned_on desc);

alter table public.tank_cleanings enable row level security;
create policy "members read" on public.tank_cleanings for select to authenticated using (public.is_member(brewery_id));
create policy "editors write" on public.tank_cleanings for all to authenticated using (public.can_edit(brewery_id)) with check (public.can_edit(brewery_id));
