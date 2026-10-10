-- Run this after restoring a backup into a NEW Supabase project (see the backups repository).
--
-- Why: a new Supabase project automatically lets everyone, including signed-out visitors,
-- run any new database function. Our migrations take that away for the functions below,
-- but a backup only records "who may run it", not "remove the default", so loading a backup
-- into a new project quietly gives signed-out visitors access again. Each function also
-- checks for itself that the person is signed in, so this is a second lock, not the only one.
--
-- (report_error and menu_board_data are left open to signed-out visitors on purpose: the sign-in
-- screen can break too, and a menu board's TV and public page don't sign in.)
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
revoke execute on function public.revoke_api_key(uuid) from anon;
revoke execute on function public.check_alerts(uuid) from anon;
revoke execute on function public.acknowledge_alert(uuid) from anon;
revoke execute on function public.alert_conditions(uuid) from anon, authenticated;
revoke execute on function public.new_join_code() from anon;
revoke execute on function public.join_with_code(text) from anon;
revoke execute on function public.delete_brewery(uuid) from anon;
revoke execute on function public.load_into_brewery(uuid, jsonb) from anon;
revoke execute on function public.plan_needs(uuid) from anon;
revoke execute on function public.plan_shortfalls(uuid) from anon;
revoke execute on function public.gravity_due(uuid) from anon;
revoke execute on function public.create_calendar_feed(uuid, boolean) from anon;
revoke execute on function public.revoke_calendar_feed(uuid) from anon;
revoke execute on function public.calendar_feed(text) from anon, authenticated;
-- Menu boards (menu_board_data and menu_board_file stay open to signed-out visitors on purpose: TVs and
-- the public page use them)
revoke execute on function public.set_menu_board_link(uuid, text, boolean) from anon;
revoke execute on function public.set_menu_board_link_for(uuid, text, boolean) from anon;
revoke execute on function public.menu_board_preview(uuid, boolean) from anon;
revoke execute on function public.menu_board_preview_content(uuid, boolean) from anon;
revoke execute on function public.menu_board_json(uuid, boolean) from anon, authenticated;
revoke execute on function public.menu_board_content(uuid, boolean, boolean, boolean) from anon, authenticated;
revoke execute on function public.menu_board_settings(public.menu_boards) from anon, authenticated;
revoke execute on function public.menu_board_files(public.menu_boards) from anon, authenticated;
-- The demo (create_demo_brewery is for signed-in visitors; the rest run only inside the database)
revoke execute on function public.create_demo_brewery() from anon;
revoke execute on function public.cleanup_demos() from anon, authenticated;
revoke execute on function public.is_anonymous_user(uuid) from anon, authenticated;
-- API writes: listing a key's writes (the API only) and the keys' names (everyone in the brewery)
revoke execute on function public.log_api_action(text, text, text, jsonb, jsonb) from anon;
revoke execute on function public.api_key_names(uuid) from anon;
-- Suggest-only keys
revoke execute on function public.create_api_key(uuid, text, text[], text) from anon;
revoke execute on function public.log_api_suggestion(text, text, text, jsonb) from anon;
revoke execute on function public.approve_api_suggestion(uuid, jsonb) from anon;
revoke execute on function public.reject_api_suggestion(uuid) from anon;
-- The daily demo clean-up is a scheduled job (not in backups' tables): schedule it again
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('brewery-os-demo-cleanup', '23 9 * * *', $job$ select public.cleanup_demos(); $job$);

-- Alerts: the 15-minute check is a scheduled job in the database (not in backups' tables). In a new
-- project, set the alerts function's ALERTS_SECRET and run supabase/schedule-alerts.sql with it.
