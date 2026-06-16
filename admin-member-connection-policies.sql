-- Avantex Work Tracker admin/member connection policies
-- Run once in Supabase SQL Editor if admin cannot see member attendance/work updates.

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.active = true
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.active = true
      and m.role = any(allowed_roles)
  );
$$;

drop policy if exists "editors workspace select" on public.editors;
create policy "editors workspace select"
on public.editors for select
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']) or user_id = auth.uid());

drop policy if exists "attendance workspace select" on public.attendance_logs;
create policy "attendance workspace select"
on public.attendance_logs for select
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = attendance_logs.editor_id
      and e.workspace_id = attendance_logs.workspace_id
      and e.user_id = auth.uid()
      and e.active = true
  )
);

drop policy if exists "attendance workspace insert" on public.attendance_logs;
create policy "attendance workspace insert"
on public.attendance_logs for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    or exists (
      select 1 from public.editors e
      where e.id = attendance_logs.editor_id
        and e.workspace_id = attendance_logs.workspace_id
        and e.user_id = auth.uid()
        and e.active = true
    )
  )
);

drop policy if exists "daily work workspace select" on public.daily_work;
create policy "daily work workspace select"
on public.daily_work for select
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id
      and e.workspace_id = daily_work.workspace_id
      and e.user_id = auth.uid()
      and e.active = true
  )
);

drop policy if exists "daily work workspace insert" on public.daily_work;
create policy "daily work workspace insert"
on public.daily_work for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    or exists (
      select 1 from public.editors e
      where e.id = daily_work.editor_id
        and e.workspace_id = daily_work.workspace_id
        and e.user_id = auth.uid()
        and e.active = true
    )
  )
);

drop policy if exists "daily work workspace update" on public.daily_work;
create policy "daily work workspace update"
on public.daily_work for update
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id
      and e.workspace_id = daily_work.workspace_id
      and e.user_id = auth.uid()
      and e.active = true
  )
)
with check (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id
      and e.workspace_id = daily_work.workspace_id
      and e.user_id = auth.uid()
      and e.active = true
  )
);
