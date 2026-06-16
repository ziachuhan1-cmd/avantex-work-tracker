-- Avantex Work Tracker member removal and history permissions upgrade
-- Run once in Supabase SQL Editor.

create or replace function public.remove_workspace_member(member_editor_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  member_workspace uuid;
  member_user uuid;
  member_role text;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  select workspace_id, user_id
  into member_workspace, member_user
  from public.editors
  where id = member_editor_id;

  if member_workspace is null then
    raise exception 'Team member not found';
  end if;

  if not public.has_workspace_role(member_workspace, array['owner', 'admin']) then
    raise exception 'Only workspace admins can remove members';
  end if;

  if member_user = auth.uid() then
    raise exception 'You cannot remove yourself';
  end if;

  if member_user is not null then
    select role
    into member_role
    from public.memberships
    where workspace_id = member_workspace
      and user_id = member_user
    limit 1;

    if member_role = 'owner' then
      raise exception 'Workspace owner cannot be removed';
    end if;
  end if;

  update public.editors
  set active = false
  where id = member_editor_id;

  if member_user is not null then
    update public.memberships
    set active = false
    where workspace_id = member_workspace
      and user_id = member_user;
  end if;
end;
$$;

create or replace function public.cancel_workspace_invite(invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_workspace uuid;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  select workspace_id
  into invite_workspace
  from public.workspace_invites
  where id = invite_id;

  if invite_workspace is null then
    raise exception 'Invite not found';
  end if;

  if not public.has_workspace_role(invite_workspace, array['owner', 'admin']) then
    raise exception 'Only workspace admins can cancel invites';
  end if;

  delete from public.workspace_invites
  where id = invite_id
    and accepted_at is null;
end;
$$;

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

drop policy if exists "editors workspace select" on public.editors;
create policy "editors workspace select"
on public.editors for select
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or user_id = auth.uid()
);

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
