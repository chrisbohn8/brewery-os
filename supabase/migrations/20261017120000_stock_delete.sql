-- Emptying a brewery (before loading a backup) removes its stock records too, like the rest of
-- its records; it needs the "delete records" permission. Day to day nothing is deleted: a mistake
-- is fixed with another move or a count.
create policy "remove stock" on public.stock_moves for delete to authenticated
  using (public.has_permission(brewery_id, 'delete_records'));
