-- When an invite was last emailed (by the send-invite function), so the app can show it and
-- the function can refuse to send the same invite twice within a couple of minutes.
alter table public.invites add column emailed_at timestamptz;
