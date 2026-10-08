-- Schedules the alert check (supabase/functions/alerts) every 15 minutes in a Supabase project.
-- Run once per project (and again after restoring a backup into a new project), with the same
-- secret the function has as ALERTS_SECRET, and the project's address:
--   replace <ALERTS_SECRET> and <PROJECT_URL> below, then run it (e.g. supabase db query --linked).
-- The secret lives in the database's vault, not in this file.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select vault.create_secret('<ALERTS_SECRET>', 'alerts_secret', 'Shared with the alerts function (ALERTS_SECRET)')
 where not exists (select 1 from vault.secrets where name = 'alerts_secret');
select cron.unschedule('brewery-os-alerts') where exists (select 1 from cron.job where jobname = 'brewery-os-alerts');
select cron.schedule('brewery-os-alerts', '*/15 * * * *', $job$
  select net.http_post(
    url := '<PROJECT_URL>/functions/v1/alerts',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-alerts-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'alerts_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$job$);
