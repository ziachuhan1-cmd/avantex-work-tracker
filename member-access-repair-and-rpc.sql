-- Avantex Flow member access repair + attendance RPC
-- Run once in Supabase SQL Editor.

alter table public.workspace_invites
add column if not exists role_label text default 'Team Member';

create or replace function public.accept_workspace_invite(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_row public.workspace_invites%rowtype;
  profile_name text;
  member_role_label text;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  select *
  into invite_row
  from public.workspace_invites
  where token = invite_token
  limit 1;

  if invite_row.id is null then
    raise exception 'Invite is invalid';
  end if;

  if invite_row.accepted_at is not null then
    raise exception 'Invite is already used';
  end if;

  if invite_row.expires_at <= now() then
    raise exception 'Invite is expired';
  end if;

  if lower(invite_row.email) <> lower(coalesce(auth.jwt()->>'email', '')) then
    raise exception 'Login with the invited email address';
  end if;

  if invite_row.role not in ('admin', 'editor') then
    raise exception 'Invite role is not supported';
  end if;

  insert into public.memberships (workspace_id, user_id, role, active)
  values (invite_row.workspace_id, auth.uid(), invite_row.role, true)
  on conflict (workspace_id, user_id) do update
  set role = excluded.role,
      active = true;

  if invite_row.role <> 'admin' then
    select coalesce(display_name, split_part(email, '@', 1))
    into profile_name
    from public.profiles
    where user_id = auth.uid();

    member_role_label := coalesce(nullif(invite_row.role_label, ''), 'Team Member');

    insert into public.editors (workspace_id, user_id, name, role, active)
    values (
      invite_row.workspace_id,
      auth.uid(),
      coalesce(profile_name, split_part(invite_row.email, '@', 1)),
      member_role_label,
      true
    )
    on conflict (workspace_id, user_id) where user_id is not null
    do update set
      role = excluded.role,
      active = true;
  end if;

  update public.workspace_invites
  set accepted_by = auth.uid(), accepted_at = now()
  where id = invite_row.id
    and accepted_at is null;

  return invite_row.workspace_id;
end;
$$;

create or replace function public.repair_workspace_member_links(target_workspace_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_row record;
  fixed_count integer := 0;
  profile_name text;
  role_label text;
  membership_active boolean;
begin
  if auth.uid() is null then
    raise exception 'Login required.';
  end if;

  for invite_row in
    select wi.*
    from public.workspace_invites wi
    where wi.accepted_by is not null
      and wi.accepted_at is not null
      and (target_workspace_id is null or wi.workspace_id = target_workspace_id)
      and public.has_workspace_role(wi.workspace_id, array['owner', 'admin'])
  loop
    select coalesce(m.active, true)
    into membership_active
    from public.memberships m
    where m.workspace_id = invite_row.workspace_id
      and m.user_id = invite_row.accepted_by
    limit 1;

    if membership_active is false then
      continue;
    end if;

    insert into public.memberships (workspace_id, user_id, role, active)
    values (invite_row.workspace_id, invite_row.accepted_by, invite_row.role, true)
    on conflict (workspace_id, user_id) do update
    set role = excluded.role
    where public.memberships.active = true;

    if invite_row.role <> 'admin' then
      select coalesce(p.display_name, split_part(p.email, '@', 1), split_part(invite_row.email, '@', 1))
      into profile_name
      from public.profiles p
      where p.user_id = invite_row.accepted_by;

      role_label := coalesce(nullif(invite_row.role_label, ''), 'Team Member');

      update public.editors e
      set user_id = invite_row.accepted_by,
          role = role_label,
          active = true
      where e.workspace_id = invite_row.workspace_id
        and e.user_id is null
        and e.active = true
        and lower(regexp_replace(e.name, '\s+', '', 'g')) = lower(regexp_replace(split_part(invite_row.email, '@', 1), '\s+', '', 'g'));

      insert into public.editors (workspace_id, user_id, name, role, active)
      values (
        invite_row.workspace_id,
        invite_row.accepted_by,
        coalesce(profile_name, split_part(invite_row.email, '@', 1)),
        role_label,
        true
      )
      on conflict (workspace_id, user_id) where user_id is not null
      do update set
        role = excluded.role,
        active = case when public.editors.active = false then false else true end;
    end if;

    fixed_count := fixed_count + 1;
  end loop;

  return fixed_count;
end;
$$;

grant execute on function public.repair_workspace_member_links(uuid) to authenticated;

create or replace function public.save_attendance_log_rpc(
  target_editor_id uuid,
  target_action text,
  target_happened_at timestamptz default now(),
  target_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  editor_row public.editors%rowtype;
  saved_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Login required.';
  end if;

  if target_action not in ('in', 'break_start', 'break_end', 'out') then
    raise exception 'Invalid attendance action.';
  end if;

  select *
  into editor_row
  from public.editors
  where id = target_editor_id;

  if editor_row.id is null then
    raise exception 'Team member not found.';
  end if;

  if coalesce(editor_row.active, true) = false then
    raise exception 'This member has been removed from the workspace.';
  end if;

  if not (
    public.has_workspace_role(editor_row.workspace_id, array['owner', 'admin'])
    or editor_row.user_id = auth.uid()
  ) then
    raise exception 'You can only update your own attendance.';
  end if;

  if not public.has_workspace_role(editor_row.workspace_id, array['owner', 'admin'])
    and not exists (
      select 1
      from public.memberships m
      where m.workspace_id = editor_row.workspace_id
        and m.user_id = auth.uid()
        and coalesce(m.active, true) = true
    ) then
    raise exception 'Workspace access is not active.';
  end if;

  insert into public.attendance_logs (
    workspace_id,
    editor_id,
    action,
    happened_at,
    note,
    created_by
  )
  values (
    editor_row.workspace_id,
    target_editor_id,
    target_action,
    coalesce(target_happened_at, now()),
    nullif(target_note, ''),
    auth.uid()
  )
  returning id into saved_id;

  return saved_id;
end;
$$;

grant execute on function public.save_attendance_log_rpc(
  uuid,
  text,
  timestamptz,
  text
) to authenticated;
