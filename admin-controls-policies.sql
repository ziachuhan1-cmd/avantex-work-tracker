-- Avantex Work Tracker admin edit/delete policies
-- Run this once after supabase-schema.sql.

drop policy if exists "attendance admin update" on public.attendance_logs;
create policy "attendance admin update"
on public.attendance_logs for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "attendance admin delete" on public.attendance_logs;
create policy "attendance admin delete"
on public.attendance_logs for delete
to authenticated
using (public.is_admin());

drop policy if exists "daily work admin delete" on public.daily_work;
create policy "daily work admin delete"
on public.daily_work for delete
to authenticated
using (public.is_admin());
