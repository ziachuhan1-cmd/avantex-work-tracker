-- Avantex Work Tracker workspace management upgrade
-- Run once in Supabase SQL Editor after the main schema.

alter table public.workspaces
add column if not exists active boolean not null default true;

alter table public.editors
add column if not exists removed_at timestamptz;

alter table public.memberships
add column if not exists removed_at timestamptz;

update public.workspaces set active = true where active is null;
update public.editors set active = true where active is null;
update public.memberships set active = true where active is null;

create or replace function public.update_workspace_name(target_workspace_id uuid, new_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  if not public.has_workspace_role(target_workspace_id, array['owner']) then
    raise exception 'Only the workspace owner can rename this workspace';
  end if;

  if length(trim(coalesce(new_name, ''))) < 2 then
    raise exception 'Workspace name is required';
  end if;

  update public.workspaces
  set name = trim(new_name)
  where id = target_workspace_id
    and active = true;
end;
$$;

create or replace function public.archive_workspace(target_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  if not public.has_workspace_role(target_workspace_id, array['owner']) then
    raise exception 'Only the workspace owner can delete this workspace';
  end if;

  update public.workspaces
  set active = false
  where id = target_workspace_id;

  update public.memberships
  set active = false,
      removed_at = coalesce(removed_at, now())
  where workspace_id = target_workspace_id;

  update public.editors
  set active = false,
      removed_at = coalesce(removed_at, now())
  where workspace_id = target_workspace_id;

  update public.workspace_invites
  set expires_at = least(coalesce(expires_at, now()), now())
  where workspace_id = target_workspace_id
    and accepted_at is null;
end;
$$;

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
  set active = false,
      removed_at = coalesce(removed_at, now())
  where id = member_editor_id;

  if member_user is not null then
    update public.memberships
    set active = false,
        removed_at = coalesce(removed_at, now())
    where workspace_id = member_workspace
      and user_id = member_user;
  end if;
end;
$$;

drop policy if exists "workspaces select members" on public.workspaces;
create policy "workspaces select members"
on public.workspaces for select
to authenticated
using (
  active = true
  and exists (
    select 1
    from public.memberships m
    where m.workspace_id = workspaces.id
      and m.user_id = auth.uid()
  )
);

drop policy if exists "workspaces owner update" on public.workspaces;
create policy "workspaces owner update"
on public.workspaces for update
to authenticated
using (public.has_workspace_role(id, array['owner']))
with check (public.has_workspace_role(id, array['owner']));

drop policy if exists "memberships admins update" on public.memberships;
create policy "memberships admins update"
on public.memberships for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));
