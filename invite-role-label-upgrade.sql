-- Avantex Work Tracker invite role-label upgrade
-- Run once in Supabase SQL Editor after the multi-workspace migration.

alter table public.workspace_invites
add column if not exists role_label text;

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

  if invite_row.accepted_at is null and invite_row.expires_at <= now() then
    raise exception 'Invite is expired';
  end if;

  if lower(invite_row.email) <> lower(coalesce(auth.jwt()->>'email', '')) then
    raise exception 'Login with the invited email address';
  end if;

  if invite_row.role not in ('admin', 'editor') then
    raise exception 'Invite role is not supported';
  end if;

  insert into public.memberships (workspace_id, user_id, role)
  values (invite_row.workspace_id, auth.uid(), invite_row.role)
  on conflict (workspace_id, user_id) do update set role = excluded.role, active = true;

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
    on conflict do nothing;

    update public.editors
    set role = member_role_label, active = true
    where workspace_id = invite_row.workspace_id
      and user_id = auth.uid();
  end if;

  update public.workspace_invites
  set accepted_by = auth.uid(), accepted_at = now()
  where id = invite_row.id
    and accepted_at is null;

  return invite_row.workspace_id;
end;
$$;
