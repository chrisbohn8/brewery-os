-- Run this after restoring a backup into a NEW Supabase project (see the backups repository).
--
-- Why: a new Supabase project automatically lets everyone, including signed-out visitors,
-- run any new database function. Our migrations take that away for the functions below,
-- but a backup only records "who may run it", not "remove the default", so loading a backup
-- into a new project quietly gives signed-out visitors access again. Each function also
-- checks for itself that the person is signed in, so this is a second lock, not the only one.
--
-- Safe to run more than once. Afterwards, run the database tests against the restored
-- project:  supabase test db --db-url "<restored project's connection string>"

revoke execute on function public.create_brewery(text) from anon;
revoke execute on function public.accept_invites() from anon;
revoke execute on function public.brewery_members(uuid) from anon;
revoke execute on function public.my_permissions(uuid) from anon;
revoke execute on function public.save_batch(uuid, uuid, text, uuid, date, numeric, text, date, uuid, date) from anon;
