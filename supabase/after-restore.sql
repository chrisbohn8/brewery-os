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
revoke execute on function public.save_batch(uuid, uuid, text, uuid, date, numeric, text, date, uuid, date, numeric) from anon;
revoke execute on function public.log_cellar_entry(uuid, uuid, uuid, date, text, numeric, numeric, numeric, text, text, text) from anon;
revoke execute on function public.record_packaging(uuid, uuid, uuid, uuid, date, jsonb, boolean, text, uuid) from anon;
revoke execute on function public.add_usual_package_types(uuid) from anon, authenticated;
revoke execute on function public.record_level_check(uuid, uuid, uuid, uuid, date, numeric, text, text) from anon;
revoke execute on function public.make_batch_from(uuid, uuid, text, uuid, uuid, text, date, jsonb, text) from anon;
revoke execute on function public.record_stock(uuid, uuid, date, uuid, uuid, text, jsonb, text, text) from anon;
revoke execute on function public.record_count(uuid, uuid, uuid, date, jsonb, text, text) from anon;
revoke execute on function public.default_stock_place(uuid, uuid) from anon, authenticated;
revoke execute on function public.take_stock(uuid, uuid, date, text, text, uuid, uuid, uuid, numeric, uuid, uuid, text, text) from anon, authenticated;
revoke execute on function public.set_place_order(uuid, text, uuid[]) from anon;
revoke execute on function public.create_api_key(uuid, text, text[]) from anon;
revoke execute on function public.revoke_api_key(uuid) from anon;
