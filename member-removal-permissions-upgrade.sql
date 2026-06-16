-- Avantex Work Tracker member removal and history permissions upgrade
-- Run once in Supabase SQL Editor.

drop policy if exists "workspaces select members" on public.workspaces;
create policy "workspaces select members"
on public.workspaces for select
to authenticated
using (
  exists (
    select 1
    from public.memberships m
    where m.workspace_id = workspaces.id
      and m.user_id = auth.uid()
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
