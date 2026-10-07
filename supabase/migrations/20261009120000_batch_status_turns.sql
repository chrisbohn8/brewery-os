-- The batch_status view lists every batch's columns ("b.*"), but Postgres fixes that list when the
-- view is created, so batches.turns (added later, in the brew log migration) was missing from it.
-- Recreate the view, unchanged otherwise, so it includes turns (and any column added before now).
-- The functions that read it (save_batch, log_cellar_entry) look it up by name, so they keep working.
drop view public.batch_status;

create view public.batch_status with (security_invoker = true) as
with ranked as (
  select e.*,
         row_number() over (partition by e.batch_id order by e.effective_date desc, e.recorded_at desc) as newest
  from public.batch_events e
),
latest as (
  select * from ranked where newest = 1
)
select
  b.*,
  l.stage,
  l.tank_id,
  -- When did the current stage start? The first event of the current run of that stage.
  -- (A transfer without a stage change doesn't reset the "days in stage" counter.)
  (
    select min(e.effective_date)
    from public.batch_events e
    where e.batch_id = b.id
      and e.stage = l.stage
      and e.effective_date >= coalesce(
        (select max(x.effective_date) from public.batch_events x
          where x.batch_id = b.id and x.stage <> l.stage),
        '-infinity'::date)
  ) as stage_started_on
from public.batches b
left join latest l on l.batch_id = b.id;

grant select on public.batch_status to authenticated;
