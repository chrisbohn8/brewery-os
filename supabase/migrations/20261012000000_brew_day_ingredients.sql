-- Brew-day ingredients (the grain bill, kettle and whirlpool hops, water salts, yeast...) live in
-- the same list as cellar additions, so a batch has one record of everything that went into it,
-- each with its lot number for traceability.
--   brew_day  true for what went in on brew day (shown on the brew-day sheet and printed sheet)
--   turn      which turn, when a batch is brewed in several (empty = the whole batch)
alter table public.batch_additions
  drop constraint batch_additions_kind_check,
  add constraint batch_additions_kind_check
    check (kind in ('malt', 'hop', 'adjunct', 'salt', 'yeast', 'finings', 'fruit', 'spice', 'other')),
  add column brew_day boolean not null default false,
  add column turn integer check (turn between 1 and 6);
